import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidSegment, parseSegment, scoreFromCoords, type Segment } from '@shared/board';
import {
  computeMatch,
  undoEvents,
  validateSettings,
  type MatchEvent,
  type MatchSettings,
  type MatchState,
  type PlayerInfo,
} from '@shared/match';
import type { DetectedDart, MatchStatus, MatchSummary, ServerToClient } from '@shared/protocol';
import { boardEvents, canAccessBoard, publishBoardStatus, sendToBoard, setActiveMatchLookup } from './boards';
import { pool, query } from './db';
import { HttpError, authenticate, parse, userId } from './http';
import { publishMatch } from './hub';

interface MatchRow {
  id: string;
  owner_id: string;
  board_id: string | null;
  settings: MatchSettings;
  players: PlayerInfo[];
  events: MatchEvent[];
  status: MatchStatus;
  winner: number | null;
  created_at: Date;
  finished_at: Date | null;
}

interface LiveMatch {
  row: MatchRow;
  state: MatchState;
  lock: Promise<unknown>;
}

const cache = new Map<string, LiveMatch>();
const activeByBoard = new Map<string, string>();

setActiveMatchLookup((boardId) => activeByBoard.get(boardId) ?? null);

function toSummary(row: MatchRow): MatchSummary {
  return {
    id: row.id,
    settings: row.settings,
    players: row.players,
    boardId: row.board_id,
    status: row.status,
    winner: row.winner,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

async function load(id: string): Promise<LiveMatch | null> {
  const cached = cache.get(id);
  if (cached) return cached;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await query<MatchRow>('SELECT * FROM matches WHERE id = $1', [id]);
  if (!row) return null;
  const m: LiveMatch = { row, state: computeMatch(row.settings, row.players, row.events), lock: Promise.resolve() };
  cache.set(id, m);
  // keep the cache small: forget finished matches nobody needs
  if (cache.size > 500) {
    for (const [key, value] of cache) {
      if (value.row.status !== 'running' && key !== id) cache.delete(key);
      if (cache.size <= 400) break;
    }
  }
  return m;
}

export async function canAccessMatch(id: string, user: string): Promise<boolean> {
  const m = await load(id);
  if (!m) return false;
  return m.row.owner_id === user || m.row.players.some((p) => p.userId === user);
}

async function loadOwned(id: string, user: string): Promise<LiveMatch> {
  const m = await load(id);
  if (!m || !(await canAccessMatch(id, user))) throw new HttpError(404, 'Spiel nicht gefunden');
  return m;
}

function stateMessage(m: LiveMatch): ServerToClient {
  return { type: 'match_state', matchId: m.row.id, status: m.row.status, boardId: m.row.board_id, state: m.state };
}

function publish(m: LiveMatch) {
  publishMatch(m.row.id, stateMessage(m));
}

export async function matchSnapshot(id: string): Promise<ServerToClient | null> {
  const m = await load(id);
  return m ? stateMessage(m) : null;
}

/**
 * Serialised mutation of a match: fn gets the current events and returns the new list
 * (or null for "no change"). State is recomputed, persisted and broadcast.
 */
function mutate(m: LiveMatch, fn: (events: MatchEvent[], state: MatchState) => MatchEvent[] | null): Promise<MatchState> {
  const run = async (): Promise<MatchState> => {
    if (m.row.status === 'aborted') throw new HttpError(409, 'Spiel wurde abgebrochen');
    let events = fn(m.row.events, m.state);
    if (!events) return m.state;
    let state = computeMatch(m.row.settings, m.row.players, events);
    // Without a board there is no takeout: advance automatically after a complete turn.
    if (!m.row.board_id && state.awaitingNext && !state.finished) {
      events = [...events, { t: 'next', at: Date.now() }];
      state = computeMatch(m.row.settings, m.row.players, events);
    }
    const status: MatchStatus = state.finished ? 'finished' : 'running';
    const finishedAt = state.finished ? (m.row.finished_at ?? new Date()) : null;
    await query('UPDATE matches SET events = $2, status = $3, winner = $4, finished_at = $5 WHERE id = $1', [
      m.row.id,
      JSON.stringify(events),
      status,
      state.winner,
      finishedAt,
    ]);
    m.row = { ...m.row, events, status, winner: state.winner, finished_at: finishedAt };
    m.state = state;
    publish(m);
    return state;
  };
  const p = m.lock.then(run, run);
  m.lock = p.catch(() => undefined);
  return p;
}

function dartEvent(seg: Segment, src: 'board' | 'manual', x?: number, y?: number): MatchEvent {
  return { t: 'dart', seg, src, at: Date.now(), ...(x !== undefined && y !== undefined ? { x, y } : {}) };
}

// ------------------------------------------------------------------ board integration

boardEvents.on('dart', async (boardId: string, dart: DetectedDart) => {
  const matchId = activeByBoard.get(boardId);
  if (!matchId) return;
  const m = await load(matchId);
  if (!m || m.row.status !== 'running') return;
  const seg = Number.isFinite(dart.x) && Number.isFinite(dart.y) ? scoreFromCoords(dart.x, dart.y) : dart.seg;
  await mutate(m, (events, state) =>
    state.awaitingNext || state.finished ? null : [...events, dartEvent(seg, 'board', dart.x, dart.y)],
  ).catch(() => undefined);
});

boardEvents.on('takeout_finished', async (boardId: string) => {
  const matchId = activeByBoard.get(boardId);
  if (!matchId) return;
  const m = await load(matchId);
  if (!m || m.row.status !== 'running') return;
  await mutate(m, (events, state) =>
    !state.finished && (state.awaitingNext || state.turn.darts.length > 0)
      ? [...events, { t: 'next', at: Date.now() }]
      : null,
  ).catch(() => undefined);
});

export async function restoreActiveMatches(): Promise<void> {
  const rows = await query<{ id: string; board_id: string }>(
    `SELECT DISTINCT ON (board_id) id, board_id FROM matches
     WHERE board_id IS NOT NULL AND status = 'running' ORDER BY board_id, created_at DESC`,
  );
  for (const r of rows) activeByBoard.set(r.board_id, r.id);
}

// ------------------------------------------------------------------ routes

const segmentSchema = z.union([
  z.string().transform((s, ctx) => {
    try {
      return parseSegment(s);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Ungültiges Segment' });
      return z.NEVER;
    }
  }),
  z
    .object({ number: z.number().int(), multiplier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) })
    .refine(isValidSegment, 'Ungültiges Segment'),
]);

const settingsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('x01'),
    startScore: z.number().int(),
    inMode: z.enum(['straight', 'double', 'master']),
    outMode: z.enum(['straight', 'double', 'master']),
    legs: z.number().int(),
  }),
  z.object({
    mode: z.literal('cricket'),
    variant: z.enum(['standard', 'cutthroat']),
    legs: z.number().int(),
    maxRounds: z.number().int(),
  }),
]);

const createSchema = z.object({
  settings: settingsSchema,
  players: z
    .array(z.object({ name: z.string().trim().min(1).max(30), self: z.boolean().optional() }))
    .min(1)
    .max(8),
  boardId: z.string().nullish(),
});

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.post('/api/matches', async (req) => {
    const user = userId(req);
    const body = parse(createSchema, req.body);
    const err = validateSettings(body.settings, body.players.length);
    if (err) throw new HttpError(400, err);
    if (body.boardId && !(await canAccessBoard(body.boardId, user))) throw new HttpError(404, 'Board nicht gefunden');
    if (body.players.filter((p) => p.self).length > 1) throw new HttpError(400, 'Nur ein Spieler kann „ich“ sein');

    const players: PlayerInfo[] = body.players.map((p, i) => ({
      id: `p${i + 1}`,
      name: p.name,
      userId: p.self ? user : null,
    }));

    const client = await pool.connect();
    let row: MatchRow;
    try {
      await client.query('BEGIN');
      if (body.boardId) {
        await client.query(
          `UPDATE matches SET status = 'aborted', finished_at = now() WHERE board_id = $1 AND status = 'running'`,
          [body.boardId],
        );
      }
      const res = await client.query<MatchRow>(
        'INSERT INTO matches(owner_id, board_id, settings, players) VALUES ($1, $2, $3, $4) RETURNING *',
        [user, body.boardId ?? null, JSON.stringify(body.settings), JSON.stringify(players)],
      );
      row = res.rows[0];
      for (const [i, p] of players.entries()) {
        if (p.userId) {
          await client.query('INSERT INTO match_players(match_id, player_index, user_id) VALUES ($1, $2, $3)', [row.id, i, p.userId]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    if (body.boardId) {
      const previous = activeByBoard.get(body.boardId);
      if (previous) {
        const old = cache.get(previous);
        if (old && old.row.status === 'running') {
          old.row = { ...old.row, status: 'aborted' };
          publish(old);
        }
      }
      activeByBoard.set(body.boardId, row.id);
      sendToBoard(body.boardId, { type: 'command', action: 'reset' });
      await publishBoardStatus(body.boardId);
    }
    const m = await load(row.id);
    return { match: toSummary(m!.row), state: m!.state };
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/matches', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const status = req.query.status;
    const rows = await query<MatchRow>(
      `SELECT m.* FROM matches m
       WHERE (m.owner_id = $1 OR EXISTS (SELECT 1 FROM match_players mp WHERE mp.match_id = m.id AND mp.user_id = $1))
         AND ($2::text IS NULL OR m.status = $2)
       ORDER BY m.created_at DESC LIMIT $3`,
      [userId(req), status ?? null, limit],
    );
    return rows.map(toSummary);
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req) => {
    const m = await loadOwned(req.params.id, userId(req));
    return { match: toSummary(m.row), state: m.state };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/darts', async (req) => {
    const m = await loadOwned(req.params.id, userId(req));
    const body = parse(z.object({ segment: segmentSchema }), req.body);
    const state = await mutate(m, (events, st) => {
      if (st.finished) throw new HttpError(409, 'Spiel ist beendet');
      if (st.awaitingNext) throw new HttpError(409, 'Aufnahme beendet – erst „Weiter“');
      return [...events, dartEvent(body.segment, 'manual')];
    });
    return { state };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/next', async (req) => {
    const m = await loadOwned(req.params.id, userId(req));
    const state = await mutate(m, (events, st) => (st.finished ? null : [...events, { t: 'next', at: Date.now() }]));
    return { state };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/undo', async (req) => {
    const m = await loadOwned(req.params.id, userId(req));
    const state = await mutate(m, (events) => (events.length === 0 ? null : undoEvents(events)));
    return { state };
  });

  app.put<{ Params: { id: string; index: string } }>('/api/matches/:id/events/:index', async (req) => {
    const m = await loadOwned(req.params.id, userId(req));
    const body = parse(z.object({ segment: segmentSchema }), req.body);
    const index = Number(req.params.index);
    const state = await mutate(m, (events) => {
      const ev = events[index];
      if (!ev || ev.t !== 'dart') throw new HttpError(404, 'Wurf nicht gefunden');
      const copy = events.slice();
      // the detected position was wrong -> drop it, the client draws the segment centre instead
      copy[index] = { t: 'dart', seg: body.segment, src: 'manual', at: ev.at };
      return copy;
    });
    return { state };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/abort', async (req) => {
    const m = await loadOwned(req.params.id, userId(req));
    if (m.row.owner_id !== userId(req)) throw new HttpError(403, 'Nur der Ersteller kann das Spiel abbrechen');
    await query(`UPDATE matches SET status = 'aborted', finished_at = now() WHERE id = $1 AND status = 'running'`, [m.row.id]);
    if (m.row.status === 'running') m.row = { ...m.row, status: 'aborted', finished_at: new Date() };
    if (m.row.board_id && activeByBoard.get(m.row.board_id) === m.row.id) {
      activeByBoard.delete(m.row.board_id);
      await publishBoardStatus(m.row.board_id);
    }
    publish(m);
    return { ok: true };
  });
}

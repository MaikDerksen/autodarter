import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidSegment, parseSegment, scoreFromCoords, type Segment } from '@shared/board';
import {
  computeMatch,
  describeSettings,
  undoEvents,
  validateSettings,
  type MatchEvent,
  type MatchSettings,
  type MatchState,
  type PlayerInfo,
} from '@shared/match';
import type { BoardActiveMatch, DetectedDart, MatchStatus, MatchSummary, ServerToClient } from '@shared/protocol';
import type { MatchVoice } from '@shared/voice';
import { boardEvents, canAccessBoard, publishBoardStatus, sendToBoard, setActiveMatchLookup } from './boards';
import { config } from './config';
import { pool, query } from './db';
import { areFriends } from './friends';
import { HttpError, authenticate, parse, userId } from './http';
import { publishMatch, sendToUser } from './hub';
import { activePackOf, matchVoice } from './voice';

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
  voice_pack_id: string | null;
}

interface LiveMatch {
  row: MatchRow;
  state: MatchState;
  lock: Promise<unknown>;
  ownerName: string;
  voice: MatchVoice | null;
}

const cache = new Map<string, LiveMatch>();
/** The running match per board – a board can only host one match at a time (remote matches use several boards). */
const activeByBoard = new Map<string, string>();

/** Board a player throws at: their own one in a remote match, otherwise the board of the match. */
function playerBoard(row: MatchRow, player: number): string | null {
  return row.players[player]?.boardId ?? row.board_id;
}

/** All boards a match uses. */
function matchBoards(row: MatchRow): string[] {
  const ids = [row.board_id, ...row.players.map((p) => p.boardId ?? null)].filter((b): b is string => !!b);
  return [...new Set(ids)];
}

/** A player of a running match may watch the boards of that match (remote play), even without board access. */
export function guestCanWatchBoard(boardId: string, user: string): boolean {
  const id = activeByBoard.get(boardId);
  const m = id ? cache.get(id) : undefined;
  return !!m && m.row.status === 'running' && canControl(m, user);
}

/** Time of the last dart / turn change (or the start of the match). */
function lastActivity(m: LiveMatch): number {
  const ev = m.row.events[m.row.events.length - 1];
  return ev?.at ?? m.row.created_at.getTime();
}

function activeInfo(m: LiveMatch): BoardActiveMatch {
  return {
    id: m.row.id,
    ownerId: m.row.owner_id,
    ownerName: m.ownerName,
    title: describeSettings(m.row.settings),
    players: m.row.players.map((p) => p.name),
    lastActivity: new Date(lastActivity(m)).toISOString(),
  };
}

function activeMatchOn(boardId: string): LiveMatch | null {
  const id = activeByBoard.get(boardId);
  const m = id ? cache.get(id) : undefined;
  return m && m.row.status === 'running' ? m : null;
}

setActiveMatchLookup((boardId) => {
  const m = activeMatchOn(boardId);
  return m ? activeInfo(m) : null;
});

/** Somebody is playing right now (used by the auto-updater to postpone updates). */
export function serverBusy(): boolean {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const m of cache.values()) if (m.row.status === 'running' && lastActivity(m) > cutoff) return true;
  return false;
}

function toSummary(row: MatchRow, voice: MatchVoice | null = null): MatchSummary {
  return {
    id: row.id,
    settings: row.settings,
    players: row.players,
    boardId: row.board_id,
    status: row.status,
    winner: row.winner,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    voice,
  };
}

async function load(id: string): Promise<LiveMatch | null> {
  const cached = cache.get(id);
  if (cached) return cached;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await query<MatchRow>('SELECT * FROM matches WHERE id = $1', [id]);
  if (!row) return null;
  const [owner] = await query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [row.owner_id]);
  const m: LiveMatch = {
    row,
    state: computeMatch(row.settings, row.players, row.events),
    lock: Promise.resolve(),
    ownerName: owner?.display_name ?? '?',
    voice: await matchVoice(row.voice_pack_id ?? null).catch(() => null),
  };
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

/** Creator and players with an account may enter darts, undo etc. */
function canControl(m: LiveMatch, user: string): boolean {
  return m.row.owner_id === user || m.row.players.some((p) => p.userId === user);
}

/** Players and everybody who has the match's board in their account may watch. */
export async function canViewMatch(id: string, user: string): Promise<boolean> {
  const m = await load(id);
  if (!m) return false;
  if (canControl(m, user)) return true;
  return !!(m.row.board_id && (await canAccessBoard(m.row.board_id, user)));
}

async function loadViewable(id: string, user: string): Promise<LiveMatch> {
  const m = await load(id);
  if (!m || !(await canViewMatch(id, user))) throw new HttpError(404, 'Spiel nicht gefunden');
  return m;
}

async function loadControllable(id: string, user: string): Promise<LiveMatch> {
  const m = await loadViewable(id, user);
  if (!canControl(m, user)) throw new HttpError(403, 'Du schaust nur zu – eingeben können nur die Mitspieler');
  return m;
}

/**
 * Keep activeByBoard in line with the match status and its boards (finish, undo of the finishing dart,
 * abort, a player switching to their own board). Returns the boards whose status changed.
 */
function syncActive(m: LiveMatch): string[] {
  const changed: string[] = [];
  const boards = m.row.status === 'running' ? matchBoards(m.row) : [];
  for (const [b, id] of activeByBoard) {
    if (id === m.row.id && !boards.includes(b)) {
      activeByBoard.delete(b);
      changed.push(b);
    }
  }
  for (const b of boards) {
    if (!activeByBoard.has(b)) {
      activeByBoard.set(b, m.row.id);
      changed.push(b);
    }
  }
  return changed;
}

async function publishBoards(ids: string[]): Promise<void> {
  for (const b of ids) await publishBoardStatus(b).catch(() => undefined);
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
    if (!playerBoard(m.row, state.turn.player) && state.awaitingNext && !state.finished) {
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
    await publishBoards(syncActive(m));
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
    // remote play: only the board of the player whose turn it is counts
    state.awaitingNext || state.finished || playerBoard(m.row, state.currentPlayer) !== boardId
      ? null
      : [...events, dartEvent(seg, 'board', dart.x, dart.y)],
  ).catch(() => undefined);
});

boardEvents.on('takeout_finished', async (boardId: string) => {
  const matchId = activeByBoard.get(boardId);
  if (!matchId) return;
  const m = await load(matchId);
  if (!m || m.row.status !== 'running') return;
  await mutate(m, (events, state) =>
    !state.finished && (state.awaitingNext || state.turn.darts.length > 0) && playerBoard(m.row, state.turn.player) === boardId
      ? [...events, { t: 'next', at: Date.now() }]
      : null,
  ).catch(() => undefined);
});

export async function restoreActiveMatches(): Promise<void> {
  const rows = await query<{ id: string }>(`SELECT id FROM matches WHERE status = 'running' ORDER BY created_at ASC`);
  for (const r of rows) {
    const m = await load(r.id);
    // newer matches win if two running matches claim the same board
    if (m) for (const b of matchBoards(m.row)) activeByBoard.set(b, m.row.id);
  }
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
  z.object({
    mode: z.literal('atc'),
    hits: z.enum(['any', 'double', 'triple']),
    skip: z.boolean(),
    bull: z.boolean(),
    legs: z.number().int(),
  }),
]);

const createSchema = z.object({
  settings: settingsSchema,
  players: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(30).optional(),
          /** the requesting user */
          self: z.boolean().optional(),
          /** a friend with an account (counts for their statistics) */
          userId: z.string().uuid().optional(),
        })
        .refine((p) => p.self || p.userId || p.name, 'Spielername fehlt'),
    )
    .min(1)
    .max(8),
  boardId: z.string().nullish(),
  /** abort my own running match on the board */
  force: z.boolean().optional(),
});

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.post('/api/matches', async (req) => {
    const user = userId(req);
    const body = parse(createSchema, req.body);
    const err = validateSettings(body.settings, body.players.length);
    if (err) throw new HttpError(400, err);

    // players: guests by name, me and friends by account
    const accountIds = body.players.map((p) => (p.self ? user : (p.userId ?? null)));
    const ids = accountIds.filter((x): x is string => !!x);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Ein Spieler ist doppelt eingetragen');
    for (const id of ids) {
      if (id !== user && !(await areFriends(user, id))) throw new HttpError(403, 'Spieler mit Konto müssen mit dir befreundet sein');
    }
    const names = new Map(
      (await query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [ids])).map(
        (u) => [u.id, u.display_name],
      ),
    );
    const players: PlayerInfo[] = body.players.map((p, i) => {
      const uid = accountIds[i];
      if (uid && !names.has(uid)) throw new HttpError(404, 'Spieler nicht gefunden');
      return { id: `p${i + 1}`, name: uid ? names.get(uid)! : p.name!, userId: uid };
    });

    // a board hosts one match at a time
    if (body.boardId) {
      if (!(await canAccessBoard(body.boardId, user))) throw new HttpError(404, 'Board nicht gefunden');
      const active = activeMatchOn(body.boardId);
      if (active) {
        const idle = Date.now() - lastActivity(active) > config.boardIdleMinutes * 60 * 1000;
        const mine = canControl(active, user);
        if (!idle && !(mine && body.force)) {
          const info = activeInfo(active);
          throw new HttpError(
            409,
            mine
              ? `Auf dem Board läuft noch dein Spiel (${info.title}).`
              : `Das Board ist belegt: ${info.ownerName} spielt gerade ${info.title} (${info.players.join(' vs. ')}).`,
            { code: 'board_busy', activeMatch: info, canForce: mine },
          );
        }
      }
    }

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
        'INSERT INTO matches(owner_id, board_id, settings, players, voice_pack_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [user, body.boardId ?? null, JSON.stringify(body.settings), JSON.stringify(players), await activePackOf(user)],
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
      const old = activeMatchOn(body.boardId);
      if (old) {
        old.row = { ...old.row, status: 'aborted', finished_at: new Date() };
        syncActive(old);
        publish(old);
      }
      activeByBoard.set(body.boardId, row.id);
    }
    const m = (await load(row.id))!;
    if (body.boardId) {
      sendToBoard(body.boardId, { type: 'command', action: 'reset' });
      await publishBoardStatus(body.boardId);
    }
    const summary = toSummary(m.row, m.voice);
    for (const p of players) {
      if (p.userId && p.userId !== user) {
        sendToUser(p.userId, { type: 'match_invite', match: summary, from: { id: user, displayName: m.ownerName } });
      }
    }
    return { match: summary, state: m.state, canControl: true };
  });

  /**
   * Remote play: a player with an account throws at their own board (e.g. at home) instead of the
   * board of the match. boardId null = back to the board of the match.
   */
  app.put<{ Params: { id: string; index: string } }>('/api/matches/:id/players/:index/board', async (req) => {
    const user = userId(req);
    const m = await loadControllable(req.params.id, user);
    const index = Number(req.params.index);
    const player = m.row.players[index];
    if (!player) throw new HttpError(404, 'Spieler nicht gefunden');
    if (player.userId !== user) throw new HttpError(403, 'Sein Board wählt jeder Spieler selbst');
    if (m.row.status !== 'running') throw new HttpError(409, 'Spiel ist beendet');
    const body = parse(z.object({ boardId: z.string().min(1).max(64).nullable() }), req.body);
    let boardId = body.boardId === m.row.board_id ? null : body.boardId;
    let boardName: string | null = null;
    if (boardId) {
      if (!(await canAccessBoard(boardId, user))) throw new HttpError(404, 'Board nicht gefunden');
      const other = activeMatchOn(boardId);
      if (other && other.row.id !== m.row.id) {
        throw new HttpError(409, `Auf diesem Board läuft gerade ein anderes Spiel (${activeInfo(other).title}).`);
      }
      const [b] = await query<{ name: string }>('SELECT name FROM boards WHERE id = $1', [boardId]);
      boardName = b?.name ?? null;
    } else boardId = null;
    const players = m.row.players.map((p, i) => (i === index ? { ...p, boardId, boardName } : p));
    await query('UPDATE matches SET players = $2 WHERE id = $1', [m.row.id, JSON.stringify(players)]);
    m.row = { ...m.row, players };
    m.state = computeMatch(m.row.settings, m.row.players, m.row.events);
    publish(m);
    await publishBoards(syncActive(m));
    if (boardId) sendToBoard(boardId, { type: 'command', action: 'reset' });
    req.log.info({ match: m.row.id, player: index, board: boardId }, 'player board changed');
    return { match: toSummary(m.row, m.voice), state: m.state };
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
    return rows.map((r) => toSummary(r));
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req) => {
    const m = await loadViewable(req.params.id, userId(req));
    return { match: toSummary(m.row, m.voice), state: m.state, canControl: canControl(m, userId(req)) };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/darts', async (req) => {
    const m = await loadControllable(req.params.id, userId(req));
    const body = parse(z.object({ segment: segmentSchema }), req.body);
    const state = await mutate(m, (events, st) => {
      if (st.finished) throw new HttpError(409, 'Spiel ist beendet');
      if (st.awaitingNext) throw new HttpError(409, 'Aufnahme beendet – erst „Weiter“');
      return [...events, dartEvent(body.segment, 'manual')];
    });
    return { state };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/next', async (req) => {
    const m = await loadControllable(req.params.id, userId(req));
    const state = await mutate(m, (events, st) => (st.finished ? null : [...events, { t: 'next', at: Date.now() }]));
    return { state };
  });

  app.post<{ Params: { id: string } }>('/api/matches/:id/undo', async (req) => {
    const m = await loadControllable(req.params.id, userId(req));
    const state = await mutate(m, (events) => (events.length === 0 ? null : undoEvents(events)));
    return { state };
  });

  app.put<{ Params: { id: string; index: string } }>('/api/matches/:id/events/:index', async (req) => {
    const m = await loadControllable(req.params.id, userId(req));
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

  /**
   * End a match. Allowed for the players and – as emergency exit for forgotten matches that block
   * the board – for everybody who has the board in their account.
   */
  app.post<{ Params: { id: string } }>('/api/matches/:id/abort', async (req) => {
    const user = userId(req);
    const m = await loadViewable(req.params.id, user);
    req.log.info({ match: m.row.id, user }, 'match aborted');
    await abortMatch(m);
    return { ok: true };
  });
}

async function abortMatch(m: LiveMatch): Promise<void> {
  await query(`UPDATE matches SET status = 'aborted', finished_at = now() WHERE id = $1 AND status = 'running'`, [m.row.id]);
  if (m.row.status === 'running') m.row = { ...m.row, status: 'aborted', finished_at: new Date() };
  await publishBoards(syncActive(m));
  publish(m);
}

/** Matches nobody threw a dart in for STALE_MATCH_HOURS are ended automatically (no "match corpses"). */
export async function cleanupStaleMatches(): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM matches WHERE status = 'running'
       AND COALESCE(to_timestamp((events->-1->>'at')::double precision / 1000), created_at) < now() - make_interval(hours => $1)`,
    [config.staleMatchHours],
  );
  for (const r of rows) {
    const m = await load(r.id);
    if (m) await abortMatch(m);
  }
  return rows.length;
}

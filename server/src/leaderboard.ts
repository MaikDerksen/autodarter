import type { FastifyInstance } from 'fastify';
import {
  computeMatch,
  mergeStats,
  type GameMode,
  type MatchEvent,
  type MatchSettings,
  type PlayerInfo,
  type PlayerStats,
} from '@shared/match';
import { RATING_POOLS, buildLeaderboard, poolMetric, rateMatches, type LeaderboardResponse, type RatedMatch } from '@shared/rating';
import { query } from './db';
import { authenticate } from './http';

/**
 * Leaderboard of everybody with an account (see shared/src/rating.ts for how the rating works).
 * Only finished matches count – aborted ones (misclick, forgotten player, no time) never.
 */

interface Summary extends RatedMatch {
  /** per seat: statistics of the match (for the average / MPR / hit rate column) */
  stats: PlayerStats[];
}

const MODES: GameMode[] = ['x01', 'cricket', 'atc'];
const CHUNK = 200;

/** match id -> finish time (ms) + summary; a match that was finished again (undo) is re-read */
const cache = new Map<string, { at: number; summary: Summary | null }>();

function summarize(row: { id: string; settings: MatchSettings; players: PlayerInfo[]; events: MatchEvent[]; winner: number | null }, at: number, seats: Map<number, string>): Summary | null {
  const mode = row.settings?.mode;
  if (!MODES.includes(mode)) return null;
  let state: ReturnType<typeof computeMatch>;
  try {
    state = computeMatch(row.settings, row.players, row.events ?? []);
  } catch {
    return null; // broken legacy data
  }
  const winner = row.winner ?? state.winner;
  if (winner === null || winner === undefined || !state.finished) return null;
  return {
    id: row.id,
    mode,
    at,
    winner,
    players: row.players.map((_, i) => ({ userId: seats.get(i) ?? null, legs: state.legsWon[i] ?? 0 })),
    stats: row.players.map((_, i) => state.stats[i]),
  };
}

async function finishedMatches(): Promise<Summary[]> {
  const list = await query<{ id: string; at: Date }>(`SELECT id, COALESCE(finished_at, created_at) AS at FROM matches WHERE status = 'finished'`);
  const current = new Map(list.map((r) => [r.id, new Date(r.at).getTime()]));
  for (const id of cache.keys()) if (!current.has(id)) cache.delete(id); // deleted / running again
  const missing = list.filter((r) => cache.get(r.id)?.at !== current.get(r.id)).map((r) => r.id);
  for (let i = 0; i < missing.length; i += CHUNK) {
    const ids = missing.slice(i, i + CHUNK);
    const rows = await query<{ id: string; settings: MatchSettings; players: PlayerInfo[]; events: MatchEvent[]; winner: number | null }>(
      `SELECT id, settings, players, events, winner FROM matches WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const seatRows = await query<{ match_id: string; player_index: number; user_id: string }>(
      'SELECT match_id, player_index, user_id FROM match_players WHERE match_id = ANY($1::uuid[])',
      [ids],
    );
    const seats = new Map<string, Map<number, string>>();
    for (const s of seatRows) {
      const m = seats.get(s.match_id) ?? new Map<number, string>();
      m.set(s.player_index, s.user_id);
      seats.set(s.match_id, m);
    }
    for (const row of rows) {
      const at = current.get(row.id) as number;
      cache.set(row.id, { at, summary: summarize(row, at, seats.get(row.id) ?? new Map()) });
    }
  }
  const out: Summary[] = [];
  for (const id of current.keys()) {
    const s = cache.get(id)?.summary;
    if (s) out.push(s);
  }
  return out;
}

export async function buildLeaderboardResponse(now = Date.now()): Promise<LeaderboardResponse> {
  const [matches, users] = await Promise.all([
    finishedMatches(),
    query<{ id: string; display_name: string }>('SELECT id, display_name FROM users'),
  ]);
  const people = users.map((u) => ({ id: u.id, displayName: u.display_name }));

  // average / MPR / hit rate per user and mode over all finished matches (training included)
  const perMode = new Map<GameMode, Map<string, PlayerStats[]>>(MODES.map((m) => [m, new Map()]));
  for (const m of matches) {
    const byUser = perMode.get(m.mode) as Map<string, PlayerStats[]>;
    const seen = new Set<string>();
    m.players.forEach((p, i) => {
      if (!p.userId || seen.has(p.userId) || !m.stats[i]) return;
      seen.add(p.userId);
      const list = byUser.get(p.userId) ?? [];
      list.push(m.stats[i]);
      byUser.set(p.userId, list);
    });
  }

  const pools = {} as LeaderboardResponse['pools'];
  for (const pool of RATING_POOLS) {
    const metrics = new Map<string, number | null>();
    if (pool !== 'all') {
      for (const [userId, list] of perMode.get(pool) as Map<string, PlayerStats[]>) metrics.set(userId, poolMetric(pool, mergeStats(list)));
    }
    pools[pool] = buildLeaderboard(pool, people, rateMatches(matches, pool), metrics);
  }
  return { updatedAt: new Date(now).toISOString(), pools };
}

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.get('/api/leaderboard', async () => buildLeaderboardResponse());
}

/**
 * Leaderboard rating: Glicko (Glickman 1999) – Elo with an uncertainty (rating deviation, RD).
 *
 * - Only finished matches count (aborted ones never: misclick, forgotten player, no time).
 * - Only players with an account are rated; guests and solo games change nothing.
 * - Every pair of rated players in a match is one game: half the score for winning the match, half
 *   for the share of legs (3:0 counts more than 3:2; the winner always scores more than half).
 * - A place in the ranking needs GLICKO.rankedFrom rated matches; before that a player is listed as
 *   provisional (with rating, without place): one single won match never makes anybody number one.
 * - The rating itself is the Glicko r: a win always moves it up, a loss down. RD only controls how
 *   far: new players (and players back after a long break) move faster than established ones.
 */
import type { GameMode, PlayerStats } from './match';

export type RatingPool = GameMode | 'all';
export const RATING_POOLS: RatingPool[] = ['x01', 'cricket', 'atc', 'all'];

export const GLICKO = {
  start: 1500,
  startRd: 350,
  minRd: 50,
  /** RD² growth per day without games: minRd -> startRd in two years */
  cSquaredPerDay: (350 * 350 - 50 * 50) / 730,
  /** rated matches needed for a place in the ranking (fewer: provisional) */
  rankedFrom: 5,
};

const Q = Math.log(10) / 400;
const DAY = 86_400_000;

/** One finished match, reduced to what the rating needs. */
export interface RatedMatch {
  id: string;
  mode: GameMode;
  /** finish time (ms) */
  at: number;
  /** index of the match winner */
  winner: number;
  players: { userId: string | null; legs: number }[];
}

export interface Rating {
  r: number;
  rd: number;
  /** time of the last rated match (ms) */
  at: number;
  matches: number;
  wins: number;
  /** change of r by the last match */
  lastChange: number;
}

const g = (rd: number) => 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
const expected = (r: number, rj: number, rdj: number) => 1 / (1 + Math.pow(10, (-g(rdj) * (r - rj)) / 400));

/** RD after `ms` without games. */
export function inflateRd(rd: number, ms: number): number {
  const days = Math.max(0, ms) / DAY;
  return Math.min(GLICKO.startRd, Math.sqrt(rd * rd + GLICKO.cSquaredPerDay * days));
}

/**
 * Score of player a against player b in one match (0 … 1): half for the match result, half for the
 * share of legs. Without a winner among the two (both lost against a third player) the legs decide.
 */
export function pairScore(m: RatedMatch, a: number, b: number): number {
  const la = m.players[a].legs;
  const lb = m.players[b].legs;
  const result = m.winner === a ? 1 : m.winner === b ? 0 : la > lb ? 1 : la < lb ? 0 : 0.5;
  const share = la + lb > 0 ? la / (la + lb) : 0.5;
  return 0.5 * result + 0.5 * share;
}

function fresh(at: number): Rating {
  return { r: GLICKO.start, rd: GLICKO.startRd, at, matches: 0, wins: 0, lastChange: 0 };
}

/**
 * Glicko ratings of all players with an account after the given matches (any order; they are
 * sorted by time). Each match is one rating period for its players.
 */
export function rateMatches(matches: RatedMatch[], pool: RatingPool = 'all'): Map<string, Rating> {
  const ratings = new Map<string, Rating>();
  const list = matches.filter((m) => pool === 'all' || m.mode === pool).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const m of list) {
    // rated players of this match (a user twice in one match: only the first seat counts)
    const seats: number[] = [];
    const users = new Set<string>();
    m.players.forEach((p, i) => {
      if (p.userId && !users.has(p.userId)) {
        users.add(p.userId);
        seats.push(i);
      }
    });
    if (seats.length < 2) continue;
    // ratings before the match, RD grown by the time without games
    const before = new Map<number, { r: number; rd: number }>();
    for (const i of seats) {
      const cur = ratings.get(m.players[i].userId as string);
      before.set(i, cur ? { r: cur.r, rd: inflateRd(cur.rd, m.at - cur.at) } : { r: GLICKO.start, rd: GLICKO.startRd });
    }
    const updates: [number, { r: number; rd: number }][] = [];
    for (const i of seats) {
      const me = before.get(i) as { r: number; rd: number };
      let sum = 0;
      let dInv = 0;
      for (const j of seats) {
        if (j === i) continue;
        const op = before.get(j) as { r: number; rd: number };
        const gj = g(op.rd);
        const e = expected(me.r, op.r, op.rd);
        sum += gj * (pairScore(m, i, j) - e);
        dInv += Q * Q * gj * gj * e * (1 - e);
      }
      const denom = 1 / (me.rd * me.rd) + dInv;
      const r = me.r + (Q / denom) * sum;
      const rd = Math.max(GLICKO.minRd, Math.sqrt(1 / denom));
      updates.push([i, { r, rd }]);
    }
    for (const [i, next] of updates) {
      const userId = m.players[i].userId as string;
      const prev = ratings.get(userId) ?? fresh(m.at);
      const rating: Rating = {
        r: next.r,
        rd: next.rd,
        at: m.at,
        matches: prev.matches + 1,
        wins: prev.wins + (m.winner === i ? 1 : 0),
        lastChange: next.r - prev.r,
      };
      ratings.set(userId, rating);
    }
  }
  return ratings;
}

// ---------------------------------------------------------------------------
// Leaderboard (response of GET /api/leaderboard)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  /** 1 … n; null = fewer than GLICKO.rankedFrom rated matches (provisional or not rated at all) */
  rank: number | null;
  /** Glicko rating, rounded; null = no rated match in this pool yet */
  rating: number | null;
  /** at least one, but fewer than GLICKO.rankedFrom rated matches */
  provisional: boolean;
  /** rated matches (against other players with an account) and how many of them were won */
  matches: number;
  wins: number;
  /** change of the rating by the last rated match */
  lastChange: number | null;
  /** x01: 3-dart average, cricket: marks per round, atc: hit rate in % – over all finished matches (incl. training); all: null */
  metric: number | null;
  lastPlayedAt: string | null;
}

export interface LeaderboardResponse {
  updatedAt: string;
  pools: Record<RatingPool, LeaderboardEntry[]>;
}

/** The value shown in the metric column of a pool (null: no data / no column). */
export function poolMetric(pool: RatingPool, s: PlayerStats | null): number | null {
  if (!s || s.dartsThrown === 0) return null;
  if (pool === 'x01') return Math.round(s.average * 10) / 10;
  if (pool === 'cricket') return Math.round(s.mpr * 100) / 100;
  if (pool === 'atc') return Math.round(s.hitRate * 10) / 10;
  return null;
}

/**
 * Leaderboard of one pool: every user - first the ranked ones (enough matches) by rating, then the
 * provisional ones by rating, then everybody without a rated match by name.
 */
export function buildLeaderboard(
  pool: RatingPool,
  users: { id: string; displayName: string }[],
  ratings: Map<string, Rating>,
  metrics: Map<string, number | null>,
): LeaderboardEntry[] {
  const entries = users.map((u): LeaderboardEntry & { group: number; r: number } => {
    const rt = ratings.get(u.id);
    const matches = rt?.matches ?? 0;
    return {
      userId: u.id,
      displayName: u.displayName,
      rank: null,
      rating: rt ? Math.round(rt.r) : null,
      provisional: matches > 0 && matches < GLICKO.rankedFrom,
      matches,
      wins: rt?.wins ?? 0,
      lastChange: rt ? Math.round(rt.lastChange) : null,
      metric: metrics.get(u.id) ?? null,
      lastPlayedAt: rt ? new Date(rt.at).toISOString() : null,
      group: matches >= GLICKO.rankedFrom ? 0 : matches > 0 ? 1 : 2,
      r: rt?.r ?? 0,
    };
  });
  entries.sort((a, b) => a.group - b.group || b.r - a.r || a.displayName.localeCompare(b.displayName, 'de'));
  let rank = 0;
  return entries.map(({ group, r: _r, ...e }) => ({ ...e, rank: group === 0 ? ++rank : null }));
}

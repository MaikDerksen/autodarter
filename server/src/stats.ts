import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { segmentName } from '@shared/board';
import {
  CRICKET_TARGETS,
  computeMatch,
  describeSettings,
  mergeStats,
  type GameMode,
  type MatchEvent,
  type MatchSettings,
  type PlayerInfo,
  type PlayerStats,
} from '@shared/match';
import { query } from './db';
import { areFriends } from './friends';
import { HttpError, authenticate, parse, userId } from './http';

// ---------------------------------------------------------------------------
// Response shape (the app keeps a copy of these types in app/src/lib/stats.ts)
// ---------------------------------------------------------------------------

export type StatsRange = '7d' | '30d' | '90d' | 'all';

export interface StatsOverview {
  /** All finished matches in the range (incl. training = matches without opponents). */
  matches: number;
  /** Matches with at least one opponent. */
  versus: number;
  training: number;
  wins: number;
  losses: number;
  /** Wins / versus matches in percent. */
  winRate: number;
  dartsThrown: number;
  legsWon: number;
  legsPlayed: number;
  /** Days with at least one match in the range. */
  activeDays: number;
  /** Consecutive days played up to today / yesterday (all time, not limited by the range). */
  currentStreak: number;
  longestStreak: number;
  /** Consecutive wins in the most recent versus matches of the range. */
  winStreak: number;
  bestWinStreak: number;
  favouriteMode: GameMode | null;
  modes: Record<GameMode, number>;
  firstMatchAt: string | null;
  lastMatchAt: string | null;
}

/** One finished match (raw sums so the client can aggregate per day / week). */
export interface X01Point {
  at: string;
  points: number;
  darts: number;
  f9Points: number;
  f9Darts: number;
  checkouts: number;
  attempts: number;
}

export interface X01Block {
  matches: number;
  versus: number;
  wins: number;
  stats: PlayerStats;
  legsPlayed: number;
  /** Average darts per won leg. */
  avgLegDarts: number | null;
  /** Best 3-dart average of a single match (at least 9 darts). */
  bestMatchAverage: number | null;
  turns: number;
  busts: number;
  /** Turn scores: 0-19, 20-39, …, 160-179, 180 (10 buckets, bust turns excluded). */
  scoreBuckets: number[];
  /** Checkout values with count, highest first (all distinct values, at most 170). */
  checkouts: { value: number; count: number }[];
  /** Double-out only: darts at a one-dart finish per double (D1 … D20, BULL), only targets with attempts. */
  doubles: { target: string; attempts: number; hits: number }[];
  /** Oldest → newest, last 100 matches. */
  series: X01Point[];
}

export interface CricketPoint {
  at: string;
  marks: number;
  darts: number;
}

export interface CricketBlock {
  matches: number;
  versus: number;
  wins: number;
  stats: PlayerStats;
  legsPlayed: number;
  turns: number;
  /** Counted marks per turn: index 0 … 9 (9 = 9 marks). */
  marksPerTurn: number[];
  /** Raw marks (multiplier sum) per target 20 … 15, 25. */
  targets: { target: number; marks: number }[];
  bestMatchMpr: number | null;
  series: CricketPoint[];
}

export interface AtcPoint {
  at: string;
  hits: number;
  darts: number;
}

export interface AtcBlock {
  matches: number;
  versus: number;
  wins: number;
  stats: PlayerStats;
  /** Darts needed per finished leg (oldest → newest, last 150). */
  legs: { at: string; darts: number }[];
  bestGame: number | null;
  avgDarts: number | null;
  /** Darts thrown while the number was the target / hits, per target 1 … 20, 25. */
  targets: { target: number; attempts: number; hits: number }[];
  series: AtcPoint[];
}

export interface HeadToHead {
  userId: string;
  displayName: string;
  matches: number;
  wins: number;
  losses: number;
  lastPlayedAt: string;
}

export interface RecentMatch {
  id: string;
  title: string;
  mode: GameMode;
  won: boolean;
  versus: boolean;
  opponents: string[];
  legsWon: number;
  legsOpp: number;
  average: number;
  mpr: number;
  hitRate: number;
  darts: number;
  finishedAt: string;
}

export interface StatsResponse {
  user: { id: string; displayName: string };
  range: StatsRange;
  /** Start of the range (ISO), null for "all". */
  since: string | null;
  overview: StatsOverview;
  x01: X01Block | null;
  cricket: CricketBlock | null;
  atc: AtcBlock | null;
  /** Darts per segment key (T20, S5, D16, S25, D25, MISS) per mode. */
  heat: Record<GameMode, Record<string, number>>;
  /** Up to 800 recent camera-detected darts: [x mm, y mm, mode 0 = x01 / 1 = cricket / 2 = atc]. */
  positions: [number, number, number][];
  /** Only for your own stats (empty when looking at a friend). */
  headToHead: HeadToHead[];
  /** Only for your own stats (empty when looking at a friend). */
  recent: RecentMatch[];
}

// ---------------------------------------------------------------------------

export interface StatsRow {
  id: string;
  settings: MatchSettings;
  players: PlayerInfo[];
  events: MatchEvent[];
  winner: number | null;
  finished_at: Date;
  player_index: number;
}

const MODES: GameMode[] = ['x01', 'cricket', 'atc'];
const RANGE_DAYS: Record<StatsRange, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const SERIES_CAP = 100;
const POSITIONS_CAP = 800;
const RECENT_CAP = 30;

const querySchema = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).default('all'),
  /** Client time zone as Date#getTimezoneOffset() (minutes, UTC - local). */
  tz: z.coerce.number().int().min(-840).max(840).default(0),
});

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const avgOf = (list: number[]) => (list.length ? r1(list.reduce((a, b) => a + b, 0) / list.length) : null);

/** Local calendar day number of a timestamp. */
const dayIndex = (ms: number, tz: number) => Math.floor((ms - tz * 60_000) / DAY);

/** Remaining scores that can be finished with one dart at a double (double out). */
function doubleTarget(rem: number): string | null {
  if (rem === 50) return 'BULL';
  if (rem >= 2 && rem <= 40 && rem % 2 === 0) return `D${rem / 2}`;
  return null;
}

function streaks(days: Set<number>, today: number): { current: number; longest: number } {
  let current = 0;
  let d = days.has(today) ? today : days.has(today - 1) ? today - 1 : null;
  while (d !== null && days.has(d)) {
    current++;
    d--;
  }
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const day of [...days].sort((a, b) => a - b)) {
    run = prev !== null && day === prev + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  return { current, longest };
}

interface ModeAcc {
  matches: number;
  versus: number;
  wins: number;
  stats: PlayerStats[];
  legsPlayed: number;
}

const newModeAcc = (): ModeAcc => ({ matches: 0, versus: 0, wins: 0, stats: [], legsPlayed: 0 });

/** Start of the range: local midnight (days - 1) days ago, null for "all". */
function rangeStart(range: StatsRange, tz: number, now: number): Date | null {
  const days = RANGE_DAYS[range];
  return days === null ? null : new Date((dayIndex(now, tz) - (days - 1)) * DAY + tz * 60_000);
}

async function buildStats(user: { id: string; displayName: string }, range: StatsRange, tz: number, own: boolean): Promise<StatsResponse> {
  const now = Date.now();
  const since = rangeStart(range, tz, now);
  const rows = await query<StatsRow>(
    `SELECT m.id, m.settings, m.players, m.events, m.winner,
            COALESCE(m.finished_at, m.created_at) AS finished_at, mp.player_index
     FROM matches m JOIN match_players mp ON mp.match_id = m.id
     WHERE mp.user_id = $1 AND m.status = 'finished'
       AND ($2::timestamptz IS NULL OR COALESCE(m.finished_at, m.created_at) >= $2::timestamptz)
     ORDER BY COALESCE(m.finished_at, m.created_at) DESC
     LIMIT 1000`,
    [user.id, since ? since.toISOString() : null],
  );
  // play streaks look at all matches, independent of the range (cheap: no events)
  const dayRows = await query<{ at: Date }>(
    `SELECT DISTINCT COALESCE(m.finished_at, m.created_at) AS at
     FROM matches m JOIN match_players mp ON mp.match_id = m.id
     WHERE mp.user_id = $1 AND m.status = 'finished'`,
    [user.id],
  );
  const res = computeStats({ user, range, tz, own, now, rows, allDates: dayRows.map((r) => r.at) });
  // head-to-head: show the current display names
  if (res.headToHead.length) {
    const ids = res.headToHead.map((h) => h.userId).filter((id) => UUID_RE.test(id));
    const names = await query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [ids]);
    const byId = new Map(names.map((n) => [n.id, n.display_name]));
    for (const h of res.headToHead) h.displayName = byId.get(h.userId) ?? h.displayName;
  }
  return res;
}

/** Pure part of the statistics (no database access). rows: newest first. */
export function computeStats(input: {
  user: { id: string; displayName: string };
  range: StatsRange;
  tz: number;
  own: boolean;
  now: number;
  rows: StatsRow[];
  allDates: (Date | string)[];
}): StatsResponse {
  const { user, range, tz, own, now, rows } = input;
  const since = rangeStart(range, tz, now);
  const allDays = new Set(input.allDates.map((d) => dayIndex(new Date(d).getTime(), tz)));
  const streak = streaks(allDays, dayIndex(now, tz));

  const acc: Record<GameMode, ModeAcc> = { x01: newModeAcc(), cricket: newModeAcc(), atc: newModeAcc() };
  const heat: Record<GameMode, Record<string, number>> = { x01: {}, cricket: {}, atc: {} };
  const positions: [number, number, number][] = [];
  const activeDays = new Set<number>();
  const seen = new Set<string>();

  // x01
  const x01Series: X01Point[] = [];
  const scoreBuckets = Array.from({ length: 10 }, () => 0);
  const checkoutCounts = new Map<number, number>();
  const doubles = new Map<string, { attempts: number; hits: number }>();
  const x01LegDarts: number[] = [];
  let x01Turns = 0;
  let x01Busts = 0;
  let bestMatchAverage: number | null = null;
  // cricket
  const cricketSeries: CricketPoint[] = [];
  const marksPerTurn = Array.from({ length: 10 }, () => 0);
  const cricketTargets = new Map<number, number>(CRICKET_TARGETS.map((t) => [t, 0]));
  let cricketTurns = 0;
  let bestMatchMpr: number | null = null;
  // around the clock
  const atcSeries: AtcPoint[] = [];
  const atcLegs: { at: string; darts: number }[] = [];
  const atcTargets = new Map<number, { attempts: number; hits: number }>();
  for (let n = 1; n <= 20; n++) atcTargets.set(n, { attempts: 0, hits: 0 });
  atcTargets.set(25, { attempts: 0, hits: 0 });

  const h2h = new Map<string, Omit<HeadToHead, 'displayName'> & { fallbackName: string }>();
  const recent: RecentMatch[] = [];
  const versusResults: boolean[] = []; // newest first
  let wins = 0;
  let losses = 0;
  let firstMatchAt: string | null = null;
  let lastMatchAt: string | null = null;

  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const mode = r.settings?.mode;
    if (!MODES.includes(mode)) continue;
    let state: ReturnType<typeof computeMatch>;
    try {
      state = computeMatch(r.settings, r.players, r.events ?? []);
    } catch {
      continue; // broken legacy data – skip instead of failing the whole page
    }
    const me = r.player_index;
    const s = state.stats[me];
    if (!s) continue;

    const at = new Date(r.finished_at);
    const atIso = at.toISOString();
    lastMatchAt ??= atIso;
    firstMatchAt = atIso;
    activeDays.add(dayIndex(at.getTime(), tz));

    const versus = r.players.length > 1;
    const winner = r.winner ?? state.winner;
    const won = winner === me;
    const a = acc[mode];
    a.matches++;
    a.stats.push(s);
    a.legsPlayed += state.legs.filter((l) => l.winner !== null).length;
    if (versus) {
      a.versus++;
      versusResults.push(won);
      if (won) {
        a.wins++;
        wins++;
      } else losses++;
    }

    // head-to-head against players with an account
    r.players.forEach((p, i) => {
      if (i === me || !p.userId || p.userId === user.id) return;
      const e = h2h.get(p.userId) ?? { userId: p.userId, fallbackName: p.name, matches: 0, wins: 0, losses: 0, lastPlayedAt: atIso };
      e.matches++;
      if (won) e.wins++;
      else if (winner === i) e.losses++;
      h2h.set(p.userId, e);
    });

    const myTurns = state.legs.flatMap((leg) => leg.turns.filter((t) => t.player === me));

    // heat map + dart positions
    const modeIdx = MODES.indexOf(mode);
    for (const t of myTurns) {
      for (const d of t.darts) {
        const key = segmentName(d.seg);
        heat[mode][key] = (heat[mode][key] ?? 0) + 1;
        if (d.src === 'board' && typeof d.x === 'number' && typeof d.y === 'number' && positions.length < POSITIONS_CAP) {
          positions.push([Math.round(d.x), Math.round(d.y), modeIdx]);
        }
      }
    }

    if (mode === 'x01' && r.settings.mode === 'x01') {
      const outMode = r.settings.outMode;
      if (x01Series.length < SERIES_CAP) {
        x01Series.push({
          at: atIso,
          points: s.points,
          darts: s.dartsThrown,
          f9Points: s.first9Points,
          f9Darts: s.first9Darts,
          checkouts: s.checkouts,
          attempts: s.dartsAtDouble,
        });
      }
      if (s.dartsThrown >= 9) bestMatchAverage = Math.max(bestMatchAverage ?? 0, s.average);
      for (const leg of state.legs) {
        const turns = leg.turns.filter((t) => t.player === me);
        if (leg.winner === me) x01LegDarts.push(turns.reduce((sum, t) => sum + t.dartsCounted, 0));
        for (const t of turns) {
          x01Turns++;
          if (t.bust) x01Busts++;
          else scoreBuckets[t.points === 180 ? 9 : Math.min(8, Math.floor(t.points / 20))]++;
          if (t.checkout) checkoutCounts.set(t.points, (checkoutCounts.get(t.points) ?? 0) + 1);
          if (outMode !== 'double' || t.remaining === null) continue;
          // walk the darts: remaining before each dart
          let rem = t.bust ? t.remaining : t.remaining + t.points;
          t.darts.forEach((d, i) => {
            const target = doubleTarget(rem);
            if (target) {
              const e = doubles.get(target) ?? { attempts: 0, hits: 0 };
              e.attempts++;
              if (t.checkout && i === t.darts.length - 1) e.hits++;
              doubles.set(target, e);
            }
            rem -= d.points;
          });
        }
      }
    } else if (mode === 'cricket') {
      if (cricketSeries.length < SERIES_CAP) cricketSeries.push({ at: atIso, marks: s.marks, darts: s.dartsThrown });
      if (s.dartsThrown >= 9) bestMatchMpr = Math.max(bestMatchMpr ?? 0, s.mpr);
      for (const t of myTurns) {
        cricketTurns++;
        marksPerTurn[Math.max(0, Math.min(9, t.marks))]++;
        for (const d of t.darts) {
          if (d.seg.multiplier > 0 && cricketTargets.has(d.seg.number)) {
            cricketTargets.set(d.seg.number, (cricketTargets.get(d.seg.number) ?? 0) + d.seg.multiplier);
          }
        }
      }
    } else if (mode === 'atc' && r.settings.mode === 'atc') {
      if (atcSeries.length < SERIES_CAP) atcSeries.push({ at: atIso, hits: s.hits, darts: s.dartsThrown });
      const targets = Array.from({ length: 20 }, (_, i) => i + 1);
      if (r.settings.bull) targets.push(25);
      for (const leg of state.legs) {
        const turns = leg.turns.filter((t) => t.player === me);
        if (leg.winner === me && atcLegs.length < 150) {
          atcLegs.push({ at: atIso, darts: turns.reduce((sum, t) => sum + t.dartsCounted, 0) });
        }
        let idx = 0;
        for (const t of turns) {
          for (const d of t.darts) {
            const target = targets[idx];
            if (target === undefined) break;
            const e = atcTargets.get(target);
            if (e) {
              e.attempts++;
              if (d.hit) e.hits++;
            }
            idx += Math.max(0, d.points);
          }
        }
      }
    }

    if (own && recent.length < RECENT_CAP) {
      const legsOpp = Math.max(0, ...state.legsWon.filter((_, i) => i !== me));
      recent.push({
        id: r.id,
        title: describeSettings(r.settings),
        mode,
        won,
        versus,
        opponents: r.players.filter((_, i) => i !== me).map((p) => p.name),
        legsWon: state.legsWon[me] ?? 0,
        legsOpp,
        average: s.average,
        mpr: s.mpr,
        hitRate: s.hitRate,
        darts: s.dartsThrown,
        finishedAt: atIso,
      });
    }
  }

  // win streaks (versusResults is newest first)
  let winStreak = 0;
  while (winStreak < versusResults.length && versusResults[winStreak]) winStreak++;
  let bestWinStreak = 0;
  let run = 0;
  for (const w of versusResults) {
    run = w ? run + 1 : 0;
    bestWinStreak = Math.max(bestWinStreak, run);
  }

  const modes = { x01: acc.x01.matches, cricket: acc.cricket.matches, atc: acc.atc.matches };
  const matches = modes.x01 + modes.cricket + modes.atc;
  const favouriteMode = matches ? MODES.reduce((best, m) => (modes[m] > modes[best] ? m : best), MODES[0]) : null;
  const all = mergeStats([...acc.x01.stats, ...acc.cricket.stats, ...acc.atc.stats]);

  // head-to-head (display names from the match; buildStats replaces them with the current ones)
  const headToHead: HeadToHead[] = own
    ? [...h2h.values()]
        .map(({ fallbackName, ...e }) => ({ ...e, displayName: fallbackName }))
        .sort((x, y) => y.matches - x.matches || y.lastPlayedAt.localeCompare(x.lastPlayedAt))
        .slice(0, 30)
    : [];

  const x01: X01Block | null = acc.x01.matches
    ? {
        matches: acc.x01.matches,
        versus: acc.x01.versus,
        wins: acc.x01.wins,
        stats: mergeStats(acc.x01.stats),
        legsPlayed: acc.x01.legsPlayed,
        avgLegDarts: avgOf(x01LegDarts),
        bestMatchAverage,
        turns: x01Turns,
        busts: x01Busts,
        scoreBuckets,
        checkouts: [...checkoutCounts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((x, y) => y.value - x.value),
        doubles: [...doubles.entries()]
          .map(([target, e]) => ({ target, ...e }))
          .sort((x, y) => y.attempts - x.attempts || x.target.localeCompare(y.target)),
        series: x01Series.reverse(),
      }
    : null;

  const cricket: CricketBlock | null = acc.cricket.matches
    ? {
        matches: acc.cricket.matches,
        versus: acc.cricket.versus,
        wins: acc.cricket.wins,
        stats: mergeStats(acc.cricket.stats),
        legsPlayed: acc.cricket.legsPlayed,
        turns: cricketTurns,
        marksPerTurn,
        targets: CRICKET_TARGETS.map((target) => ({ target, marks: cricketTargets.get(target) ?? 0 })),
        bestMatchMpr: bestMatchMpr === null ? null : r2(bestMatchMpr),
        series: cricketSeries.reverse(),
      }
    : null;

  const atcLegDarts = atcLegs.map((l) => l.darts);
  const atc: AtcBlock | null = acc.atc.matches
    ? {
        matches: acc.atc.matches,
        versus: acc.atc.versus,
        wins: acc.atc.wins,
        stats: mergeStats(acc.atc.stats),
        legs: atcLegs.reverse(),
        bestGame: atcLegDarts.length ? Math.min(...atcLegDarts) : null,
        avgDarts: avgOf(atcLegDarts),
        targets: [...atcTargets.entries()].map(([target, e]) => ({ target, ...e })),
        series: atcSeries.reverse(),
      }
    : null;

  return {
    user,
    range,
    since: since ? since.toISOString() : null,
    overview: {
      matches,
      versus: wins + losses,
      training: matches - wins - losses,
      wins,
      losses,
      winRate: wins + losses ? r1((wins / (wins + losses)) * 100) : 0,
      dartsThrown: all.dartsThrown,
      legsWon: all.legsWon,
      legsPlayed: acc.x01.legsPlayed + acc.cricket.legsPlayed + acc.atc.legsPlayed,
      activeDays: activeDays.size,
      currentStreak: streak.current,
      longestStreak: streak.longest,
      winStreak,
      bestWinStreak,
      favouriteMode,
      modes,
      firstMatchAt,
      lastMatchAt,
    },
    x01,
    cricket,
    atc,
    heat,
    positions,
    headToHead,
    recent,
  };
}

async function loadUser(id: string): Promise<{ id: string; displayName: string }> {
  const [u] = await query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = $1', [id]);
  if (!u) throw new HttpError(404, 'Nicht gefunden');
  return { id: u.id, displayName: u.display_name };
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.get('/api/stats/me', async (req) => {
    const q = parse(querySchema, req.query ?? {});
    const me = userId(req);
    return buildStats(await loadUser(me), q.range, q.tz, true);
  });

  /** Statistics of yourself or of an accepted friend (everybody else: 404). */
  app.get<{ Params: { id: string } }>('/api/stats/user/:id', async (req) => {
    const q = parse(querySchema, req.query ?? {});
    const me = userId(req);
    const id = req.params.id;
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Nicht gefunden');
    if (id !== me && !(await areFriends(me, id))) throw new HttpError(404, 'Nicht gefunden');
    return buildStats(await loadUser(id), q.range, q.tz, id === me);
  });
}

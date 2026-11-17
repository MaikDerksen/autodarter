import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import type { GameMode, PlayerStats } from '@shared';
import { api, errorMessage } from './api';

// ---------------------------------------------------------------------------
// Response of GET /api/stats/me and /api/stats/user/:id (copy of server/src/stats.ts)
// ---------------------------------------------------------------------------

export type StatsRange = '7d' | '30d' | '90d' | 'all';

export interface StatsOverview {
  matches: number;
  versus: number;
  training: number;
  wins: number;
  losses: number;
  winRate: number;
  dartsThrown: number;
  legsWon: number;
  legsPlayed: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  winStreak: number;
  bestWinStreak: number;
  favouriteMode: GameMode | null;
  modes: Record<GameMode, number>;
  firstMatchAt: string | null;
  lastMatchAt: string | null;
}

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
  avgLegDarts: number | null;
  bestMatchAverage: number | null;
  turns: number;
  busts: number;
  scoreBuckets: number[];
  checkouts: { value: number; count: number }[];
  doubles: { target: string; attempts: number; hits: number }[];
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
  marksPerTurn: number[];
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
  legs: { at: string; darts: number }[];
  bestGame: number | null;
  avgDarts: number | null;
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
  since: string | null;
  overview: StatsOverview;
  x01: X01Block | null;
  cricket: CricketBlock | null;
  atc: AtcBlock | null;
  heat: Record<GameMode, Record<string, number>>;
  positions: [number, number, number][];
  headToHead: HeadToHead[];
  recent: RecentMatch[];
}

// ---------------------------------------------------------------------------

export function statsPath(who: 'me' | string, range: StatsRange): string {
  const tz = new Date().getTimezoneOffset();
  const base = who === 'me' ? '/api/stats/me' : `/api/stats/user/${encodeURIComponent(who)}`;
  return `${base}?range=${range}&tz=${tz}`;
}

/**
 * Loads statistics whenever the screen gets focus or the path changes.
 * The previous data stays while a new range / friend loads (pending = true),
 * so the page can dim it instead of flashing a spinner.
 */
export function useStats(path: string | null) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    if (!path) {
      setData(null);
      setError(null);
      setPending(false);
      return;
    }
    setPending(true);
    try {
      const res = await api<StatsResponse>(path);
      if (id !== seq.current) return;
      setData(res);
      setError(null);
    } catch (e) {
      if (id !== seq.current) return;
      setError(errorMessage(e));
    } finally {
      if (id === seq.current) setPending(false);
    }
  }, [path]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return { data, error, pending, reload: load };
}

// ---------------------------------------------------------------------------
// Time helpers: series are aggregated per local calendar day
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Local calendar day number of an ISO timestamp. */
export function dayOf(iso: string): number {
  const d = new Date(iso);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / DAY);
}

export function today(): number {
  return dayOf(new Date().toISOString());
}

/** "12. Nov" (with year if it is not the current one). */
export function dayLabel(day: number, withYear = false): string {
  const d = new Date(day * DAY);
  const y = withYear || d.getUTCFullYear() !== new Date().getFullYear() ? ` ${String(d.getUTCFullYear()).slice(2)}` : '';
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}${y}`;
}

export function dateLabel(iso: string): string {
  return dayLabel(dayOf(iso));
}

export interface DayPoint {
  x: number;
  y: number;
}

/** Group items per local day and compute one value per day (null = no value that day). */
export function perDay<T extends { at: string }>(items: T[], value: (group: T[]) => number | null): DayPoint[] {
  const groups = new Map<number, T[]>();
  for (const it of items) {
    const d = dayOf(it.at);
    const g = groups.get(d);
    if (g) g.push(it);
    else groups.set(d, [it]);
  }
  const out: DayPoint[] = [];
  for (const [x, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const y = value(g);
    if (y !== null && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

const sum = <T>(list: T[], f: (v: T) => number) => list.reduce((a, v) => a + f(v), 0);
const ratio = (a: number, b: number, factor: number) => (b > 0 ? (a / b) * factor : null);

export const metrics = {
  average: (g: X01Point[]) => ratio(sum(g, (p) => p.points), sum(g, (p) => p.darts), 3),
  first9: (g: X01Point[]) => ratio(sum(g, (p) => p.f9Points), sum(g, (p) => p.f9Darts), 3),
  checkoutRate: (g: X01Point[]) => ratio(sum(g, (p) => p.checkouts), sum(g, (p) => p.attempts), 100),
  mpr: (g: CricketPoint[]) => ratio(sum(g, (p) => p.marks), sum(g, (p) => p.darts), 3),
  hitRate: (g: AtcPoint[]) => ratio(sum(g, (p) => p.hits), sum(g, (p) => p.darts), 100),
  legDarts: (g: { darts: number }[]) => (g.length ? sum(g, (p) => p.darts) / g.length : null),
};

// ---------------------------------------------------------------------------
// Number formatting (German, without relying on Intl)
// ---------------------------------------------------------------------------

/** 1234.5 -> "1234,5", 12345 -> "12.345", null -> "–" */
export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const [int, frac] = Math.abs(v).toFixed(digits).split('.');
  const grouped = int.length > 4 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : int;
  return `${v < 0 ? '−' : ''}${grouped}${frac ? `,${frac}` : ''}`;
}

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '–' : `${num(v, digits)} %`);

export const share = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0);

export const MODE_LABEL: Record<GameMode, string> = { x01: 'X01', cricket: 'Cricket', atc: 'Around the Clock' };
export const MODE_SHORT: Record<GameMode, string> = { x01: 'X01', cricket: 'Cricket', atc: 'ATC' };

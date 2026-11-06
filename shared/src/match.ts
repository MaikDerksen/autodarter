import { ALL_SEGMENTS, segmentLabel, segmentScore, type Segment } from './board';
import { checkoutLabels, isValidFinish, suggestCheckout, type InOutMode } from './checkout';

export type { InOutMode };

export interface X01Settings {
  mode: 'x01';
  startScore: number;
  inMode: InOutMode;
  outMode: InOutMode;
  /** First to N legs. */
  legs: number;
}

export type CricketVariant = 'standard' | 'cutthroat';

export interface CricketSettings {
  mode: 'cricket';
  variant: CricketVariant;
  legs: number;
  /** 0 = unlimited */
  maxRounds: number;
}

export type MatchSettings = X01Settings | CricketSettings;

export interface PlayerInfo {
  id: string;
  name: string;
  userId?: string | null;
}

export type DartSource = 'board' | 'manual';

export interface DartEvent {
  t: 'dart';
  seg: Segment;
  x?: number;
  y?: number;
  src: DartSource;
  at: number;
}

export interface NextEvent {
  t: 'next';
  at: number;
}

export type MatchEvent = DartEvent | NextEvent;

export interface DartView {
  seg: Segment;
  label: string;
  points: number;
  x?: number;
  y?: number;
  src: DartSource;
  eventIndex: number;
}

export interface TurnView {
  player: number;
  darts: DartView[];
  /** x01: points scored (0 on bust). cricket: points gained by this player. */
  points: number;
  /** cricket: marks that counted. */
  marks: number;
  bust: boolean;
  checkout: boolean;
  /** x01: remaining score after the turn. */
  remaining: number | null;
  complete: boolean;
  /** Darts that count for statistics (missing darts of an ended turn count as thrown). */
  dartsCounted: number;
}

export interface LegView {
  starter: number;
  turns: TurnView[];
  winner: number | null;
}

export interface PlayerStats {
  legsWon: number;
  dartsThrown: number;
  points: number;
  average: number;
  first9Points: number;
  first9Darts: number;
  first9Average: number;
  highestTurn: number;
  t180: number;
  t140: number;
  t100: number;
  checkouts: number;
  highestCheckout: number;
  dartsAtDouble: number;
  checkoutRate: number;
  bestLegDarts: number | null;
  marks: number;
  mpr: number;
}

export interface CricketView {
  targets: number[];
  /** marks[player][targetIndex] (can exceed 3 only visually capped by client) */
  marks: number[][];
  points: number[];
}

export interface MatchState {
  settings: MatchSettings;
  players: PlayerInfo[];
  legs: LegView[];
  legsWon: number[];
  currentPlayer: number;
  round: number;
  turn: TurnView;
  dartsLeft: number;
  awaitingNext: boolean;
  legFinished: boolean;
  remaining: number[];
  cricket: CricketView | null;
  checkout: string[] | null;
  finished: boolean;
  winner: number | null;
  stats: PlayerStats[];
  eventCount: number;
}

export const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25];

export function emptyStats(): PlayerStats {
  return {
    legsWon: 0,
    dartsThrown: 0,
    points: 0,
    average: 0,
    first9Points: 0,
    first9Darts: 0,
    first9Average: 0,
    highestTurn: 0,
    t180: 0,
    t140: 0,
    t100: 0,
    checkouts: 0,
    highestCheckout: 0,
    dartsAtDouble: 0,
    checkoutRate: 0,
    bestLegDarts: null,
    marks: 0,
    mpr: 0,
  };
}

/** Recompute derived ratios of a stats object (in place) and return it. */
export function finalizeStats(s: PlayerStats): PlayerStats {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  s.average = s.dartsThrown ? r2((s.points / s.dartsThrown) * 3) : 0;
  s.first9Average = s.first9Darts ? r2((s.first9Points / s.first9Darts) * 3) : 0;
  s.checkoutRate = s.dartsAtDouble ? r2((s.checkouts / s.dartsAtDouble) * 100) : 0;
  s.mpr = s.dartsThrown ? r2((s.marks / s.dartsThrown) * 3) : 0;
  return s;
}

/** Sum up raw statistics (e.g. across matches). */
export function mergeStats(list: PlayerStats[]): PlayerStats {
  const out = emptyStats();
  for (const s of list) {
    out.legsWon += s.legsWon;
    out.dartsThrown += s.dartsThrown;
    out.points += s.points;
    out.first9Points += s.first9Points;
    out.first9Darts += s.first9Darts;
    out.highestTurn = Math.max(out.highestTurn, s.highestTurn);
    out.t180 += s.t180;
    out.t140 += s.t140;
    out.t100 += s.t100;
    out.checkouts += s.checkouts;
    out.highestCheckout = Math.max(out.highestCheckout, s.highestCheckout);
    out.dartsAtDouble += s.dartsAtDouble;
    if (s.bestLegDarts !== null) {
      out.bestLegDarts = out.bestLegDarts === null ? s.bestLegDarts : Math.min(out.bestLegDarts, s.bestLegDarts);
    }
    out.marks += s.marks;
  }
  return finalizeStats(out);
}

function isValidIn(seg: Segment, mode: InOutMode): boolean {
  if (seg.multiplier === 0) return false;
  if (mode === 'double') return seg.multiplier === 2;
  if (mode === 'master') return seg.multiplier === 2 || seg.multiplier === 3;
  return true;
}

function oneDartFinishPossible(rem: number, outMode: InOutMode): boolean {
  return ALL_SEGMENTS.some((s) => isValidFinish(s, outMode) && segmentScore(s) === rem);
}

export function validateSettings(settings: MatchSettings, playerCount: number): string | null {
  if (playerCount < 1 || playerCount > 8) return 'Es werden 1 bis 8 Spieler unterstützt.';
  if (!Number.isInteger(settings.legs) || settings.legs < 1 || settings.legs > 21) return 'Ungültige Anzahl Legs.';
  if (settings.mode === 'x01') {
    if (![101, 201, 301, 401, 501, 701, 901, 1001].includes(settings.startScore)) return 'Ungültiger Startwert.';
    const modes: InOutMode[] = ['straight', 'double', 'master'];
    if (!modes.includes(settings.inMode) || !modes.includes(settings.outMode)) return 'Ungültiger In/Out-Modus.';
    return null;
  }
  if (settings.mode === 'cricket') {
    if (!['standard', 'cutthroat'].includes(settings.variant)) return 'Ungültige Cricket-Variante.';
    if (!Number.isInteger(settings.maxRounds) || settings.maxRounds < 0 || settings.maxRounds > 100) {
      return 'Ungültige Rundenbegrenzung.';
    }
    return null;
  }
  return 'Unbekannter Spielmodus.';
}

interface TurnStart {
  remaining: number;
  opened: boolean;
}

/**
 * Event-sourced match engine: the full state is always derived from the
 * settings, the players and the list of events. Undo = drop events.
 */
export function computeMatch(settings: MatchSettings, players: PlayerInfo[], events: MatchEvent[]): MatchState {
  const n = players.length;
  const stats = players.map(() => emptyStats());
  const legsWon = players.map(() => 0);
  const legs: LegView[] = [];
  let leg!: LegView;
  let remaining: number[] = [];
  let opened: boolean[] = [];
  let cricket: CricketView | null = null;
  let currentPlayer = 0;
  let turn!: TurnView;
  let turnStart: TurnStart = { remaining: 0, opened: false };
  let turnFinalized = false;
  let turnWonLeg = false;
  let finished = false;
  let winner: number | null = null;

  const newTurn = (p: number): TurnView => {
    turnStart = { remaining: remaining[p] ?? 0, opened: opened[p] ?? false };
    turnFinalized = false;
    turnWonLeg = false;
    return {
      player: p,
      darts: [],
      points: 0,
      marks: 0,
      bust: false,
      checkout: false,
      remaining: settings.mode === 'x01' ? remaining[p] : null,
      complete: false,
      dartsCounted: 0,
    };
  };

  const startLeg = (starter: number) => {
    leg = { starter, turns: [], winner: null };
    legs.push(leg);
    if (settings.mode === 'x01') {
      remaining = players.map(() => settings.startScore);
      opened = players.map(() => settings.inMode === 'straight');
      cricket = null;
    } else {
      remaining = players.map(() => 0);
      opened = players.map(() => true);
      cricket = {
        targets: CRICKET_TARGETS,
        marks: players.map(() => CRICKET_TARGETS.map(() => 0)),
        points: players.map(() => 0),
      };
    }
    currentPlayer = starter;
    turn = newTurn(starter);
  };

  const playerTurnIndexInLeg = (p: number) => leg.turns.filter((t) => t.player === p).length;

  const finalizeTurn = () => {
    if (turnFinalized) return;
    turnFinalized = true;
    const p = turn.player;
    const s = stats[p];
    const counted = turnWonLeg ? turn.darts.length : 3;
    turn.dartsCounted = counted;
    turn.complete = true;
    if (settings.mode === 'x01') {
      turn.remaining = remaining[p];
      if (playerTurnIndexInLeg(p) < 3) {
        s.first9Points += turn.points;
        s.first9Darts += counted;
      }
      s.points += turn.points;
      s.highestTurn = Math.max(s.highestTurn, turn.points);
      if (turn.points === 180) s.t180++;
      else if (turn.points >= 140) s.t140++;
      else if (turn.points >= 100) s.t100++;
      if (turn.checkout) {
        s.checkouts++;
        s.highestCheckout = Math.max(s.highestCheckout, turn.points);
      }
    } else {
      s.marks += turn.marks;
    }
    s.dartsThrown += counted;
    leg.turns.push(turn);
  };

  const winLeg = (p: number) => {
    leg.winner = p;
    legsWon[p]++;
    stats[p].legsWon++;
    turnWonLeg = turn.player === p && !turnFinalized;
    const legDarts =
      leg.turns.filter((t) => t.player === p).reduce((sum, t) => sum + t.dartsCounted, 0) +
      (turnWonLeg ? turn.darts.length : 0);
    const best = stats[p].bestLegDarts;
    stats[p].bestLegDarts = best === null ? legDarts : Math.min(best, legDarts);
    turn.complete = true;
    if (legsWon[p] >= settings.legs) {
      finished = true;
      winner = p;
      finalizeTurn();
    }
  };

  const applyX01Dart = (seg: Segment): number => {
    if (settings.mode !== 'x01') return 0;
    const p = currentPlayer;
    const rem = remaining[p];
    let pts = segmentScore(seg);
    if (!opened[p]) {
      if (isValidIn(seg, settings.inMode)) opened[p] = true;
      else pts = 0;
    }
    if (opened[p] && oneDartFinishPossible(rem, settings.outMode)) stats[p].dartsAtDouble++;
    const newRem = rem - pts;
    const strictOut = settings.outMode !== 'straight';
    const bust =
      newRem < 0 || (strictOut && newRem === 1) || (newRem === 0 && !isValidFinish(seg, settings.outMode));
    if (bust) {
      remaining[p] = turnStart.remaining;
      opened[p] = turnStart.opened;
      turn.bust = true;
      turn.complete = true;
      turn.points = 0;
    } else {
      remaining[p] = newRem;
      turn.points = turnStart.remaining - newRem;
      if (newRem === 0) {
        turn.checkout = true;
        winLeg(p);
      }
    }
    turn.remaining = remaining[p];
    return pts;
  };

  const applyCricketDart = (seg: Segment): number => {
    if (settings.mode !== 'cricket' || !cricket) return 0;
    const p = currentPlayer;
    const ti = CRICKET_TARGETS.indexOf(seg.number);
    if (ti < 0 || seg.multiplier === 0) return 0;
    const value = seg.number;
    let counted = 0;
    let extra = 0;
    for (let h = 0; h < seg.multiplier; h++) {
      if (cricket.marks[p][ti] < 3) {
        cricket.marks[p][ti]++;
        counted++;
      } else extra++;
    }
    let gained = 0;
    if (extra > 0) {
      const openOpponents = players.map((_, q) => q).filter((q) => q !== p && cricket!.marks[q][ti] < 3);
      if (openOpponents.length > 0) {
        counted += extra;
        if (settings.variant === 'standard') {
          gained = extra * value;
          cricket.points[p] += gained;
        } else {
          for (const q of openOpponents) cricket.points[q] += extra * value;
        }
      }
    }
    turn.marks += counted;
    turn.points += gained;
    // win check
    const allClosed = cricket.marks[p].every((m) => m >= 3);
    if (allClosed) {
      const others = cricket.points.filter((_, q) => q !== p);
      const ok =
        others.length === 0 ||
        (settings.variant === 'standard'
          ? cricket.points[p] >= Math.max(...others)
          : cricket.points[p] <= Math.min(...others));
      if (ok) winLeg(p);
    }
    return gained;
  };

  const cricketRoundLimitWinner = (): number => {
    const c = cricket!;
    const totalMarks = c.marks.map((m) => m.reduce((a, b) => a + Math.min(b, 3), 0));
    let best = 0;
    for (let q = 1; q < n; q++) {
      const better =
        settings.mode === 'cricket' && settings.variant === 'cutthroat'
          ? c.points[q] < c.points[best] || (c.points[q] === c.points[best] && totalMarks[q] > totalMarks[best])
          : c.points[q] > c.points[best] || (c.points[q] === c.points[best] && totalMarks[q] > totalMarks[best]);
      if (better) best = q;
    }
    return best;
  };

  startLeg(0);

  events.forEach((ev, idx) => {
    if (finished) return;
    if (ev.t === 'dart') {
      if (turn.complete) return;
      const pts = settings.mode === 'x01' ? applyX01Dart(ev.seg) : applyCricketDart(ev.seg);
      turn.darts.push({
        seg: ev.seg,
        label: segmentLabel(ev.seg),
        points: settings.mode === 'x01' ? pts : segmentScore(ev.seg),
        x: ev.x,
        y: ev.y,
        src: ev.src,
        eventIndex: idx,
      });
      if (turn.darts.length >= 3) turn.complete = true;
      return;
    }
    // next
    if (leg.winner !== null) {
      finalizeTurn();
      startLeg((leg.starter + 1) % n);
      return;
    }
    finalizeTurn();
    currentPlayer = (currentPlayer + 1) % n;
    if (
      settings.mode === 'cricket' &&
      settings.maxRounds > 0 &&
      currentPlayer === leg.starter &&
      leg.turns.length >= settings.maxRounds * n
    ) {
      turn = newTurn(currentPlayer);
      turnFinalized = true; // placeholder turn, never recorded
      winLeg(cricketRoundLimitWinner());
      return;
    }
    turn = newTurn(currentPlayer);
  });

  for (const s of stats) finalizeStats(s);

  const legFinished = leg.winner !== null;
  const dartsLeft = turn.complete ? 0 : 3 - turn.darts.length;
  let checkout: string[] | null = null;
  if (settings.mode === 'x01' && !finished && !turn.complete && opened[currentPlayer]) {
    checkout = checkoutLabels(suggestCheckout(remaining[currentPlayer], dartsLeft, settings.outMode));
  }

  return {
    settings,
    players,
    legs,
    legsWon,
    currentPlayer,
    round: Math.floor(leg.turns.length / n) + 1,
    turn,
    dartsLeft,
    awaitingNext: !finished && turn.complete,
    legFinished,
    remaining,
    cricket,
    checkout,
    finished,
    winner,
    stats,
    eventCount: events.length,
  };
}

/** Remove the last dart (and any trailing "next" events after it). */
export function undoEvents(events: MatchEvent[]): MatchEvent[] {
  const out = events.slice();
  while (out.length > 0) {
    const ev = out.pop()!;
    if (ev.t === 'dart') break;
    // a lonely "next" with no dart before it: drop just that one
    if (!out.some((e) => e.t === 'dart')) break;
  }
  return out;
}

export function defaultSettings(mode: 'x01' | 'cricket'): MatchSettings {
  return mode === 'x01'
    ? { mode: 'x01', startScore: 301, inMode: 'straight', outMode: 'double', legs: 1 }
    : { mode: 'cricket', variant: 'standard', legs: 1, maxRounds: 20 };
}

export function describeSettings(s: MatchSettings): string {
  const legs = s.legs > 1 ? ` · First to ${s.legs}` : '';
  if (s.mode === 'x01') {
    const io = (m: InOutMode) => (m === 'straight' ? 'S' : m === 'double' ? 'D' : 'M');
    return `${s.startScore} ${io(s.inMode)}I/${io(s.outMode)}O${legs}`;
  }
  return `Cricket ${s.variant === 'cutthroat' ? 'Cut-Throat' : 'Standard'}${s.maxRounds ? ` · ${s.maxRounds} Runden` : ''}${legs}`;
}

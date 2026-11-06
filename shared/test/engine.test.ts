import { describe, expect, it } from 'vitest';
import {
  BOARD,
  CALIBRATION_POINTS,
  applyHomography,
  computeHomography,
  computeMatch,
  parseSegment,
  scoreFromCoords,
  segmentLabel,
  suggestCheckout,
  undoEvents,
  type MatchEvent,
  type MatchSettings,
  type PlayerInfo,
} from '../src';

const players: PlayerInfo[] = [
  { id: 'a', name: 'Anna' },
  { id: 'b', name: 'Ben' },
];

let clock = 0;
const d = (name: string): MatchEvent => ({ t: 'dart', seg: parseSegment(name), src: 'manual', at: clock++ });
const next = (): MatchEvent => ({ t: 'next', at: clock++ });

describe('board geometry', () => {
  it('scores coordinates', () => {
    expect(segmentLabel(scoreFromCoords(0, 0))).toBe('BULL');
    expect(segmentLabel(scoreFromCoords(0, 10))).toBe('25');
    expect(segmentLabel(scoreFromCoords(0, 103))).toBe('T20');
    expect(segmentLabel(scoreFromCoords(0, 166))).toBe('D20');
    expect(segmentLabel(scoreFromCoords(0, 140))).toBe('20');
    expect(segmentLabel(scoreFromCoords(0, 175))).toBe('MISS');
    expect(segmentLabel(scoreFromCoords(103, 0))).toBe('T6');
    expect(segmentLabel(scoreFromCoords(0, -103))).toBe('T3');
    expect(segmentLabel(scoreFromCoords(-103, 0))).toBe('T11');
    // just right of the 20/1 boundary is the 1
    const a = (80 * Math.PI) / 180;
    expect(segmentLabel(scoreFromCoords(130 * Math.cos(a), 130 * Math.sin(a)))).toBe('1');
  });

  it('places calibration points on the double ring', () => {
    for (const p of CALIBRATION_POINTS.slice(0, 4)) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(BOARD.doubleOuter, 6);
    }
  });

  it('computes homographies', () => {
    const src = CALIBRATION_POINTS.map((p) => ({ x: p.x, y: p.y }));
    const H0 = [1.2, 0.1, 320, -0.05, 0.6, 240, 0.0004, 0.0001, 1];
    const dst = src.map((p) => applyHomography(H0 as never, p));
    const H = computeHomography(src, dst)!;
    const test = applyHomography(H, { x: 50, y: -70 });
    const expected = applyHomography(H0 as never, { x: 50, y: -70 });
    expect(test.x).toBeCloseTo(expected.x, 6);
    expect(test.y).toBeCloseTo(expected.y, 6);
  });
});

describe('checkout', () => {
  const lbl = (s: number, darts = 3) => suggestCheckout(s, darts, 'double')?.map(segmentLabel).join(' ') ?? null;
  it('suggests sensible routes', () => {
    expect(lbl(170)).toBe('T20 T20 BULL');
    expect(lbl(40)).toBe('D20');
    expect(lbl(100)).toBe('T20 D20');
    expect(lbl(60)).toBe('20 D20');
    expect(lbl(50)).toBe('BULL');
    expect(lbl(169)).toBeNull();
    expect(lbl(1)).toBeNull();
    expect(lbl(100, 1)).toBeNull();
  });
});

describe('x01', () => {
  const s301: MatchSettings = { mode: 'x01', startScore: 301, inMode: 'straight', outMode: 'double', legs: 1 };

  it('scores turns and switches players', () => {
    const st = computeMatch(s301, players, [d('T20'), d('T20'), d('T20'), next(), d('20')]);
    expect(st.remaining).toEqual([121, 281]);
    expect(st.currentPlayer).toBe(1);
    expect(st.stats[0].t180).toBe(1);
    expect(st.dartsLeft).toBe(2);
  });

  it('handles bust and reverts the turn', () => {
    const ev = [d('T20'), d('T20'), d('T20'), next(), d('1'), next()];
    ev.push(d('T20'), d('T20'), d('T1'), next(), d('1'), next()); // A: 121 -> 1 (bust because of 1 with double out)
    const st = computeMatch(s301, players, ev);
    expect(st.remaining[0]).toBe(121);
    expect(st.legs[0].turns[2].bust).toBe(true);
  });

  it('requires a double to finish', () => {
    const settings: MatchSettings = { ...s301, startScore: 101 };
    let st = computeMatch(settings, players, [d('T20'), d('1'), d('20')]); // 101-81 = 20 left
    expect(st.remaining[0]).toBe(20);
    st = computeMatch(settings, players, [d('T20'), d('1'), d('20'), next(), d('1'), next(), d('20')]);
    expect(st.remaining[0]).toBe(20); // bust: 20 single is not a double
    st = computeMatch(settings, players, [d('T20'), d('1'), d('20'), next(), d('1'), next(), d('D10')]);
    expect(st.finished).toBe(true);
    expect(st.winner).toBe(0);
    expect(st.stats[0].checkouts).toBe(1);
    expect(st.stats[0].highestCheckout).toBe(20);
  });

  it('supports double in', () => {
    const settings: MatchSettings = { ...s301, inMode: 'double' };
    const st = computeMatch(settings, players, [d('T20'), d('D10'), d('T20')]);
    expect(st.remaining[0]).toBe(301 - 80);
  });

  it('plays multiple legs and rotates the starter', () => {
    const settings: MatchSettings = { ...s301, startScore: 101, legs: 2 };
    const ev = [d('T20'), d('1'), d('D20'), next()];
    let st = computeMatch(settings, players, ev);
    expect(st.legsWon).toEqual([1, 0]);
    expect(st.finished).toBe(false);
    expect(st.currentPlayer).toBe(1);
    expect(st.legs.length).toBe(2);
    ev.push(d('T20'), d('1'), d('D20'));
    st = computeMatch(settings, players, ev);
    expect(st.legsWon).toEqual([1, 1]);
  });

  it('undo removes the last dart including trailing next', () => {
    const ev = [d('T20'), d('T20'), d('T20'), next()];
    const undone = undoEvents(ev);
    expect(undone.length).toBe(2);
    const st = computeMatch(s301, players, undone);
    expect(st.currentPlayer).toBe(0);
    expect(st.dartsLeft).toBe(1);
  });

  it('computes averages', () => {
    const st = computeMatch(s301, players, [d('T20'), d('T20'), d('T20'), next(), d('20'), d('20'), d('20'), next()]);
    expect(st.stats[0].average).toBe(180);
    expect(st.stats[1].average).toBe(60);
  });
});

describe('cricket', () => {
  const std: MatchSettings = { mode: 'cricket', variant: 'standard', legs: 1, maxRounds: 0 };

  it('closes numbers and scores extra marks', () => {
    const st = computeMatch(std, players, [d('T20'), d('T20'), d('D19')]);
    expect(st.cricket!.marks[0][0]).toBe(3);
    expect(st.cricket!.points[0]).toBe(60);
    expect(st.cricket!.marks[0][1]).toBe(2);
    expect(st.stats[0].marks).toBe(0); // turn not yet finalised
  });

  it('does not score on numbers closed by everyone', () => {
    const st = computeMatch(std, players, [d('T20'), next(), d('T20'), next(), d('T20')]);
    expect(st.cricket!.points).toEqual([0, 0]);
  });

  it('cut-throat gives points to opponents', () => {
    const ct: MatchSettings = { ...std, variant: 'cutthroat' };
    const st = computeMatch(ct, players, [d('T20'), d('S20')]);
    expect(st.cricket!.points).toEqual([0, 20]);
  });

  it('wins when all closed and leading', () => {
    const ev: MatchEvent[] = [];
    for (const t of ['20', '19', '18', '17', '16', '15']) {
      ev.push(d('T' + t));
    }
    ev.push(d('BULL'), d('25'));
    // spread over turns
    const turns: MatchEvent[] = [];
    let count = 0;
    for (const e of ev) {
      turns.push(e);
      count++;
      if (count === 3) {
        turns.push(next(), d('MISS'), d('MISS'), d('MISS'), next());
        count = 0;
      }
    }
    const st = computeMatch(std, players, turns);
    expect(st.finished).toBe(true);
    expect(st.winner).toBe(0);
    expect(st.stats[0].mpr).toBeGreaterThan(0);
  });

  it('ends the leg after the round limit', () => {
    const limited: MatchSettings = { ...std, maxRounds: 1 };
    const st = computeMatch(limited, players, [d('T20'), d('S20'), next(), d('MISS'), next()]);
    expect(st.finished).toBe(true);
    expect(st.winner).toBe(0);
  });
});

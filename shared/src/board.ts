/**
 * Dartboard geometry and scoring.
 *
 * Board coordinate system: millimetres, origin = centre of the bull,
 * x to the right, y up (as seen by the player standing in front of the board).
 */

/** Sector numbers clockwise starting at the top. */
export const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5] as const;

/** Standard (WDF/PDC) ring radii in mm. */
export const BOARD = {
  doubleBullRadius: 6.35,
  bullRadius: 15.9,
  tripleInner: 99,
  tripleOuter: 107,
  doubleInner: 162,
  doubleOuter: 170,
  /** Outer edge of the number ring (board diameter 451 mm). */
  boardRadius: 225.5,
} as const;

export type Multiplier = 0 | 1 | 2 | 3;

/** number: 1..20, 25 for the bull, 0 for a miss. */
export interface Segment {
  number: number;
  multiplier: Multiplier;
}

export interface Point {
  x: number;
  y: number;
}

export const MISS: Segment = { number: 0, multiplier: 0 };

export function segmentScore(s: Segment): number {
  return s.number * s.multiplier;
}

/** Machine name: S20, D20, T20, S25 (outer bull), D25 (bull), MISS. */
export function segmentName(s: Segment): string {
  if (s.multiplier === 0 || s.number === 0) return 'MISS';
  const prefix = s.multiplier === 3 ? 'T' : s.multiplier === 2 ? 'D' : 'S';
  return `${prefix}${s.number}`;
}

/** Human label: 20, D20, T20, 25, BULL, MISS. */
export function segmentLabel(s: Segment): string {
  if (s.multiplier === 0 || s.number === 0) return 'MISS';
  if (s.number === 25) return s.multiplier === 2 ? 'BULL' : '25';
  if (s.multiplier === 1) return String(s.number);
  return segmentName(s);
}

export function parseSegment(name: string): Segment {
  const n = name.trim().toUpperCase();
  if (n === 'MISS' || n === 'M' || n === '0') return MISS;
  if (n === 'BULL' || n === 'DB' || n === 'D25' || n === '50') return { number: 25, multiplier: 2 };
  if (n === '25' || n === 'S25' || n === 'SB') return { number: 25, multiplier: 1 };
  const m = /^([SDT]?)(\d{1,2})$/.exec(n);
  if (!m) throw new Error(`Invalid segment: ${name}`);
  const num = Number(m[2]);
  if (num < 1 || num > 20) throw new Error(`Invalid segment: ${name}`);
  const multiplier: Multiplier = m[1] === 'T' ? 3 : m[1] === 'D' ? 2 : 1;
  return { number: num, multiplier };
}

export function isValidSegment(s: Segment): boolean {
  if (s.number === 0) return s.multiplier === 0;
  if (s.number === 25) return s.multiplier === 1 || s.multiplier === 2;
  return Number.isInteger(s.number) && s.number >= 1 && s.number <= 20 && [1, 2, 3].includes(s.multiplier);
}

/** Angle in degrees (math orientation, 0 = right, 90 = top) of the centre of a sector. */
export function sectorAngle(sectorNumber: number): number {
  const idx = SECTORS.indexOf(sectorNumber as (typeof SECTORS)[number]);
  if (idx < 0) throw new Error(`Invalid sector ${sectorNumber}`);
  return 90 - idx * 18;
}

/** Score a position on the board. */
export function scoreFromCoords(x: number, y: number): Segment {
  const r = Math.hypot(x, y);
  if (r <= BOARD.doubleBullRadius) return { number: 25, multiplier: 2 };
  if (r <= BOARD.bullRadius) return { number: 25, multiplier: 1 };
  if (r > BOARD.doubleOuter) return MISS;
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  const idx = Math.floor((((90 - angle + 9) % 360) + 360) % 360 / 18) % 20;
  const number = SECTORS[idx];
  let multiplier: Multiplier = 1;
  if (r >= BOARD.tripleInner && r <= BOARD.tripleOuter) multiplier = 3;
  else if (r >= BOARD.doubleInner) multiplier = 2;
  return { number, multiplier };
}

/** A representative position for a segment (used to draw manually entered darts). */
export function segmentCenter(s: Segment): Point | null {
  if (s.number === 0) return null;
  if (s.number === 25) {
    if (s.multiplier === 2) return { x: 0, y: 0 };
    return { x: 0, y: -(BOARD.doubleBullRadius + BOARD.bullRadius) / 2 };
  }
  const a = (sectorAngle(s.number) * Math.PI) / 180;
  const r =
    s.multiplier === 3
      ? (BOARD.tripleInner + BOARD.tripleOuter) / 2
      : s.multiplier === 2
        ? (BOARD.doubleInner + BOARD.doubleOuter) / 2
        : (BOARD.tripleOuter + BOARD.doubleInner) / 2;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

export interface CalibrationPointDef {
  id: string;
  label: string;
  x: number;
  y: number;
}

function onDoubleOuter(angleDeg: number): Point {
  const a = (angleDeg * Math.PI) / 180;
  return { x: BOARD.doubleOuter * Math.cos(a), y: BOARD.doubleOuter * Math.sin(a) };
}

/**
 * Calibration reference points: the outer edge of the double ring at four sector
 * boundaries (like Autodarts: 20/1, 6/10, 3/19, 11/14) plus the bull centre.
 */
export const CALIBRATION_POINTS: CalibrationPointDef[] = [
  { id: '20/1', label: '20 | 1', ...onDoubleOuter(81) },
  { id: '6/10', label: '6 | 10', ...onDoubleOuter(-9) },
  { id: '3/19', label: '3 | 19', ...onDoubleOuter(-99) },
  { id: '11/14', label: '11 | 14', ...onDoubleOuter(171) },
  { id: 'bull', label: 'Bull', x: 0, y: 0 },
];

/** All segments a dart can hit (no MISS). */
export const ALL_SEGMENTS: Segment[] = (() => {
  const list: Segment[] = [];
  for (let n = 1; n <= 20; n++) {
    list.push({ number: n, multiplier: 1 }, { number: n, multiplier: 2 }, { number: n, multiplier: 3 });
  }
  list.push({ number: 25, multiplier: 1 }, { number: 25, multiplier: 2 });
  return list;
})();

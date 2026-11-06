import { ALL_SEGMENTS, segmentLabel, segmentScore, type Segment } from './board';

export type InOutMode = 'straight' | 'double' | 'master';

export function isValidFinish(seg: Segment, outMode: InOutMode): boolean {
  if (seg.multiplier === 0) return false;
  if (outMode === 'double') return seg.multiplier === 2;
  if (outMode === 'master') return seg.multiplier === 2 || seg.multiplier === 3;
  return true;
}

const FINISH_PREFERENCE: Record<number, number> = { 20: 0, 16: 0, 8: 1, 18: 1, 12: 1, 10: 1, 4: 2, 6: 2, 14: 2, 2: 3 };

function finishCost(seg: Segment): number {
  if (seg.multiplier === 2) {
    if (seg.number === 25) return 3;
    return FINISH_PREFERENCE[seg.number] ?? 3;
  }
  if (seg.multiplier === 3) return 5 + (20 - seg.number) / 10;
  // straight out: big singles are easy targets
  return seg.number === 25 ? 4 : 2 + (20 - seg.number) / 10;
}

function setupCost(seg: Segment): number {
  if (seg.number === 25) return seg.multiplier === 2 ? 6 : 4;
  if (seg.multiplier === 3) {
    const t: Record<number, number> = { 20: 0, 19: 1, 18: 2, 17: 3, 16: 3, 15: 4 };
    return t[seg.number] ?? 5;
  }
  if (seg.multiplier === 1) {
    if (seg.number === 20) return 1;
    if (seg.number === 19) return 2;
    return 3;
  }
  return 8; // doubles as setup darts are unusual
}

const cache = new Map<string, Segment[] | null>();

/**
 * Suggest a checkout route for `score` with at most `darts` darts.
 * Returns null when no finish is possible.
 */
export function suggestCheckout(score: number, darts: number, outMode: InOutMode = 'double'): Segment[] | null {
  if (score <= 0 || darts <= 0) return null;
  if (score > 180) return null;
  const key = `${outMode}:${darts}:${score}`;
  if (cache.has(key)) return cache.get(key)!;

  let best: { route: Segment[]; cost: number } | null = null;
  const finishers = ALL_SEGMENTS.filter((s) => isValidFinish(s, outMode));
  const consider = (route: Segment[]) => {
    const last = route[route.length - 1];
    const cost =
      route.length * 1000 + route.slice(0, -1).reduce((c, s) => c + setupCost(s), 0) + finishCost(last);
    if (!best || cost < best.cost) best = { route, cost };
  };

  for (const f of finishers) {
    if (segmentScore(f) === score) consider([f]);
  }
  if (!best && darts >= 2) {
    for (const a of ALL_SEGMENTS) {
      const rest = score - segmentScore(a);
      if (rest <= 0) continue;
      for (const f of finishers) if (segmentScore(f) === rest) consider([a, f]);
    }
  }
  if (!best && darts >= 3) {
    for (const a of ALL_SEGMENTS) {
      const r1 = score - segmentScore(a);
      if (r1 <= 0) continue;
      for (const b of ALL_SEGMENTS) {
        const r2 = r1 - segmentScore(b);
        if (r2 <= 0) continue;
        for (const f of finishers) if (segmentScore(f) === r2) consider([a, b, f]);
      }
    }
  }
  const result = best ? (best as { route: Segment[] }).route : null;
  cache.set(key, result);
  return result;
}

export function checkoutLabels(route: Segment[] | null): string[] | null {
  return route ? route.map(segmentLabel) : null;
}

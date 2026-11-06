import { useMemo } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { applyHomography, BOARD, CALIBRATION_POINTS, computeHomography, type Mat3, type Point } from '@shared';

const RINGS = [BOARD.doubleOuter, BOARD.doubleInner, BOARD.tripleOuter, BOARD.tripleInner, BOARD.bullRadius, BOARD.doubleBullRadius];

/** Homography board(mm) -> image pixels from normalised calibration points. */
export function boardToImage(points: Point[], width: number, height: number): Mat3 | null {
  if (points.length !== CALIBRATION_POINTS.length) return null;
  return computeHomography(
    CALIBRATION_POINTS.map((p) => ({ x: p.x, y: p.y })),
    points.map((p) => ({ x: p.x * width, y: p.y * height })),
  );
}

export function wireframePath(H: Mat3): string {
  const parts: string[] = [];
  for (const r of RINGS) {
    const steps = r < 20 ? 24 : 96;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const p = applyHomography(H, { x: r * Math.cos(a), y: r * Math.sin(a) });
      parts.push(`${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
    }
  }
  for (let i = 0; i < 20; i++) {
    const a = ((81 - i * 18) * Math.PI) / 180;
    const p1 = applyHomography(H, { x: BOARD.bullRadius * Math.cos(a), y: BOARD.bullRadius * Math.sin(a) });
    const p2 = applyHomography(H, { x: BOARD.doubleOuter * Math.cos(a), y: BOARD.doubleOuter * Math.sin(a) });
    parts.push(`M${p1.x.toFixed(1)} ${p1.y.toFixed(1)}L${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
  }
  return parts.join('');
}

/** Projected board wireframe drawn over a camera image. */
export function BoardOverlay({
  points,
  width,
  height,
  color = '#22c55e',
  tip,
}: {
  points: Point[] | null | undefined;
  width: number;
  height: number;
  color?: string;
  tip?: Point | null;
}) {
  const d = useMemo(() => {
    if (!points || width <= 0 || height <= 0) return null;
    const H = boardToImage(points, width, height);
    return H ? wireframePath(H) : null;
  }, [points, width, height]);
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {d ? <Path d={d} stroke={color} strokeWidth={1.2} fill="none" opacity={0.85} /> : null}
      {tip ? <Circle cx={tip.x * width} cy={tip.y * height} r={6} stroke="#fff" strokeWidth={2} fill="#ef4444" /> : null}
    </Svg>
  );
}

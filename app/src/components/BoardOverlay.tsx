import { useMemo } from 'react';
import Svg, { Circle, Path, Text as SvgText } from 'react-native-svg';
import { applyHomography, BOARD, CALIBRATION_POINTS, computeHomography, SECTORS, type Mat3, type Point } from '@shared';

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

/** Radius (mm) of the printed number ring of a standard board. */
const NUMBER_RING = 196;

/**
 * Sector numbers projected into the camera image: with a right calibration they sit on the numbers
 * printed on the board. A rotated or mirrored calibration (points swapped) shows up at once.
 */
export function sectorLabels(H: Mat3): { n: number; x: number; y: number }[] {
  return SECTORS.map((n, i) => {
    const a = ((90 - i * 18) * Math.PI) / 180;
    const p = applyHomography(H, { x: NUMBER_RING * Math.cos(a), y: NUMBER_RING * Math.sin(a) });
    return { n, x: p.x, y: p.y };
  });
}

export function SectorNumbers({ H, color = '#facc15', size = 13 }: { H: Mat3 | null; color?: string; size?: number }) {
  if (!H) return null;
  return (
    <>
      {sectorLabels(H).map((l) =>
        // dark outline first, then the number on top (readable on black and cream segments)
        [true, false].map((outline) => (
          <SvgText
            key={`${l.n}-${outline ? 'o' : 'f'}`}
            x={l.x}
            y={l.y + size * 0.36}
            fill={color}
            stroke={outline ? '#000' : 'none'}
            strokeWidth={outline ? size / 4 : 0}
            fontSize={size}
            fontWeight="900"
            textAnchor="middle"
          >
            {String(l.n)}
          </SvgText>
        )),
      )}
    </>
  );
}

/** Projected board wireframe drawn over a camera image. */
export function BoardOverlay({
  points,
  width,
  height,
  color = '#22c55e',
  tip,
  numbers = false,
}: {
  points: Point[] | null | undefined;
  width: number;
  height: number;
  color?: string;
  tip?: Point | null;
  /** also draw the sector numbers (to check the orientation of the calibration) */
  numbers?: boolean;
}) {
  const H = useMemo(() => (!points || width <= 0 || height <= 0 ? null : boardToImage(points, width, height)), [points, width, height]);
  const d = useMemo(() => (H ? wireframePath(H) : null), [H]);
  return (
    <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {d ? <Path d={d} stroke={color} strokeWidth={1.2} fill="none" opacity={0.85} /> : null}
      {numbers ? <SectorNumbers H={H} size={Math.max(9, Math.min(14, width / 40))} /> : null}
      {tip ? <Circle cx={tip.x * width} cy={tip.y * height} r={6} stroke="#fff" strokeWidth={2} fill="#ef4444" /> : null}
    </Svg>
  );
}

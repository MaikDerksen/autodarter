import { memo, useMemo } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import { BOARD, SECTORS, scoreFromCoords, type Segment } from '@shared';
import { colors } from '@/lib/theme';

export interface BoardHit {
  x: number;
  y: number;
  color?: string;
  label?: string;
}

const VIEW = 232;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)];
}

function wedge(r1: number, r2: number, a1: number, a2: number): string {
  // a1 > a2 (clockwise in math orientation)
  const [x1, y1] = polar(r2, a1);
  const [x2, y2] = polar(r2, a2);
  const [x3, y3] = polar(r1, a2);
  const [x4, y4] = polar(r1, a1);
  return `M${x1} ${y1}A${r2} ${r2} 0 0 1 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 0 0 ${x4} ${y4}Z`;
}

const BoardGraphic = memo(function BoardGraphic({ highlight }: { highlight?: Set<number> }) {
  const sectors = useMemo(
    () =>
      SECTORS.map((num, i) => {
        const center = 90 - i * 18;
        const a1 = center + 9;
        const a2 = center - 9;
        const dark = i % 2 === 0;
        const single = dark ? colors.boardBlack : colors.boardCream;
        const ring = dark ? colors.boardRed : colors.boardGreen;
        const dim = highlight && !highlight.has(num);
        return { num, center, a1, a2, single, ring, dim };
      }),
    [highlight],
  );
  return (
    <G>
      <Circle r={BOARD.boardRadius} fill="#0d0e10" />
      {sectors.map((s) => (
        <G key={s.num} opacity={s.dim ? 0.35 : 1}>
          <Path d={wedge(BOARD.bullRadius, BOARD.tripleInner, s.a1, s.a2)} fill={s.single} />
          <Path d={wedge(BOARD.tripleInner, BOARD.tripleOuter, s.a1, s.a2)} fill={s.ring} />
          <Path d={wedge(BOARD.tripleOuter, BOARD.doubleInner, s.a1, s.a2)} fill={s.single} />
          <Path d={wedge(BOARD.doubleInner, BOARD.doubleOuter, s.a1, s.a2)} fill={s.ring} />
        </G>
      ))}
      <Circle r={BOARD.bullRadius} fill={colors.boardGreen} opacity={highlight && !highlight.has(25) ? 0.35 : 1} />
      <Circle r={BOARD.doubleBullRadius} fill={colors.boardRed} opacity={highlight && !highlight.has(25) ? 0.35 : 1} />
      {[BOARD.doubleOuter, BOARD.doubleInner, BOARD.tripleOuter, BOARD.tripleInner, BOARD.bullRadius].map((r) => (
        <Circle key={r} r={r} fill="none" stroke={colors.wire} strokeWidth={0.6} opacity={0.6} />
      ))}
      {sectors.map((s) => {
        const [x, y] = polar(197, s.center);
        return (
          <SvgText
            key={`n${s.num}`}
            x={x}
            y={y + 7}
            fill={s.dim ? colors.faint : '#f2f2f2'}
            fontSize={20}
            fontWeight="700"
            textAnchor="middle"
          >
            {String(s.num)}
          </SvgText>
        );
      })}
    </G>
  );
});

/**
 * Dartboard drawn in board coordinates (mm). Optional hit markers and tap-to-score.
 */
export function Dartboard({
  size,
  hits = [],
  onSegment,
  highlight,
}: {
  size: number;
  hits?: BoardHit[];
  onSegment?: (seg: Segment, pos: { x: number; y: number }) => void;
  highlight?: number[];
}) {
  const hl = useMemo(() => (highlight ? new Set(highlight) : undefined), [highlight]);

  const handlePress = (e: GestureResponderEvent) => {
    if (!onSegment) return;
    const ne = e.nativeEvent as GestureResponderEvent['nativeEvent'] & { offsetX?: number; offsetY?: number };
    const locationX = Number.isFinite(ne.locationX) ? ne.locationX : (ne.offsetX ?? NaN);
    const locationY = Number.isFinite(ne.locationY) ? ne.locationY : (ne.offsetY ?? NaN);
    if (!Number.isFinite(locationX) || !Number.isFinite(locationY)) return;
    const x = (locationX / size) * (2 * VIEW) - VIEW;
    const y = -((locationY / size) * (2 * VIEW) - VIEW);
    onSegment(scoreFromCoords(x, y), { x, y });
  };

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`${-VIEW} ${-VIEW} ${2 * VIEW} ${2 * VIEW}`}>
        <BoardGraphic highlight={hl} />
        {hits.map((h, i) => (
          <G key={i}>
            <Circle cx={h.x} cy={-h.y} r={7} fill={h.color ?? colors.info} stroke="#fff" strokeWidth={2} />
            {h.label ? (
              <SvgText x={h.x} y={-h.y + 4} fontSize={9} fontWeight="800" fill="#001" textAnchor="middle">
                {h.label}
              </SvgText>
            ) : null}
          </G>
        ))}
      </Svg>
      {onSegment ? (
        <View
          onStartShouldSetResponder={() => true}
          onResponderRelease={handlePress}
          style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, cursor: 'pointer' } as object}
          accessibilityRole="button"
          accessibilityLabel="Dartboard – Segment antippen"
        />
      ) : null}
    </View>
  );
}

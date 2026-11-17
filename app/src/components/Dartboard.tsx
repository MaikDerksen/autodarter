import { memo, useMemo } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Image as SvgImage, Path, Text as SvgText } from 'react-native-svg';
import { BOARD, BOARD_VIEW, SECTORS, scoreFromCoords, type Segment } from '@shared';
import { colors } from '@/lib/theme';

export interface BoardHit {
  x: number;
  y: number;
  color?: string;
  label?: string;
}

const VIEW = BOARD_VIEW;

/** Colours of segments that do not count in the current game (e.g. 1–14 in cricket). */
const OFF = { single: ['#14171c', '#191c22'], ring: '#1f232a', label: '#3d4552' };
/** Black single fields of numbers that are in play get a green tint, so they never look "switched off". */
const TARGET_DARK = '#173a28';

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

const BoardGraphic = memo(function BoardGraphic({ targets }: { targets?: Set<number> }) {
  const sectors = useMemo(
    () =>
      SECTORS.map((num, i) => {
        const center = 90 - i * 18;
        const dark = i % 2 === 0;
        const off = !!targets && !targets.has(num);
        return {
          num,
          center,
          a1: center + 9,
          a2: center - 9,
          single: off ? OFF.single[i % 2] : dark ? (targets ? TARGET_DARK : colors.boardBlack) : colors.boardCream,
          ring: off ? OFF.ring : dark ? colors.boardRed : colors.boardGreen,
          target: !!targets && targets.has(num),
          off,
        };
      }),
    [targets],
  );
  const bullOff = !!targets && !targets.has(25);
  const bullTarget = !!targets && targets.has(25);
  return (
    <G>
      <Circle r={BOARD.boardRadius} fill="#0d0e10" />
      {sectors.map((s) => (
        <G key={s.num}>
          <Path d={wedge(BOARD.bullRadius, BOARD.tripleInner, s.a1, s.a2)} fill={s.single} />
          <Path d={wedge(BOARD.tripleInner, BOARD.tripleOuter, s.a1, s.a2)} fill={s.ring} />
          <Path d={wedge(BOARD.tripleOuter, BOARD.doubleInner, s.a1, s.a2)} fill={s.single} />
          <Path d={wedge(BOARD.doubleInner, BOARD.doubleOuter, s.a1, s.a2)} fill={s.ring} />
        </G>
      ))}
      <Circle r={BOARD.bullRadius} fill={bullOff ? OFF.ring : colors.boardGreen} />
      <Circle r={BOARD.doubleBullRadius} fill={bullOff ? OFF.single[1] : colors.boardRed} />
      {[BOARD.doubleOuter, BOARD.doubleInner, BOARD.tripleOuter, BOARD.tripleInner, BOARD.bullRadius].map((r) => (
        <Circle key={r} r={r} fill="none" stroke={colors.wire} strokeWidth={0.6} opacity={targets ? 0.35 : 0.6} />
      ))}
      {/* cricket: frame the numbers that are still in play so that every field of them reads as "active" */}
      {sectors
        .filter((s) => s.target)
        .map((s) => (
          <Path
            key={`t${s.num}`}
            d={wedge(BOARD.bullRadius, BOARD.doubleOuter, s.a1, s.a2)}
            fill="none"
            stroke={colors.accent}
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
        ))}
      {bullTarget ? <Circle r={BOARD.bullRadius} fill="none" stroke={colors.accent} strokeWidth={2.4} /> : null}
      {sectors.map((s) => {
        const [x, y] = polar(197, s.center);
        return (
          <SvgText
            key={`n${s.num}`}
            x={x}
            y={y + 7}
            fill={s.off ? OFF.label : s.target ? colors.accent : '#f2f2f2'}
            fontSize={s.target ? 22 : 20}
            fontWeight={s.target ? '900' : '700'}
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
 * targets: numbers that count in the current game (cricket) – all others are greyed out.
 * image: frontal camera view (same coordinates) shown instead of the drawn board.
 * ring: colour of the glowing status ring (board ready / pull darts / stopped).
 */
export function Dartboard({
  size,
  hits = [],
  onSegment,
  targets,
  image,
  ring,
}: {
  size: number;
  hits?: BoardHit[];
  onSegment?: (seg: Segment, pos: { x: number; y: number }) => void;
  targets?: number[];
  image?: string | null;
  ring?: string | null;
}) {
  const targetSet = useMemo(() => (targets ? new Set(targets) : undefined), [targets]);

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
    <View
      style={[
        { width: size, height: size, borderRadius: size / 2 },
        ring ? ({ boxShadow: `0 0 ${Math.round(size * 0.05)}px ${Math.round(size * 0.012)}px ${ring}` } as object) : null,
      ]}
    >
      <Svg width={size} height={size} viewBox={`${-VIEW} ${-VIEW} ${2 * VIEW} ${2 * VIEW}`}>
        <Defs>
          <ClipPath id="boardClip">
            <Circle r={VIEW} />
          </ClipPath>
        </Defs>
        {image ? (
          <G clipPath="url(#boardClip)">
            <Circle r={VIEW} fill="#0e0f11" />
            <SvgImage href={image} x={-VIEW} y={-VIEW} width={2 * VIEW} height={2 * VIEW} preserveAspectRatio="none" />
          </G>
        ) : (
          <BoardGraphic targets={targetSet} />
        )}
        {ring ? <Circle r={VIEW - 2.5} fill="none" stroke={ring} strokeWidth={4} /> : null}
        {hits.map((h, i) => (
          <G key={i}>
            <Circle cx={h.x} cy={-h.y} r={7.5} fill={h.color ?? '#f8fafc'} stroke="#0b0f14" strokeWidth={2} />
            {h.label ? (
              <SvgText x={h.x} y={-h.y + 3.5} fontSize={10} fontWeight="900" fill="#0b0f14" textAnchor="middle">
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

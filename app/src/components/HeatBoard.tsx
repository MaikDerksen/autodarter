/**
 * Dartboard heat map: every field is tinted with one series colour, the more
 * darts landed there the stronger (square-root scale so rare fields stay visible).
 * Alternatively shows the camera-detected dart positions as dots.
 * Geometry is the same as in Dartboard.tsx (board millimetres, ±BOARD_VIEW).
 */
import { memo, useId } from 'react';
import { Platform, Text, View, type GestureResponderEvent, type PointerEvent } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { BOARD, BOARD_VIEW, SECTORS, scoreFromCoords, segmentName } from '@shared';
import { colors } from '@/lib/theme';

const VIEW = BOARD_VIEW;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)];
}

function wedge(r1: number, r2: number, a1: number, a2: number): string {
  const [x1, y1] = polar(r2, a1);
  const [x2, y2] = polar(r2, a2);
  const [x3, y3] = polar(r1, a2);
  const [x4, y4] = polar(r1, a1);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r2} ${r2} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}L${x3.toFixed(2)} ${y3.toFixed(2)}A${r1} ${r1} 0 0 0 ${x4.toFixed(2)} ${y4.toFixed(2)}Z`;
}

interface Field {
  key: string;
  d: string;
  base: string;
}

/** All board fields (singles twice: inner and outer part), computed once. */
const FIELDS: Field[] = SECTORS.flatMap((num, i) => {
  const center = 90 - i * 18;
  const a1 = center + 9;
  const a2 = center - 9;
  const even = i % 2 === 0;
  const single = even ? '#18202a' : '#1d2631';
  const ring = even ? '#212b37' : '#26313e';
  return [
    { key: `S${num}`, d: wedge(BOARD.bullRadius, BOARD.tripleInner, a1, a2), base: single },
    { key: `T${num}`, d: wedge(BOARD.tripleInner, BOARD.tripleOuter, a1, a2), base: ring },
    { key: `S${num}`, d: wedge(BOARD.tripleOuter, BOARD.doubleInner, a1, a2), base: single },
    { key: `D${num}`, d: wedge(BOARD.doubleInner, BOARD.doubleOuter, a1, a2), base: ring },
  ];
});

const NUMBERS = SECTORS.map((num, i) => {
  const [x, y] = polar(197, 90 - i * 18);
  return { num, x, y };
});

/** Opacity of a field for its share of the darts (0 … maxShare). */
export const heatAlpha = (share: number, maxShare: number) => (share <= 0 || maxShare <= 0 ? 0 : Math.max(0.08, Math.sqrt(Math.min(1, share / maxShare))));

const BoardBase = memo(function BoardBase() {
  return (
    <G>
      <Circle r={VIEW - 1} fill="#0f141b" />
      {FIELDS.map((f, i) => (
        <Path key={`${f.key}-${i}`} d={f.d} fill={f.base} />
      ))}
      <Circle r={BOARD.bullRadius} fill="#26313e" />
      <Circle r={BOARD.doubleBullRadius} fill="#2c3846" />
      {[BOARD.doubleOuter, BOARD.doubleInner, BOARD.tripleOuter, BOARD.tripleInner, BOARD.bullRadius, BOARD.doubleBullRadius].map((r) => (
        <Circle key={r} r={r} fill="none" stroke="#2f3b49" strokeWidth={0.8} />
      ))}
      {NUMBERS.map((n) => (
        <SvgText key={n.num} x={n.x} y={n.y + 7} fill={colors.muted} fontSize={19} fontWeight="700" textAnchor="middle">
          {String(n.num)}
        </SvgText>
      ))}
    </G>
  );
});

export function HeatBoard({
  size,
  color,
  counts,
  total,
  maxShare,
  positions,
  display,
  selected,
  onSelect,
  label,
}: {
  size: number;
  color: string;
  counts: Record<string, number>;
  total: number;
  /** shared scale: the highest field share (0 … 1) across all boards shown */
  maxShare: number;
  positions?: [number, number][];
  display: 'fields' | 'darts';
  selected: string | null;
  onSelect: (key: string | null) => void;
  label: string;
}) {
  const keyAt = (e: GestureResponderEvent | PointerEvent): string | null => {
    const ne = e.nativeEvent as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
    const lx = Number.isFinite(ne.locationX) ? ne.locationX : ne.offsetX;
    const ly = Number.isFinite(ne.locationY) ? ne.locationY : ne.offsetY;
    if (typeof lx !== 'number' || typeof ly !== 'number' || !Number.isFinite(lx) || !Number.isFinite(ly)) return null;
    const x = (lx / size) * (2 * VIEW) - VIEW;
    const y = -((ly / size) * (2 * VIEW) - VIEW);
    return segmentName(scoreFromCoords(x, y));
  };

  const handlers = {
    onStartShouldSetResponder: () => true,
    onResponderTerminationRequest: () => true,
    onResponderRelease: (e: GestureResponderEvent) => {
      const k = keyAt(e);
      onSelect(k === null || k === selected ? null : k);
    },
    ...(Platform.OS === 'web'
      ? {
          onPointerMove: (e: PointerEvent) => {
            if (e.nativeEvent.pointerType !== 'mouse') return;
            const k = keyAt(e);
            if (k !== selected) onSelect(k);
          },
          onPointerLeave: (e: PointerEvent) => {
            if (e.nativeEvent.pointerType === 'mouse') onSelect(null);
          },
        }
      : {}),
  };

  const shareOf = (key: string) => (total > 0 ? (counts[key] ?? 0) / total : 0);
  const outlined = selected && selected !== 'MISS' ? FIELDS.filter((f) => f.key === selected) : [];

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`${-VIEW} ${-VIEW} ${2 * VIEW} ${2 * VIEW}`}>
        <BoardBase />
        {display === 'fields' ? (
          <G>
            {FIELDS.map((f, i) => {
              const a = heatAlpha(shareOf(f.key), maxShare);
              return a > 0 ? <Path key={`${f.key}-${i}`} d={f.d} fill={color} fillOpacity={a} /> : null;
            })}
            {heatAlpha(shareOf('S25'), maxShare) > 0 ? (
              <Circle r={BOARD.bullRadius} fill={color} fillOpacity={heatAlpha(shareOf('S25'), maxShare)} />
            ) : null}
            <Circle r={BOARD.doubleBullRadius} fill="#2c3846" />
            {heatAlpha(shareOf('D25'), maxShare) > 0 ? (
              <Circle r={BOARD.doubleBullRadius} fill={color} fillOpacity={heatAlpha(shareOf('D25'), maxShare)} />
            ) : null}
          </G>
        ) : (
          <G>
            {(positions ?? []).map(([x, y], i) =>
              Math.abs(x) < VIEW && Math.abs(y) < VIEW ? <Circle key={i} cx={x} cy={-y} r={3.6} fill={color} fillOpacity={0.6} /> : null,
            )}
          </G>
        )}
        {outlined.map((f, i) => (
          <Path key={`sel-${i}`} d={f.d} fill="none" stroke={colors.text} strokeWidth={2.5} strokeLinejoin="round" />
        ))}
        {selected === 'S25' ? <Circle r={BOARD.bullRadius} fill="none" stroke={colors.text} strokeWidth={2.5} /> : null}
        {selected === 'D25' ? <Circle r={BOARD.doubleBullRadius} fill="none" stroke={colors.text} strokeWidth={2.5} /> : null}
      </Svg>
      <View
        {...handlers}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Trefferbild ${label} – Feld antippen für Details`}
        style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, borderRadius: size / 2 }}
      />
    </View>
  );
}

/** Scale legend for the heat map: rarely … often (0 % … max %). */
export function HeatScale({ color, maxShare, label }: { color: string; maxShare: number; label?: string }) {
  const id = `hs${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const stops = [0, 0.1, 0.25, 0.5, 0.75, 1];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {label ? <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '600' }}>{label}</Text> : null}
      <Text style={{ color: colors.faint, fontSize: 11 }}>0 %</Text>
      <Svg width={90} height={8}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            {stops.map((s) => (
              <Stop key={s} offset={String(s)} stopColor={color} stopOpacity={s === 0 ? 0 : heatAlpha(s, 1)} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={90} height={8} rx={4} fill="#1d2631" />
        <Rect x={0} y={0} width={90} height={8} rx={4} fill={`url(#${id})`} />
      </Svg>
      <Text style={{ color: colors.faint, fontSize: 11 }}>{`${(maxShare * 100).toFixed(1).replace('.', ',')} %`}</Text>
    </View>
  );
}

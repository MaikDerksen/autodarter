/**
 * Small chart kit drawn with react-native-svg (works on web, iOS and Android).
 *
 * Colour roles (validated for the dark surface #131a22 with the dataviz palette checker):
 * series 1 = you (blue), series 2 = the friend you compare with (orange).
 * Text never wears a series colour – identity comes from the line key / dot beside it.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import {
  Platform,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PointerEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { colors } from '@/lib/theme';

export const SERIES_COLORS = { me: '#3987e5', friend: '#d95926' } as const;

export const chartInk = {
  grid: '#1f2833',
  axis: '#2d3946',
  label: colors.muted,
  surface: colors.surface,
  crosshair: '#4b5868',
};

export interface SeriesInfo {
  key: string;
  label: string;
  color: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Measure the width the chart may use. */
export function useMeasuredWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.floor(e.nativeEvent.layout.width);
    setWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev));
  }, []);
  return [width, onLayout];
}

/** Clean axis ticks between lo and hi. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) {
    const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function eventX(e: GestureResponderEvent | PointerEvent): number | null {
  const ne = e.nativeEvent as { locationX?: number; offsetX?: number };
  const x = Number.isFinite(ne.locationX) ? ne.locationX : ne.offsetX;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function eventXY(e: GestureResponderEvent | PointerEvent): { x: number; y: number } | null {
  const ne = e.nativeEvent as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
  const x = Number.isFinite(ne.locationX) ? ne.locationX : ne.offsetX;
  const y = Number.isFinite(ne.locationY) ? ne.locationY : ne.offsetY;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Touch / mouse layer for a plot: tap or drag selects, a second tap on the same
 * spot clears; on the web the mouse hover selects too. Vertical scrolling still
 * wins over the chart (the responder may be taken away).
 */
export function usePointerLayer<T>(resolve: (pos: { x: number; y: number }) => T | null, equals: (a: T, b: T) => boolean = Object.is) {
  const [selected, setSelected] = useState<T | null>(null);
  const atGrant = useRef<T | null>(null);
  const moved = useRef(false);

  const pick = (e: GestureResponderEvent | PointerEvent): T | null => {
    const xy = eventXY(e);
    if (xy) return resolve(xy);
    const x = eventX(e);
    return x === null ? null : resolve({ x, y: 0 });
  };

  const handlers = {
    onStartShouldSetResponder: () => true,
    onResponderTerminationRequest: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      moved.current = false;
      atGrant.current = selected;
      const v = pick(e);
      setSelected(v);
    },
    onResponderMove: (e: GestureResponderEvent) => {
      moved.current = true;
      const v = pick(e);
      if (v !== null) setSelected(v);
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      const v = pick(e);
      if (!moved.current && v !== null && atGrant.current !== null && equals(v, atGrant.current)) setSelected(null);
    },
    ...(Platform.OS === 'web'
      ? {
          onPointerMove: (e: PointerEvent) => {
            if (e.nativeEvent.pointerType !== 'mouse') return;
            const v = pick(e);
            if (v !== null) setSelected(v);
          },
          onPointerLeave: (e: PointerEvent) => {
            if (e.nativeEvent.pointerType === 'mouse') setSelected(null);
          },
        }
      : {}),
  };
  return { selected, setSelected, handlers };
}

const svgId = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]/g, '');

// ---------------------------------------------------------------------------
// Legend & readout row
// ---------------------------------------------------------------------------

export function LegendKey({ color, kind = 'line' }: { color: string; kind?: 'line' | 'rect' | 'dot' }) {
  if (kind === 'dot') return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
  if (kind === 'rect') return <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />;
  return <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: color }} />;
}

export function Legend({ series, kind = 'line', style }: { series: SeriesInfo[]; kind?: 'line' | 'rect' | 'dot'; style?: StyleProp<ViewStyle> }) {
  if (series.length < 2) return null;
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center' }, style]}>
      {series.map((s) => (
        <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <LegendKey color={s.color} kind={kind} />
          <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600' }}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Fixed-height row above a plot: legend, or the values at the selected position. */
function Readout({
  title,
  items,
  series,
  hint,
  kind,
}: {
  title: string | null;
  items: (string | null)[] | null;
  series: SeriesInfo[];
  hint: string;
  kind: 'line' | 'rect';
}) {
  // fixed height (two lines when comparing), so selecting never shifts the plot under the finger
  return (
    <View
      style={{
        height: series.length > 1 ? 40 : 22,
        flexDirection: 'row',
        alignItems: 'center',
        alignContent: 'center',
        flexWrap: 'wrap',
        columnGap: 12,
        rowGap: 2,
        overflow: 'hidden',
      }}
    >
      {title !== null && items ? (
        <>
          <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700' }}>{title}</Text>
          {series.map((s, i) => (
            <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
              <LegendKey color={s.color} kind={kind} />
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '800' }}>{items[i] ?? '–'}</Text>
              {series.length > 1 ? (
                <Text style={{ color: colors.muted, fontSize: 12, maxWidth: 110, flexShrink: 1 }} numberOfLines={1}>
                  {s.label}
                </Text>
              ) : null}
            </View>
          ))}
        </>
      ) : series.length > 1 ? (
        <Legend series={series} kind={kind} />
      ) : (
        <Text style={{ color: colors.faint, fontSize: 12 }}>{hint}</Text>
      )}
    </View>
  );
}

const HINT = Platform.OS === 'web' ? 'Zeigen oder tippen für Werte' : 'Tippen für Werte';

// ---------------------------------------------------------------------------
// Line chart (one axis, optional second series)
// ---------------------------------------------------------------------------

export interface LineSeries extends SeriesInfo {
  points: { x: number; y: number }[];
}

export function LineChart({
  series,
  height = 170,
  formatX,
  formatY,
  formatTick,
  yMin,
  yMax,
  emptyText = 'Noch keine Daten',
}: {
  series: LineSeries[];
  height?: number;
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  formatTick?: (y: number) => string;
  /** fixed lower / upper bound of the y axis (otherwise from the data) */
  yMin?: number;
  yMax?: number;
  emptyText?: string;
}) {
  const [width, onLayout] = useMeasuredWidth();
  const gradientId = svgId(`lg${useId()}`);
  const visible = series.filter((s) => s.points.length > 0);

  const geo = (() => {
    const all = visible.flatMap((s) => s.points);
    if (!all.length || width <= 0) return null;
    const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
    let x0 = xs[0];
    let x1 = xs[xs.length - 1];
    if (x0 === x1) {
      x0 -= 1;
      x1 += 1;
    }
    const ys = all.map((p) => p.y);
    const lo = yMin ?? Math.min(...ys);
    const hi = yMax ?? Math.max(...ys);
    const ticks = niceTicks(yMin ?? lo - (hi - lo) * 0.08, yMax ?? hi + (hi - lo) * 0.08, 4);
    const t0 = yMin ?? ticks[0];
    const t1 = yMax ?? ticks[ticks.length - 1];
    const padTop = 8;
    const padBottom = 22;
    const padRight = 38;
    const inset = 6;
    const plotW = Math.max(10, width - padRight);
    const plotH = height - padTop - padBottom;
    const sx = (x: number) => inset + ((x - x0) / (x1 - x0)) * (plotW - 2 * inset);
    const sy = (y: number) => padTop + (1 - (Math.min(Math.max(y, t0), t1) - t0) / (t1 - t0 || 1)) * plotH;
    return { xs, x0, x1, ticks: ticks.filter((t) => t >= t0 - 1e-9 && t <= t1 + 1e-9), sx, sy, plotW, plotH, padTop, padBottom };
  })();

  const { selected, handlers } = usePointerLayer<number>((p) => {
    if (!geo) return null;
    let best: number | null = null;
    let dist = Infinity;
    for (const x of geo.xs) {
      const d = Math.abs(geo.sx(x) - p.x);
      if (d < dist) {
        dist = d;
        best = x;
      }
    }
    return best;
  });

  const readoutItems =
    selected !== null ? visible.map((s) => s.points.find((p) => p.x === selected)).map((p) => (p ? formatY(p.y) : null)) : null;

  return (
    <View onLayout={onLayout} style={{ gap: 6 }}>
      <Readout
        title={selected !== null ? formatX(selected) : null}
        items={readoutItems}
        series={visible.length ? visible : series}
        hint={HINT}
        kind="line"
      />
      {!visible.length ? (
        <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.faint, fontSize: 13 }}>{emptyText}</Text>
        </View>
      ) : geo ? (
        <View style={{ height }}>
          <Svg width={width} height={height}>
            {visible.length === 1 ? (
              <Defs>
                <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={visible[0].color} stopOpacity={0.22} />
                  <Stop offset="1" stopColor={visible[0].color} stopOpacity={0.01} />
                </LinearGradient>
              </Defs>
            ) : null}
            {geo.ticks.map((t) => (
              <G key={t}>
                <Line x1={0} x2={geo.plotW} y1={geo.sy(t)} y2={geo.sy(t)} stroke={chartInk.grid} strokeWidth={1} />
                <SvgText x={width - 2} y={geo.sy(t) + 4} fontSize={10} fill={chartInk.label} textAnchor="end">
                  {(formatTick ?? formatY)(t)}
                </SvgText>
              </G>
            ))}
            {/* x labels: first / last (and middle when there is room) */}
            {(() => {
              const labels: { x: number; anchor: 'start' | 'middle' | 'end' }[] = [{ x: geo.xs[0], anchor: 'start' }];
              if (geo.xs.length > 1) labels.push({ x: geo.xs[geo.xs.length - 1], anchor: 'end' });
              if (geo.xs.length > 2 && geo.plotW > 320) labels.push({ x: (geo.x0 + geo.x1) / 2, anchor: 'middle' });
              return labels.map((l) => (
                <SvgText
                  key={`${l.anchor}${l.x}`}
                  x={l.anchor === 'start' ? 2 : l.anchor === 'end' ? geo.plotW - 2 : geo.sx(l.x)}
                  y={height - 6}
                  fontSize={10}
                  fill={chartInk.label}
                  textAnchor={l.anchor}
                >
                  {formatX(Math.round(l.x))}
                </SvgText>
              ));
            })()}
            {visible.map((s) => {
              const pts = s.points;
              const d = pts.map((p, i) => `${i ? 'L' : 'M'}${geo.sx(p.x).toFixed(1)} ${geo.sy(p.y).toFixed(1)}`).join('');
              const bottom = geo.padTop + geo.plotH;
              const area =
                visible.length === 1 && pts.length > 1
                  ? `${d}L${geo.sx(pts[pts.length - 1].x).toFixed(1)} ${bottom}L${geo.sx(pts[0].x).toFixed(1)} ${bottom}Z`
                  : null;
              const showMarkers = pts.length <= 14;
              const last = pts[pts.length - 1];
              return (
                <G key={s.key}>
                  {area ? <Path d={area} fill={`url(#${gradientId})`} /> : null}
                  {pts.length > 1 ? (
                    <Path d={d} stroke={s.color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                  ) : null}
                  {(showMarkers ? pts : [last]).map((p) => (
                    <Circle key={p.x} cx={geo.sx(p.x)} cy={geo.sy(p.y)} r={4} fill={s.color} stroke={chartInk.surface} strokeWidth={2} />
                  ))}
                </G>
              );
            })}
            {selected !== null ? (
              <G>
                <Line
                  x1={geo.sx(selected)}
                  x2={geo.sx(selected)}
                  y1={geo.padTop}
                  y2={geo.padTop + geo.plotH}
                  stroke={chartInk.crosshair}
                  strokeWidth={1}
                />
                {visible.map((s) => {
                  const p = s.points.find((q) => q.x === selected);
                  return p ? (
                    <Circle key={s.key} cx={geo.sx(p.x)} cy={geo.sy(p.y)} r={5.5} fill={s.color} stroke={chartInk.surface} strokeWidth={2} />
                  ) : null;
                })}
              </G>
            ) : null}
          </Svg>
          <View
            {...handlers}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Diagramm – antippen, um Werte abzulesen"
            style={{ position: 'absolute', left: 0, top: 0, width: geo.plotW, height } as ViewStyle}
          />
        </View>
      ) : (
        <View style={{ height }} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Column chart (categories on x, grouped when comparing)
// ---------------------------------------------------------------------------

export interface ColumnSeries extends SeriesInfo {
  values: number[];
}

function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x} ${y + h}L${x} ${y + r}Q${x} ${y} ${x + r} ${y}L${x + w - r} ${y}Q${x + w} ${y} ${x + w} ${y + r}L${x + w} ${y + h}Z`;
}

export function ColumnChart({
  categories,
  series,
  height = 150,
  formatValue,
  formatTick,
  categoryTitle,
  labelMax = true,
}: {
  categories: string[];
  series: ColumnSeries[];
  height?: number;
  formatValue: (v: number) => string;
  formatTick?: (v: number) => string;
  /** readout title for a category, e.g. "60–79 Punkte" */
  categoryTitle?: (i: number) => string;
  /** label the highest column (single series only) */
  labelMax?: boolean;
}) {
  const [width, onLayout] = useMeasuredWidth();
  const n = categories.length;
  const k = Math.max(1, series.length);
  const padTop = 16;
  const padBottom = 20;
  const padRight = 34;
  const plotW = Math.max(10, width - padRight);
  const plotH = height - padTop - padBottom;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(0, max || 1, 3);
  const top = ticks[ticks.length - 1] || 1;
  const band = plotW / Math.max(1, n);
  const barW = Math.max(2, Math.min(24, (band * 0.72 - (k - 1) * 2) / k));
  const groupW = barW * k + (k - 1) * 2;
  const sy = (v: number) => padTop + (1 - v / top) * plotH;
  const every = Math.max(1, Math.ceil(26 / band));

  const { selected, handlers } = usePointerLayer<number>((p) => {
    if (width <= 0 || !n) return null;
    return Math.max(0, Math.min(n - 1, Math.floor(p.x / band)));
  });

  const maxIdx = series.length === 1 && labelMax && max > 0 ? series[0].values.indexOf(max) : -1;

  return (
    <View onLayout={onLayout} style={{ gap: 6 }}>
      <Readout
        title={selected !== null ? (categoryTitle ? categoryTitle(selected) : categories[selected]) : null}
        items={selected !== null ? series.map((s) => formatValue(s.values[selected] ?? 0)) : null}
        series={series}
        hint={HINT}
        kind="rect"
      />
      <View style={{ height }}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            {ticks.map((t) => (
              <G key={t}>
                <Line x1={0} x2={plotW} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? chartInk.axis : chartInk.grid} strokeWidth={1} />
                {t > 0 ? (
                  <SvgText x={width - 2} y={sy(t) + 4} fontSize={10} fill={chartInk.label} textAnchor="end">
                    {(formatTick ?? formatValue)(t)}
                  </SvgText>
                ) : null}
              </G>
            ))}
            {selected !== null ? (
              <Rect x={selected * band + 1} y={padTop - 6} width={band - 2} height={plotH + 6} rx={6} fill="#ffffff" opacity={0.05} />
            ) : null}
            {categories.map((c, i) => {
              const gx = i * band + (band - groupW) / 2;
              const dim = selected !== null && selected !== i;
              return (
                <G key={c} opacity={dim ? 0.45 : 1}>
                  {series.map((s, j) => {
                    const v = s.values[i] ?? 0;
                    if (v <= 0) return null;
                    const y = sy(v);
                    return <Path key={s.key} d={columnPath(gx + j * (barW + 2), y, barW, padTop + plotH - y)} fill={s.color} />;
                  })}
                  {i === maxIdx ? (
                    <SvgText x={gx + barW / 2} y={sy(max) - 5} fontSize={10} fontWeight="700" fill={colors.text} textAnchor="middle">
                      {formatValue(max)}
                    </SvgText>
                  ) : null}
                  {i % every === 0 || i === n - 1 ? (
                    <SvgText x={i * band + band / 2} y={height - 5} fontSize={10} fill={chartInk.label} textAnchor="middle">
                      {c}
                    </SvgText>
                  ) : null}
                </G>
              );
            })}
          </Svg>
        ) : null}
        <View
          {...handlers}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Säulendiagramm – antippen, um Werte abzulesen"
          style={{ position: 'absolute', left: 0, top: 0, width: plotW, height } as ViewStyle}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Meter list: one row per item, a thin bar per series, figures on the right
// ---------------------------------------------------------------------------

export interface MeterRow {
  key: string;
  label: string;
  /** 0 … 1 per series (null = no data) */
  values: (number | null)[];
  /** text per series, e.g. "34 % · 12/35" */
  figures: string[];
}

export function MeterList({ rows, series, labelWidth = 56 }: { rows: MeterRow[]; series: SeriesInfo[]; labelWidth?: number }) {
  const thick = series.length > 1 ? 6 : 8;
  return (
    <View style={{ gap: series.length > 1 ? 12 : 10 }}>
      {rows.map((r) => (
        <View key={r.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessible accessibilityLabel={`${r.label}: ${r.figures.join(', ')}`}>
          <Text style={{ width: labelWidth, color: colors.text, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
            {r.label}
          </Text>
          <View style={{ flex: 1, gap: 3 }}>
            {series.map((s, i) => {
              const v = r.values[i];
              return (
                <View key={s.key} style={{ height: thick, borderRadius: thick / 2, backgroundColor: `${s.color}26`, overflow: 'hidden' }}>
                  {v !== null && v !== undefined && v > 0 ? (
                    <View
                      style={{
                        width: `${Math.max(2, Math.min(100, v * 100))}%`,
                        height: thick,
                        borderRadius: thick / 2,
                        backgroundColor: s.color,
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
          <View style={{ minWidth: 76, alignItems: 'flex-end', gap: series.length > 1 ? 0 : 2 }}>
            {series.map((s, i) => (
              <Text
                key={s.key}
                style={{
                  color: i === 0 ? colors.text : colors.muted,
                  fontSize: series.length > 1 ? 12 : 13,
                  fontWeight: i === 0 ? '700' : '600',
                  fontVariant: ['tabular-nums'],
                }}
              >
                {r.figures[i] ?? '–'}
              </Text>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rings (meter on a circle, Apple-Activity style), one ring per series
// ---------------------------------------------------------------------------

export function Rings({
  size,
  stroke = 14,
  rings,
  children,
}: {
  size: number;
  stroke?: number;
  rings: { key: string; value: number | null; color: string }[];
  children?: ReactNode;
}) {
  const c = size / 2;
  const gap = 4;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
        {rings.map((r, i) => {
          const radius = c - stroke / 2 - i * (stroke + gap);
          if (radius <= stroke / 2) return null;
          const len = 2 * Math.PI * radius;
          const v = r.value === null ? 0 : Math.max(0, Math.min(1, r.value));
          return (
            <G key={r.key}>
              <Circle cx={c} cy={c} r={radius} stroke={r.color} strokeOpacity={0.2} strokeWidth={stroke} fill="none" />
              {v > 0 ? (
                <Circle
                  cx={c}
                  cy={c}
                  r={radius}
                  stroke={r.color}
                  strokeWidth={stroke}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(0.001, v * len)} ${len}`}
                  transform={`rotate(-90 ${c} ${c})`}
                />
              ) : null}
            </G>
          );
        })}
      </Svg>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sparkline (stat tiles)
// ---------------------------------------------------------------------------

export function Sparkline({ values, width = 84, height = 26, color }: { values: number[]; width?: number; height?: number; color: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const sx = (i: number) => 3 + (i / (values.length - 1)) * (width - 6);
  const sy = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join('');
  const last = values[values.length - 1];
  return (
    <Svg width={width} height={height}>
      <Path d={d} stroke={chartInk.crosshair} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={sx(values.length - 1)} cy={sy(last)} r={3} fill={color} />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Split bar (wins / losses) – thin segmented bar, no text
// ---------------------------------------------------------------------------

export function SplitBar({ parts, height = 6 }: { parts: { key: string; value: number; color: string }[]; height?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return <View style={{ height, borderRadius: height / 2, backgroundColor: chartInk.grid }} />;
  return (
    <View style={{ flexDirection: 'row', height, gap: 2 }}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <View key={p.key} style={{ flex: p.value, height, borderRadius: height / 2, backgroundColor: p.color }} />
        ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Table view (the accessible twin of every chart)
// ---------------------------------------------------------------------------

export function DataTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: chartInk.grid, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', backgroundColor: colors.bg, paddingHorizontal: 10, paddingVertical: 7 }}>
        {columns.map((c, i) => (
          <Text
            key={c}
            style={{ flex: i === 0 ? 1.4 : 1, color: colors.muted, fontSize: 11, fontWeight: '700', textAlign: i === 0 ? 'left' : 'right' }}
          >
            {c}
          </Text>
        ))}
      </View>
      {rows.map((r, ri) => (
        <View
          key={`${r[0]}-${ri}`}
          style={{ flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: chartInk.grid }}
        >
          {r.map((cell, i) => (
            <Text
              key={`${i}`}
              style={{
                flex: i === 0 ? 1.4 : 1,
                color: i === 0 ? colors.muted : colors.text,
                fontSize: 13,
                fontWeight: i === 0 ? '600' : '700',
                textAlign: i === 0 ? 'left' : 'right',
                fontVariant: ['tabular-nums'],
              }}
            >
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/** Sections of the statistics page. Every section compares "you" with an optional friend. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { GameMode } from '@shared';
import {
  ColumnChart,
  LegendKey,
  LineChart,
  MeterList,
  Rings,
  SERIES_COLORS,
  SplitBar,
  chartInk,
  useMeasuredWidth,
  type LineSeries,
  type MeterRow,
  type SeriesInfo,
} from '@/components/charts';
import { HeatBoard, HeatScale } from '@/components/HeatBoard';
import { ChartCard, Grid, Kpi, KpiGrid, Pills, SectionHeader, kit, type Metric } from '@/components/StatsKit';
import { Badge, Card } from '@/components/ui';
import {
  MODE_LABEL,
  MODE_SHORT,
  dateLabel,
  dayLabel,
  metrics,
  num,
  pct,
  perDay,
  share,
  type DayPoint,
  type StatsResponse,
} from '@/lib/stats';
import { colors, radius } from '@/lib/theme';

export interface StatsCtx {
  me: StatsResponse;
  friend: StatsResponse | null;
  /** [you] or [you, friend] */
  series: SeriesInfo[];
  wide: boolean;
}

const ME = SERIES_COLORS.me;
const FR = SERIES_COLORS.friend;
const DOTS: [string, string] = [ME, FR];
const MODES: GameMode[] = ['x01', 'cricket', 'atc'];
const total = (list: number[]) => list.reduce((a, b) => a + b, 0);

/** Headline numbers: yours, plus the friend's next to it when comparing. */
function pairMetrics(ctx: StatsCtx, mine: string, theirs: string | undefined, unit?: string): Metric[] {
  if (!ctx.friend) return [{ key: 'me', value: mine, unit }];
  return [
    { key: 'me', value: mine, unit: mine === '–' ? undefined : unit, color: ME, label: 'Du' },
    { key: 'friend', value: theirs ?? '–', unit: theirs && theirs !== '–' ? unit : undefined, color: FR, label: ctx.friend.user.displayName },
  ];
}

/** Line series for you / the friend. */
function lines(ctx: StatsCtx, mine: DayPoint[], theirs: DayPoint[]): LineSeries[] {
  return ctx.series.map((s, i) => ({ ...s, points: i === 0 ? mine : theirs }));
}

/** Table twin of a day-based line chart. */
function dayTable(ctx: StatsCtx, mine: DayPoint[], theirs: DayPoint[], fmt: (v: number) => string) {
  const days = [...new Set([...mine, ...theirs].map((p) => p.x))].sort((a, b) => b - a);
  return {
    columns: ['Tag', ...ctx.series.map((s) => s.label)],
    rows: days.map((d) => [
      dayLabel(d),
      ...ctx.series.map((_, i) => {
        const p = (i === 0 ? mine : theirs).find((q) => q.x === d);
        return p ? fmt(p.y) : '–';
      }),
    ]),
  };
}

function rangeCaption(d: StatsResponse): string {
  if (d.since) return `Seit ${dateLabel(d.since)}`;
  return d.overview.firstMatchAt ? `Alle Spiele seit ${dateLabel(d.overview.firstMatchAt)}` : 'Alle Spiele';
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------

export function OverviewSection({ ctx }: { ctx: StatsCtx }) {
  const o = ctx.me.overview;
  const fo = ctx.friend?.overview;
  const f = (fn: (v: NonNullable<typeof fo>) => string) => (fo ? fn(fo) : undefined);
  const showRing = o.versus > 0 || (fo?.versus ?? 0) > 0;
  const ringSize = ctx.wide ? 184 : 164;
  const h2h = ctx.friend ? ctx.me.headToHead.find((h) => h.userId === ctx.friend!.user.id) : undefined;

  const modeRows: MeterRow[] = MODES.filter((m) => o.modes[m] > 0 || (fo?.modes[m] ?? 0) > 0).map((m) => ({
    key: m,
    label: MODE_SHORT[m],
    values: [o.matches ? o.modes[m] / o.matches : null, ...(fo ? [fo.matches ? fo.modes[m] / fo.matches : null] : [])],
    figures: [`${num(o.modes[m])} ${o.modes[m] === 1 ? 'Spiel' : 'Spiele'}`, ...(fo ? [`${num(fo.modes[m])} ${fo.modes[m] === 1 ? 'Spiel' : 'Spiele'}`] : [])],
  }));

  return (
    <View style={{ gap: 12 }}>
      <SectionHeader title="Übersicht" caption={rangeCaption(ctx.me)} icon="sparkles-outline" />
      <Card style={{ padding: 18, gap: 20 }}>
        <View style={{ flexDirection: ctx.wide ? 'row' : 'column', gap: 22, alignItems: ctx.wide ? 'center' : 'stretch' }}>
          {showRing ? (
            <View style={{ alignItems: 'center', gap: 12, paddingHorizontal: ctx.wide ? 8 : 0 }}>
              <Rings
                size={ringSize}
                stroke={fo ? 14 : 18}
                rings={[
                  { key: 'me', value: o.versus ? o.winRate / 100 : 0, color: ME },
                  ...(fo ? [{ key: 'friend', value: fo.versus ? fo.winRate / 100 : 0, color: FR }] : []),
                ]}
              >
                <Text style={{ color: colors.text, fontSize: fo ? 30 : 40, fontWeight: '800', letterSpacing: -1 }}>
                  {o.versus ? pct(o.winRate) : '–'}
                </Text>
                <Text style={kit.caption}>Siegquote</Text>
              </Rings>
              {fo ? (
                <View style={{ flexDirection: 'row', gap: 16 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <LegendKey color={ME} kind="dot" />
                    <Text style={{ color: colors.text, fontWeight: '800' }}>{o.versus ? pct(o.winRate) : '–'}</Text>
                    <Text style={kit.caption}>Du</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <LegendKey color={FR} kind="dot" />
                    <Text style={{ color: colors.text, fontWeight: '800' }}>{fo.versus ? pct(fo.winRate) : '–'}</Text>
                    <Text style={kit.caption} numberOfLines={1}>
                      {ctx.friend?.user.displayName}
                    </Text>
                  </View>
                </View>
              ) : (
                <Text style={kit.caption}>
                  {o.wins} von {o.versus} Spielen gegen andere gewonnen
                </Text>
              )}
            </View>
          ) : null}
          <View style={ctx.wide ? { flex: 1 } : undefined}>
            <KpiGrid min={ctx.wide ? 150 : 138}>
              <Kpi
                label="Spiele"
                value={num(o.matches)}
                sub={`${o.activeDays} ${o.activeDays === 1 ? 'Spieltag' : 'Spieltage'}`}
                friend={f((x) => num(x.matches))}
                colorsFor={DOTS}
              />
              <Kpi label="Siege" value={num(o.wins)} sub={`${o.losses} Niederlagen`} friend={f((x) => num(x.wins))} colorsFor={DOTS} />
              <Kpi label="Darts geworfen" value={num(o.dartsThrown)} friend={f((x) => num(x.dartsThrown))} colorsFor={DOTS} />
              <Kpi label="Legs gewonnen" value={num(o.legsWon)} sub={`von ${num(o.legsPlayed)}`} friend={f((x) => num(x.legsWon))} colorsFor={DOTS} />
              <Kpi
                label="Spieltage in Folge"
                value={num(o.currentStreak)}
                sub={`Rekord ${o.longestStreak}`}
                friend={f((x) => num(x.currentStreak))}
                colorsFor={DOTS}
              />
              <Kpi
                label="Siege in Folge"
                value={num(o.winStreak)}
                sub={`Rekord ${o.bestWinStreak}`}
                friend={f((x) => num(x.winStreak))}
                colorsFor={DOTS}
              />
            </KpiGrid>
          </View>
        </View>
        {modeRows.length ? (
          <View style={{ gap: 10 }}>
            <Text style={kit.cardTitle}>Spielmodi</Text>
            <MeterList rows={modeRows} series={ctx.series} labelWidth={64} />
          </View>
        ) : null}
        {h2h && ctx.friend ? (
          <View style={{ gap: 10, backgroundColor: colors.bg, borderRadius: radius.md, padding: 14 }}>
            <Text style={kit.cardTitle}>Direkter Vergleich</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <LegendKey color={ME} kind="dot" />
                <Text style={{ color: colors.text, fontWeight: '700' }}>Du</Text>
              </View>
              <Text style={{ color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
                {h2h.wins} : {h2h.losses}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>
                  {ctx.friend.user.displayName}
                </Text>
                <LegendKey color={FR} kind="dot" />
              </View>
            </View>
            <SplitBar
              parts={[
                { key: 'w', value: h2h.wins, color: ME },
                { key: 'o', value: h2h.matches - h2h.wins - h2h.losses, color: chartInk.axis },
                { key: 'l', value: h2h.losses, color: FR },
              ]}
            />
            <Text style={kit.caption}>
              {h2h.matches} gemeinsame {h2h.matches === 1 ? 'Spiel' : 'Spiele'} · zuletzt {dateLabel(h2h.lastPlayedAt)}
            </Text>
          </View>
        ) : null}
      </Card>
    </View>
  );
}

// ---------------------------------------------------------------------------
// X01
// ---------------------------------------------------------------------------

type X01Metric = 'average' | 'first9' | 'checkoutRate';

const SCORE_CATS = ['0', '20', '40', '60', '80', '100', '120', '140', '160', '180'];
const scoreTitle = (i: number) => (i === 9 ? '180' : `${i * 20}–${i * 20 + 19} Punkte`);

export function X01Section({ ctx }: { ctx: StatsCtx }) {
  const [metric, setMetric] = useState<X01Metric>('average');
  const [allDoubles, setAllDoubles] = useState(false);
  const x = ctx.me.x01;
  const fx = ctx.friend?.x01 ?? null;
  if (!x && !fx) return null;
  const cmp = !!ctx.friend;
  const ff = (fn: (b: NonNullable<typeof fx>) => string) => (cmp ? (fx ? fn(fx) : '–') : undefined);

  // trend
  const fmtMetric = (v: number) => (metric === 'checkoutRate' ? `${num(v, 1)} %` : num(v, 1));
  const mine = perDay(x?.series ?? [], metrics[metric]);
  const theirs = perDay(fx?.series ?? [], metrics[metric]);
  const periodValue = (b: typeof x) =>
    !b ? '–' : metric === 'average' ? num(b.stats.average, 2) : metric === 'first9' ? num(b.stats.first9Average, 2) : num(b.stats.checkoutRate, 1);
  const avgTrend = perDay(x?.series ?? [], metrics.average)
    .slice(-12)
    .map((p) => p.y);

  // score distribution (share of turns)
  const dist = (b: typeof x) => {
    const t = b ? total(b.scoreBuckets) : 0;
    return b ? b.scoreBuckets.map((v) => share(v, t)) : SCORE_CATS.map(() => 0);
  };
  const tonPlus = (b: typeof x) => (b ? share(total(b.scoreBuckets.slice(5)), total(b.scoreBuckets)) : null);

  // doubles
  const targets = [...new Set([...(x?.doubles ?? []), ...(fx?.doubles ?? [])].map((d) => d.target))];
  const findD = (b: typeof x, t: string) => b?.doubles.find((d) => d.target === t);
  targets.sort((a, b) => (findD(x, b)?.attempts ?? 0) - (findD(x, a)?.attempts ?? 0) || (findD(fx, b)?.attempts ?? 0) - (findD(fx, a)?.attempts ?? 0));
  const doubleRows: MeterRow[] = targets.slice(0, allDoubles ? targets.length : 8).map((t) => {
    const cells = [findD(x, t), ...(cmp ? [findD(fx, t)] : [])];
    return {
      key: t,
      label: t === 'BULL' ? 'Bull' : t,
      values: cells.map((c) => (c && c.attempts ? c.hits / c.attempts : null)),
      figures: cells.map((c) => (c && c.attempts ? `${pct((c.hits / c.attempts) * 100)} · ${c.hits}/${c.attempts}` : '–')),
    };
  });

  // checkouts
  const avgCheckout = (b: typeof x) => {
    if (!b) return null;
    const n = total(b.checkouts.map((c) => c.count));
    return n ? total(b.checkouts.map((c) => c.value * c.count)) / n : null;
  };

  return (
    <View style={{ gap: 12 }}>
      <SectionHeader
        title="X01"
        icon="radio-button-on-outline"
        caption={x ? `${x.matches} ${x.matches === 1 ? 'Spiel' : 'Spiele'} · ${x.stats.legsWon} ${x.stats.legsWon === 1 ? 'Leg' : 'Legs'} gewonnen` : 'Noch keine eigenen X01-Spiele'}
      />
      <Card style={{ padding: 18, gap: 14 }}>
        <Text style={kit.cardTitle}>Kennzahlen & Rekorde</Text>
        <KpiGrid min={ctx.wide ? 150 : 138}>
          <Kpi
            label="3-Dart-Average"
            value={x ? num(x.stats.average, 2) : '–'}
            friend={ff((b) => num(b.stats.average, 2))}
            colorsFor={DOTS}
            trend={avgTrend.length > 1 ? { values: avgTrend, color: ME } : undefined}
          />
          <Kpi label="First-9-Average" value={x ? num(x.stats.first9Average, 2) : '–'} friend={ff((b) => num(b.stats.first9Average, 2))} colorsFor={DOTS} />
          <Kpi
            label="Checkout-Quote"
            value={x ? pct(x.stats.checkoutRate, 1) : '–'}
            sub={x ? `${x.stats.checkouts} / ${x.stats.dartsAtDouble} Darts` : undefined}
            friend={ff((b) => pct(b.stats.checkoutRate, 1))}
            colorsFor={DOTS}
          />
          <Kpi label="Höchster Checkout" value={x?.stats.highestCheckout ? String(x.stats.highestCheckout) : '–'} friend={ff((b) => (b.stats.highestCheckout ? String(b.stats.highestCheckout) : '–'))} colorsFor={DOTS} />
          <Kpi label="Höchste Aufnahme" value={x?.stats.highestTurn ? String(x.stats.highestTurn) : '–'} friend={ff((b) => (b.stats.highestTurn ? String(b.stats.highestTurn) : '–'))} colorsFor={DOTS} />
          <Kpi label="180er" value={num(x?.stats.t180 ?? 0)} friend={ff((b) => num(b.stats.t180))} colorsFor={DOTS} />
          <Kpi label="140+" value={num(x?.stats.t140 ?? 0)} friend={ff((b) => num(b.stats.t140))} colorsFor={DOTS} />
          <Kpi label="100+" value={num(x?.stats.t100 ?? 0)} friend={ff((b) => num(b.stats.t100))} colorsFor={DOTS} />
          <Kpi label="Bestes Leg" value={num(x?.stats.bestLegDarts)} unit="Darts" friend={ff((b) => num(b.stats.bestLegDarts))} colorsFor={DOTS} />
          <Kpi label="Ø Darts pro Leg" value={num(x?.avgLegDarts, 1)} friend={ff((b) => num(b.avgLegDarts, 1))} colorsFor={DOTS} />
          <Kpi label="Bestes Spiel (Ø)" value={num(x?.bestMatchAverage, 2)} friend={ff((b) => num(b.bestMatchAverage, 2))} colorsFor={DOTS} />
          <Kpi
            label="Überworfen"
            value={x && x.turns ? pct(share(x.busts, x.turns), 1) : '–'}
            sub={x ? `${x.busts} von ${num(x.turns)} Aufnahmen` : undefined}
            friend={ff((b) => (b.turns ? pct(share(b.busts, b.turns), 1) : '–'))}
            colorsFor={DOTS}
          />
        </KpiGrid>
      </Card>
      <Grid columns={ctx.wide ? 2 : 1}>
        <ChartCard
          title={metric === 'average' ? '3-Dart-Average' : metric === 'first9' ? 'First-9-Average' : 'Checkout-Quote'}
          metrics={pairMetrics(ctx, periodValue(x), cmp ? periodValue(fx) : undefined, metric === 'checkoutRate' ? '%' : undefined)}
          caption="Verlauf pro Spieltag"
          table={dayTable(ctx, mine, theirs, fmtMetric)}
          right={
            <Pills
              options={[
                { value: 'average', label: 'Average' },
                { value: 'first9', label: 'First 9' },
                { value: 'checkoutRate', label: 'Checkout %' },
              ]}
              value={metric}
              onChange={setMetric}
            />
          }
        >
          <LineChart
            series={lines(ctx, mine, theirs)}
            formatX={(d) => dayLabel(d)}
            formatY={fmtMetric}
            formatTick={(v) => num(v)}
            yMin={metric === 'checkoutRate' ? 0 : undefined}
          />
        </ChartCard>
        <ChartCard
          title="Punkte pro Aufnahme"
          metrics={pairMetrics(ctx, num(tonPlus(x), 1), cmp ? num(tonPlus(fx), 1) : undefined, '% mit 100+')}
          caption={x ? `${num(x.turns)} Aufnahmen · Anteil je Bereich` : 'Anteil je Bereich'}
          table={{
            columns: ['Punkte', ...ctx.series.map((s) => s.label)],
            rows: SCORE_CATS.map((_, i) => [
              i === 9 ? '180' : `${i * 20}–${i * 20 + 19}`,
              pct(dist(x)[i], 1),
              ...(cmp ? [pct(dist(fx)[i], 1)] : []),
            ]),
          }}
        >
          <ColumnChart
            categories={SCORE_CATS}
            series={ctx.series.map((s, i) => ({ ...s, values: i === 0 ? dist(x) : dist(fx) }))}
            formatValue={(v) => `${num(v, v < 10 ? 1 : 0)} %`}
            formatTick={(v) => `${num(v)} %`}
            categoryTitle={scoreTitle}
          />
        </ChartCard>
        <ChartCard
          title="Doppelquote"
          metrics={pairMetrics(ctx, x ? num(x.stats.checkoutRate, 1) : '–', cmp ? (fx ? num(fx.stats.checkoutRate, 1) : '–') : undefined, '%')}
          caption={
            x
              ? `${x.stats.checkouts} Checkouts aus ${num(x.stats.dartsAtDouble)} Darts auf ein Finish-Doppel`
              : 'Darts auf ein Finish-Doppel (Double-Out)'
          }
          table={
            targets.length
              ? {
                  columns: ['Doppel', ...ctx.series.map((s) => s.label)],
                  rows: targets.map((t) => [
                    t === 'BULL' ? 'Bull' : t,
                    ...[findD(x, t), ...(cmp ? [findD(fx, t)] : [])].map((c) =>
                      c && c.attempts ? `${pct((c.hits / c.attempts) * 100)} (${c.hits}/${c.attempts})` : '–',
                    ),
                  ]),
                }
              : null
          }
        >
          {doubleRows.length ? (
            <View style={{ gap: 12 }}>
              <MeterList rows={doubleRows} series={ctx.series} labelWidth={48} />
              {targets.length > 8 ? (
                <Pressable onPress={() => setAllDoubles((v) => !v)} accessibilityRole="button" hitSlop={6}>
                  <Text style={{ color: colors.info, fontWeight: '700', fontSize: 13 }}>
                    {allDoubles ? 'Weniger anzeigen' : `Alle ${targets.length} Doppel anzeigen`}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <Text style={kit.caption}>Noch keine Darts auf ein Finish-Doppel (nur Double-Out-Spiele zählen).</Text>
          )}
        </ChartCard>
        <ChartCard
          title="Checkouts"
          metrics={pairMetrics(
            ctx,
            x?.stats.highestCheckout ? String(x.stats.highestCheckout) : '–',
            cmp ? (fx?.stats.highestCheckout ? String(fx.stats.highestCheckout) : '–') : undefined,
          )}
          caption={`Höchster Checkout · Ø ${num(avgCheckout(x), 1)}${cmp ? ` / ${num(avgCheckout(fx), 1)}` : ''} Punkte pro Checkout`}
          table={{
            columns: ['Checkout', ...ctx.series.map((s) => s.label)],
            rows: [...new Set([...(x?.checkouts ?? []), ...(fx?.checkouts ?? [])].map((c) => c.value))]
              .sort((a, b) => b - a)
              .map((v) => [
                String(v),
                `${x?.checkouts.find((c) => c.value === v)?.count ?? 0}×`,
                ...(cmp ? [`${fx?.checkouts.find((c) => c.value === v)?.count ?? 0}×`] : []),
              ]),
          }}
        >
          <View style={{ gap: 14 }}>
            {ctx.series.map((s, i) => {
              const list = (i === 0 ? x : fx)?.checkouts ?? [];
              return (
                <View key={s.key} style={{ gap: 8 }}>
                  {cmp ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <LegendKey color={s.color} kind="dot" />
                      <Text style={kit.caption}>{s.label}</Text>
                    </View>
                  ) : null}
                  {list.length ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {list.slice(0, 14).map((c) => (
                        <View key={c.value} style={checkoutChip}>
                          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{c.value}</Text>
                          {c.count > 1 ? <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700' }}>×{c.count}</Text> : null}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={kit.caption}>Noch keine Checkouts.</Text>
                  )}
                </View>
              );
            })}
          </View>
        </ChartCard>
      </Grid>
    </View>
  );
}

const checkoutChip = {
  flexDirection: 'row' as const,
  alignItems: 'baseline' as const,
  gap: 3,
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderRadius: 10,
  backgroundColor: colors.bg,
};

// ---------------------------------------------------------------------------
// Cricket
// ---------------------------------------------------------------------------

const MARK_CATS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function CricketSection({ ctx }: { ctx: StatsCtx }) {
  const c = ctx.me.cricket;
  const fc = ctx.friend?.cricket ?? null;
  if (!c && !fc) return null;
  const cmp = !!ctx.friend;
  const ff = (fn: (b: NonNullable<typeof fc>) => string) => (cmp ? (fc ? fn(fc) : '–') : undefined);

  const mine = perDay(c?.series ?? [], metrics.mpr);
  const theirs = perDay(fc?.series ?? [], metrics.mpr);
  const dist = (b: typeof c) => {
    const t = b ? total(b.marksPerTurn) : 0;
    return b ? b.marksPerTurn.map((v) => share(v, t)) : MARK_CATS.map(() => 0);
  };
  const fivePlus = (b: typeof c) => (b ? share(total(b.marksPerTurn.slice(5)), total(b.marksPerTurn)) : null);
  const emptyTurns = (b: typeof c) => (b ? share(b.marksPerTurn[0], total(b.marksPerTurn)) : null);

  const targetShare = (b: typeof c, t: number) => {
    if (!b) return null;
    const all = total(b.targets.map((x) => x.marks));
    return all ? share(b.targets.find((x) => x.target === t)?.marks ?? 0, all) : null;
  };
  const targetList = (c ?? fc)!.targets.map((t) => t.target);
  const maxShare = Math.max(1, ...targetList.flatMap((t) => [targetShare(c, t) ?? 0, targetShare(fc, t) ?? 0]));
  const targetRows: MeterRow[] = targetList.map((t) => {
    const cells = [c, ...(cmp ? [fc] : [])];
    return {
      key: String(t),
      label: t === 25 ? 'Bull' : String(t),
      values: cells.map((b) => {
        const s = targetShare(b, t);
        return s === null ? null : s / maxShare;
      }),
      figures: cells.map((b) => {
        const s = targetShare(b, t);
        return s === null ? '–' : `${pct(s)} · ${b?.targets.find((x) => x.target === t)?.marks ?? 0}`;
      }),
    };
  });

  return (
    <View style={{ gap: 12 }}>
      <SectionHeader
        title="Cricket"
        icon="grid-outline"
        caption={c ? `${c.matches} ${c.matches === 1 ? 'Spiel' : 'Spiele'} · ${c.stats.legsWon} ${c.stats.legsWon === 1 ? 'Leg' : 'Legs'} gewonnen` : 'Noch keine eigenen Cricket-Spiele'}
      />
      <Card style={{ padding: 18, gap: 14 }}>
        <Text style={kit.cardTitle}>Kennzahlen & Rekorde</Text>
        <KpiGrid min={ctx.wide ? 150 : 138}>
          <Kpi
            label="MPR"
            value={c ? num(c.stats.mpr, 2) : '–'}
            sub="Marks pro Runde"
            friend={ff((b) => num(b.stats.mpr, 2))}
            colorsFor={DOTS}
            trend={mine.length > 1 ? { values: mine.slice(-12).map((p) => p.y), color: ME } : undefined}
          />
          <Kpi label="Marks gesamt" value={num(c?.stats.marks ?? 0)} friend={ff((b) => num(b.stats.marks))} colorsFor={DOTS} />
          <Kpi label="Bestes Spiel (MPR)" value={num(c?.bestMatchMpr, 2)} friend={ff((b) => num(b.bestMatchMpr, 2))} colorsFor={DOTS} />
          <Kpi label="Bestes Leg" value={num(c?.stats.bestLegDarts)} unit="Darts" friend={ff((b) => num(b.stats.bestLegDarts))} colorsFor={DOTS} />
          <Kpi label="Runden mit 5+ Marks" value={pct(fivePlus(c), 1)} friend={ff((b) => pct(fivePlus(b), 1))} colorsFor={DOTS} />
          <Kpi label="Runden ohne Mark" value={pct(emptyTurns(c), 1)} friend={ff((b) => pct(emptyTurns(b), 1))} colorsFor={DOTS} />
        </KpiGrid>
      </Card>
      <Grid columns={ctx.wide ? 2 : 1}>
        <ChartCard
          title="MPR"
          metrics={pairMetrics(ctx, c ? num(c.stats.mpr, 2) : '–', cmp ? (fc ? num(fc.stats.mpr, 2) : '–') : undefined)}
          caption="Marks pro Runde · Verlauf pro Spieltag"
          table={dayTable(ctx, mine, theirs, (v) => num(v, 2))}
        >
          <LineChart series={lines(ctx, mine, theirs)} formatX={(d) => dayLabel(d)} formatY={(v) => num(v, 2)} formatTick={(v) => num(v, Number.isInteger(v) ? 0 : 1)} yMin={0} />
        </ChartCard>
        <ChartCard
          title="Marks pro Runde"
          metrics={pairMetrics(ctx, num(fivePlus(c), 1), cmp ? num(fivePlus(fc), 1) : undefined, '% mit 5+')}
          caption={c ? `${num(c.turns)} Runden · Anteil je Anzahl Marks` : 'Anteil je Anzahl Marks'}
          table={{
            columns: ['Marks', ...ctx.series.map((s) => s.label)],
            rows: MARK_CATS.map((m, i) => [m, pct(dist(c)[i], 1), ...(cmp ? [pct(dist(fc)[i], 1)] : [])]),
          }}
        >
          <ColumnChart
            categories={MARK_CATS}
            series={ctx.series.map((s, i) => ({ ...s, values: i === 0 ? dist(c) : dist(fc) }))}
            formatValue={(v) => `${num(v, v < 10 ? 1 : 0)} %`}
            formatTick={(v) => `${num(v)} %`}
            categoryTitle={(i) => `${i} ${i === 1 ? 'Mark' : 'Marks'}`}
          />
        </ChartCard>
        <ChartCard title="Marks je Zahl" caption="Anteil aller Marks auf 20 … 15 und Bull">
          <MeterList rows={targetRows} series={ctx.series} labelWidth={44} />
        </ChartCard>
      </Grid>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Around the Clock
// ---------------------------------------------------------------------------

const ATC_CATS = [...Array.from({ length: 20 }, (_, i) => String(i + 1)), 'B'];

export function AtcSection({ ctx }: { ctx: StatsCtx }) {
  const a = ctx.me.atc;
  const fa = ctx.friend?.atc ?? null;
  if (!a && !fa) return null;
  const cmp = !!ctx.friend;
  const ff = (fn: (b: NonNullable<typeof fa>) => string) => (cmp ? (fa ? fn(fa) : '–') : undefined);

  const dartsMine = perDay(a?.legs ?? [], metrics.legDarts);
  const dartsTheirs = perDay(fa?.legs ?? [], metrics.legDarts);
  const hitMine = perDay(a?.series ?? [], metrics.hitRate);
  const hitTheirs = perDay(fa?.series ?? [], metrics.hitRate);
  const targetRates = (b: typeof a) =>
    ATC_CATS.map((_, i) => {
      const t = b?.targets.find((x) => x.target === (i === 20 ? 25 : i + 1));
      return t && t.attempts ? (t.hits / t.attempts) * 100 : 0;
    });

  return (
    <View style={{ gap: 12 }}>
      <SectionHeader
        title="Around the Clock"
        icon="time-outline"
        caption={a ? `${a.matches} ${a.matches === 1 ? 'Spiel' : 'Spiele'} · ${a.legs.length} komplette Runden` : 'Noch keine eigenen Around-the-Clock-Spiele'}
      />
      <Card style={{ padding: 18, gap: 14 }}>
        <Text style={kit.cardTitle}>Kennzahlen & Rekorde</Text>
        <KpiGrid min={ctx.wide ? 150 : 138}>
          <Kpi label="Bestes Spiel" value={num(a?.bestGame)} unit="Darts" friend={ff((b) => num(b.bestGame))} colorsFor={DOTS} />
          <Kpi
            label="Ø Darts pro Spiel"
            value={num(a?.avgDarts, 1)}
            friend={ff((b) => num(b.avgDarts, 1))}
            colorsFor={DOTS}
            trend={dartsMine.length > 1 ? { values: dartsMine.slice(-12).map((p) => p.y), color: ME } : undefined}
          />
          <Kpi label="Trefferquote" value={a ? pct(a.stats.hitRate, 1) : '–'} friend={ff((b) => pct(b.stats.hitRate, 1))} colorsFor={DOTS} />
          <Kpi label="Treffer" value={num(a?.stats.hits ?? 0)} sub={a ? `bei ${num(a.stats.dartsThrown)} Darts` : undefined} friend={ff((b) => num(b.stats.hits))} colorsFor={DOTS} />
        </KpiGrid>
      </Card>
      <Grid columns={ctx.wide ? 2 : 1}>
        <ChartCard
          title="Darts pro Spiel"
          metrics={pairMetrics(ctx, num(a?.avgDarts, 1), cmp ? num(fa?.avgDarts, 1) : undefined, 'Ø')}
          caption="Weniger ist besser · Ø pro Spieltag"
          table={dayTable(ctx, dartsMine, dartsTheirs, (v) => num(v, 1))}
        >
          <LineChart series={lines(ctx, dartsMine, dartsTheirs)} formatX={(d) => dayLabel(d)} formatY={(v) => num(v, 1)} formatTick={(v) => num(v)} />
        </ChartCard>
        <ChartCard
          title="Trefferquote"
          metrics={pairMetrics(ctx, a ? num(a.stats.hitRate, 1) : '–', cmp ? (fa ? num(fa.stats.hitRate, 1) : '–') : undefined, '%')}
          caption="Treffer auf die Zielzahl · Verlauf pro Spieltag"
          table={dayTable(ctx, hitMine, hitTheirs, (v) => `${num(v, 1)} %`)}
        >
          <LineChart series={lines(ctx, hitMine, hitTheirs)} formatX={(d) => dayLabel(d)} formatY={(v) => `${num(v, 1)} %`} formatTick={(v) => `${num(v)} %`} yMin={0} />
        </ChartCard>
      </Grid>
      <ChartCard
        title="Trefferquote je Zahl"
        caption="Wie oft die Zielzahl getroffen wurde, solange sie dran war"
        table={{
          columns: ['Zahl', ...ctx.series.map((s) => s.label)],
          rows: ATC_CATS.map((label, i) => {
            const cell = (b: typeof a) => {
              const t = b?.targets.find((x) => x.target === (i === 20 ? 25 : i + 1));
              return t && t.attempts ? `${pct((t.hits / t.attempts) * 100)} (${t.hits}/${t.attempts})` : '–';
            };
            return [label === 'B' ? 'Bull' : label, cell(a), ...(cmp ? [cell(fa)] : [])];
          }),
        }}
      >
        <ColumnChart
          categories={ATC_CATS}
          series={ctx.series.map((s, i) => ({ ...s, values: targetRates(i === 0 ? a : fa) }))}
          formatValue={(v) => `${num(v)} %`}
          formatTick={(v) => `${num(v)} %`}
          categoryTitle={(i) => (i === 20 ? 'Bull' : `Zahl ${i + 1}`)}
          labelMax={false}
        />
      </ChartCard>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Trefferbild (heat map)
// ---------------------------------------------------------------------------

type HeatMode = 'all' | GameMode;

function fieldLabel(key: string): string {
  if (key === 'MISS') return 'Daneben';
  if (key === 'D25') return 'Bull';
  if (key === 'S25') return '25';
  if (key.startsWith('S')) return key.slice(1);
  return key;
}

function heatCounts(d: StatsResponse | null, mode: HeatMode): Record<string, number> {
  if (!d) return {};
  if (mode !== 'all') return d.heat[mode] ?? {};
  const out: Record<string, number> = {};
  for (const m of MODES) for (const [k, v] of Object.entries(d.heat[m] ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function HeatSection({ ctx }: { ctx: StatsCtx }) {
  const [mode, setMode] = useState<HeatMode>('all');
  const [display, setDisplay] = useState<'fields' | 'darts'>('fields');
  const [selected, setSelected] = useState<string | null>(null);
  const [width, onLayout] = useMeasuredWidth();

  const datasets = [ctx.me, ...(ctx.friend ? [ctx.friend] : [])];
  const darts = (d: StatsResponse, m: GameMode) => total(Object.values(d.heat[m] ?? {}));
  const modes = MODES.filter((m) => datasets.some((d) => darts(d, m) > 0));
  if (!modes.length) return null;
  const activeMode: HeatMode = mode === 'all' || modes.includes(mode) ? mode : 'all';

  const boards = datasets.map((d, i) => {
    const counts = heatCounts(d, activeMode);
    const sum = total(Object.values(counts));
    const positions = d.positions.filter((p) => activeMode === 'all' || p[2] === MODES.indexOf(activeMode)).map((p): [number, number] => [p[0], p[1]]);
    return { d, s: ctx.series[i], counts, sum, positions };
  });
  const maxShare = Math.max(
    0.0001,
    ...boards.flatMap((b) => Object.entries(b.counts).filter(([k]) => k !== 'MISS').map(([, v]) => (b.sum ? v / b.sum : 0))),
  );
  const hasPositions = boards.some((b) => b.positions.length > 0);
  const shownDisplay = hasPositions ? display : 'fields';

  const gap = 12;
  const size = Math.floor(Math.min(boards.length > 1 ? 340 : 400, boards.length > 1 ? (width - gap) / 2 : width));

  // top fields (table twin)
  const ranked = Object.entries(boards[0].sum ? boards[0].counts : (boards[1]?.counts ?? {}))
    .filter(([k]) => k !== 'MISS')
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([k]) => k);
  const shareIn = (b: (typeof boards)[number], k: string) => (b.sum ? share(b.counts[k] ?? 0, b.sum) : null);
  const top = Math.max(1, ...ranked.flatMap((k) => boards.map((b) => shareIn(b, k) ?? 0)));
  const topRows: MeterRow[] = ranked.map((k) => ({
    key: k,
    label: fieldLabel(k),
    values: boards.map((b) => {
      const s = shareIn(b, k);
      return s === null ? null : s / top;
    }),
    figures: boards.map((b) => pct(shareIn(b, k), 1)),
  }));

  const ringShare = (b: (typeof boards)[number], test: (k: string) => boolean) =>
    b.sum ? share(total(Object.entries(b.counts).filter(([k]) => test(k)).map(([, v]) => v)), b.sum) : null;
  const ringKpis: { label: string; test: (k: string) => boolean }[] = [
    { label: 'Triple-Ring', test: (k) => k.startsWith('T') },
    { label: 'Doppel-Ring', test: (k) => k.startsWith('D') && k !== 'D25' },
    { label: 'Bull & 25', test: (k) => k === 'S25' || k === 'D25' },
    { label: 'Daneben', test: (k) => k === 'MISS' },
  ];

  const allKeys = [...new Set(boards.flatMap((b) => Object.keys(b.counts)))].sort(
    (x, y) => (boards[0].counts[y] ?? 0) - (boards[0].counts[x] ?? 0) || (boards[1]?.counts[y] ?? 0) - (boards[1]?.counts[x] ?? 0),
  );

  return (
    <View style={{ gap: 12 }}>
      <SectionHeader title="Trefferbild" icon="locate-outline" caption="Wo deine Darts landen – je heller, desto häufiger" />
      <ChartCard
        title="Heatmap"
        caption={`${num(boards[0].sum)} Darts${boards[1] ? ` · ${num(boards[1].sum)} Darts ${boards[1].s.label}` : ''}`}
        table={{
          columns: ['Feld', ...boards.map((b) => b.s.label)],
          rows: allKeys.map((k) => [fieldLabel(k), ...boards.map((b) => `${pct(shareIn(b, k), 1)} (${b.counts[k] ?? 0})`)]),
        }}
        right={
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {modes.length > 1 ? (
              <Pills
                options={[{ value: 'all' as HeatMode, label: 'Alle' }, ...modes.map((m) => ({ value: m as HeatMode, label: MODE_SHORT[m] }))]}
                value={activeMode}
                onChange={setMode}
              />
            ) : null}
            {hasPositions ? (
              <Pills
                options={[
                  { value: 'fields', label: 'Felder' },
                  { value: 'darts', label: 'Einzelne Darts' },
                ]}
                value={shownDisplay}
                onChange={setDisplay}
              />
            ) : null}
          </View>
        }
      >
        <View style={{ flexDirection: ctx.wide ? 'row' : 'column', gap: 20 }}>
          <View style={ctx.wide ? { width: '56%' } : undefined} onLayout={onLayout}>
            {/* fixed height: selecting a field never moves the boards */}
            <View
              style={{
                height: boards.length > 1 ? 40 : 22,
                overflow: 'hidden',
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                alignContent: 'center',
                columnGap: 12,
                rowGap: 2,
                marginBottom: 8,
              }}
            >
              {selected ? (
                <>
                  <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }}>{fieldLabel(selected)}</Text>
                  {boards.map((b) => (
                    <View key={b.s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
                      <LegendKey color={b.s.color} kind="dot" />
                      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 13 }}>{pct(shareIn(b, selected), 1)}</Text>
                      <Text style={[kit.caption, { maxWidth: 150, flexShrink: 1 }]} numberOfLines={1}>
                        {b.counts[selected] ?? 0} Darts{boards.length > 1 ? ` · ${b.s.label}` : ''}
                      </Text>
                    </View>
                  ))}
                </>
              ) : (
                <Text style={{ color: colors.faint, fontSize: 12 }}>Feld antippen für Details</Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', gap, justifyContent: 'center' }}>
              {size > 40
                ? boards.map((b) => (
                    <View key={b.s.key} style={{ alignItems: 'center', gap: 8 }}>
                      <HeatBoard
                        size={size}
                        color={b.s.color}
                        counts={b.counts}
                        total={b.sum}
                        maxShare={maxShare}
                        positions={b.positions}
                        display={shownDisplay}
                        selected={selected}
                        onSelect={setSelected}
                        label={b.s.label}
                      />
                      {boards.length > 1 ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <LegendKey color={b.s.color} kind="dot" />
                          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }} numberOfLines={1}>
                            {b.s.label}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  ))
                : null}
            </View>
            {shownDisplay === 'fields' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, justifyContent: 'center', marginTop: 12 }}>
                {boards.map((b) => (
                  <HeatScale key={b.s.key} color={b.s.color} maxShare={maxShare} />
                ))}
              </View>
            ) : (
              <Text style={[kit.caption, { textAlign: 'center', marginTop: 10 }]}>
                Letzte {num(total(boards.map((b) => b.positions.length)))} von der Kamera erkannte Darts
              </Text>
            )}
          </View>
          <View style={{ flex: 1, gap: 16, minWidth: 0 }}>
            <KpiGrid min={120}>
              {ringKpis.map((r) => (
                <Kpi
                  key={r.label}
                  label={r.label}
                  value={pct(ringShare(boards[0], r.test), 1)}
                  friend={boards[1] ? pct(ringShare(boards[1], r.test), 1) : undefined}
                  colorsFor={DOTS}
                />
              ))}
            </KpiGrid>
            {topRows.length ? (
              <View style={{ gap: 10 }}>
                <Text style={kit.cardTitle}>Häufigste Felder</Text>
                <MeterList rows={topRows} series={ctx.series} labelWidth={48} />
              </View>
            ) : null}
          </View>
        </View>
      </ChartCard>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Head-to-Head
// ---------------------------------------------------------------------------

export function HeadToHeadSection({ ctx, friendIds, onCompare }: { ctx: StatsCtx; friendIds: Set<string>; onCompare: (id: string) => void }) {
  const list = ctx.me.headToHead;
  if (!list.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <SectionHeader title="Head-to-Head" icon="people-outline" caption="Deine Bilanz gegen andere Spieler mit Konto" />
      <Card style={{ padding: 8, gap: 2 }}>
        {list.map((h, i) => {
          const other = h.matches - h.wins - h.losses;
          const isFriend = friendIds.has(h.userId);
          const active = ctx.friend?.user.id === h.userId;
          return (
            <View key={h.userId} style={[h2hRow, i > 0 && { borderTopWidth: 1, borderTopColor: chartInk.grid }]}>
              <View style={avatar}>
                <Text style={{ color: colors.text, fontWeight: '800' }}>{h.displayName.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, flexShrink: 1 }} numberOfLines={1}>
                    {h.displayName}
                  </Text>
                  <Text style={{ color: colors.text, fontWeight: '800', fontSize: 17 }}>
                    {h.wins} : {h.losses}
                  </Text>
                </View>
                <SplitBar
                  parts={[
                    { key: 'w', value: h.wins, color: ME },
                    { key: 'o', value: other, color: chartInk.axis },
                    { key: 'l', value: h.losses, color: colors.faint },
                  ]}
                />
                <Text style={kit.caption}>
                  {h.matches} {h.matches === 1 ? 'Spiel' : 'Spiele'} · {pct(share(h.wins, h.matches))} gewonnen · zuletzt {dateLabel(h.lastPlayedAt)}
                </Text>
              </View>
              {isFriend ? (
                <Pressable
                  onPress={() => onCompare(h.userId)}
                  accessibilityRole="button"
                  accessibilityLabel={`Mit ${h.displayName} vergleichen`}
                  hitSlop={8}
                  style={({ pressed }) => [compareBtn, active && { backgroundColor: colors.surfaceAlt, borderColor: FR }, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="git-compare-outline" size={16} color={active ? colors.text : colors.muted} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
        <Text style={[kit.caption, { padding: 10 }]}>Siege : Niederlagen · Balken: blau = deine Siege, hellgrau = Niederlagen, dunkelgrau = Spiele, die jemand Drittes gewonnen hat.</Text>
      </Card>
    </View>
  );
}

const h2hRow = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, padding: 10 };
const avatar = {
  width: 36,
  height: 36,
  borderRadius: 18,
  backgroundColor: colors.surfaceAlt,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
const compareBtn = { padding: 8, borderRadius: 10, borderWidth: 1, borderColor: colors.border };

// ---------------------------------------------------------------------------
// Letzte Spiele
// ---------------------------------------------------------------------------

const MODE_ICON: Record<GameMode, 'radio-button-on-outline' | 'grid-outline' | 'time-outline'> = {
  x01: 'radio-button-on-outline',
  cricket: 'grid-outline',
  atc: 'time-outline',
};

export function RecentSection({ ctx }: { ctx: StatsCtx }) {
  const [all, setAll] = useState(false);
  const list = ctx.me.recent;
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 8);
  return (
    <View style={{ gap: 12 }}>
      <SectionHeader title="Letzte Spiele" icon="list-outline" />
      <Card style={{ padding: 8, gap: 2 }}>
        {shown.map((m, i) => {
          const key = m.mode === 'x01' ? `Ø ${num(m.average, 1)}` : m.mode === 'cricket' ? `${num(m.mpr, 2)} MPR` : `${pct(m.hitRate)} Treffer`;
          const legs = m.legsWon + m.legsOpp > 1 ? ` · ${m.legsWon}:${m.legsOpp} Legs` : '';
          return (
            <Pressable
              key={m.id}
              onPress={() => router.push(`/match/${m.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`${m.title}, ${m.versus ? (m.won ? 'Sieg' : 'Niederlage') : 'Training'}`}
              style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                recentRow,
                i > 0 && { borderTopWidth: 1, borderTopColor: chartInk.grid },
                (pressed || hovered) && { backgroundColor: colors.bg },
              ]}
            >
              <View style={avatar}>
                <Ionicons name={MODE_ICON[m.mode]} size={18} color={colors.muted} />
              </View>
              <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }} numberOfLines={1}>
                  {m.title}
                </Text>
                <Text style={kit.caption} numberOfLines={2}>
                  {m.opponents.length ? `vs. ${m.opponents.join(', ')}` : MODE_LABEL[m.mode]} · {dateLabel(m.finishedAt)}
                  {legs}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={{ color: colors.text, fontWeight: '800' }}>{key}</Text>
                {m.versus ? (
                  <Badge label={m.won ? 'Sieg' : 'Niederlage'} color={m.won ? colors.accent : colors.danger} icon={m.won ? 'trophy' : 'close'} />
                ) : (
                  <Badge label="Training" color={colors.muted} icon="barbell-outline" />
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.faint} />
            </Pressable>
          );
        })}
        {list.length > 8 ? (
          <Pressable onPress={() => setAll((v) => !v)} accessibilityRole="button" style={{ padding: 12 }}>
            <Text style={{ color: colors.info, fontWeight: '700', fontSize: 13 }}>{all ? 'Weniger anzeigen' : `Alle ${list.length} anzeigen`}</Text>
          </Pressable>
        ) : null}
      </Card>
    </View>
  );
}

const recentRow = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, padding: 10, borderRadius: radius.md };

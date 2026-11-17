/** Layout pieces of the statistics page: section headers, chart cards, stat tiles, chips. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { DataTable, LegendKey, Sparkline } from '@/components/charts';
import { Card, type IconName } from '@/components/ui';
import { colors, radius } from '@/lib/theme';

export function SectionHeader({ title, caption, icon }: { title: string; caption?: string; icon?: IconName }) {
  return (
    <View style={kit.section}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {icon ? (
          <View style={kit.sectionIcon}>
            <Ionicons name={icon} size={16} color={colors.text} />
          </View>
        ) : null}
        <Text style={kit.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {caption ? <Text style={kit.sectionCaption}>{caption}</Text> : null}
    </View>
  );
}

/** Two cards per row on wide screens (equal heights), stacked on phones. */
export function Grid({ columns, children }: { columns: number; children: ReactNode }) {
  const items = Children.toArray(children);
  if (columns < 2 || items.length < 2) return <View style={{ gap: 16 }}>{items}</View>;
  const rows: ReactNode[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <View style={{ gap: 16 }}>
      {rows.map((r, i) => (
        <View key={`row${i}`} style={{ flexDirection: 'row', gap: 16, alignItems: 'stretch' }}>
          {r.map((c, j) => (
            <View key={`cell${j}`} style={{ flex: 1, minWidth: 0 }}>
              {c}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export interface Metric {
  key: string;
  value: string;
  unit?: string;
  /** series colour → shown as a dot before the value (only when comparing) */
  color?: string;
  label?: string;
}

function MetricView({ m, big }: { m: Metric; big: boolean }) {
  return (
    <View style={{ gap: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        {m.color ? (
          <View style={{ alignSelf: 'center' }}>
            <LegendKey color={m.color} kind="dot" />
          </View>
        ) : null}
        <Text style={[kit.metricValue, !big && { fontSize: 24 }]}>{m.value}</Text>
        {m.unit ? <Text style={kit.metricUnit}>{m.unit}</Text> : null}
      </View>
      {m.label ? <Text style={[kit.caption, m.color ? { marginLeft: 14 } : null]}>{m.label}</Text> : null}
    </View>
  );
}

/** Card with a title, headline numbers, the chart and a table-view toggle. */
export function ChartCard({
  title,
  metrics,
  caption,
  table,
  right,
  children,
  style,
}: {
  title: string;
  metrics?: Metric[];
  caption?: string;
  table?: { columns: string[]; rows: string[][] } | null;
  /** extra control in the header (e.g. metric switch) */
  right?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Card style={[{ gap: 14, flexGrow: 1, padding: 18 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 8 }}>
          <Text style={kit.cardTitle}>{title}</Text>
          {metrics?.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'flex-end' }}>
              {metrics.map((m) => (
                <MetricView key={m.key} m={m} big={metrics.length < 2} />
              ))}
            </View>
          ) : null}
          {caption ? <Text style={kit.caption}>{caption}</Text> : null}
        </View>
        {table ? (
          <Pressable
            onPress={() => setShowTable((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={showTable ? 'Diagramm zeigen' : 'Als Tabelle zeigen'}
            hitSlop={8}
            style={({ pressed }) => [kit.iconBtn, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name={showTable ? 'stats-chart-outline' : 'list-outline'} size={16} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      {right}
      {showTable && table ? <DataTable columns={table.columns} rows={table.rows} /> : children}
    </Card>
  );
}

/** Stat tile: label, big value, optional friend value and sparkline. */
export function Kpi({
  label,
  value,
  unit,
  sub,
  friend,
  friendSub,
  colorsFor,
  trend,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  /** friend value (comparison active when defined) */
  friend?: string;
  friendSub?: string;
  /** [me, friend] colours for the dots when comparing */
  colorsFor?: [string, string];
  trend?: { values: number[]; color: string };
}) {
  const compare = friend !== undefined && !!colorsFor;
  return (
    <View style={kit.kpi} accessible accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ''}${compare ? `, Vergleich ${friend}` : ''}`}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
        <Text style={kit.kpiLabel} numberOfLines={2}>
          {label}
        </Text>
        {trend && !compare ? <Sparkline values={trend.values} color={trend.color} width={56} height={20} /> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
        {compare ? (
          <View style={{ alignSelf: 'center' }}>
            <LegendKey color={colorsFor[0]} kind="dot" />
          </View>
        ) : null}
        <Text style={kit.kpiValue} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        {unit ? <Text style={kit.kpiUnit}>{unit}</Text> : null}
      </View>
      {sub ? <Text style={[kit.kpiSub, compare && { marginLeft: 13 }]}>{sub}</Text> : null}
      {compare ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 2 }}>
          <View style={{ alignSelf: 'center' }}>
            <LegendKey color={colorsFor[1]} kind="dot" />
          </View>
          <Text style={kit.kpiFriend} numberOfLines={1}>
            {friend}
          </Text>
          {unit && friend !== '–' ? <Text style={kit.kpiSub}>{unit}</Text> : null}
          {friendSub ? <Text style={kit.kpiSub}>{friendSub}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export function KpiGrid({ children, min = 140 }: { children: ReactNode; min?: number }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {Children.toArray(children).map((c, i) => (
        <View key={`kpi${i}`} style={{ flexGrow: 1, flexBasis: min, minWidth: min }}>
          {c}
        </View>
      ))}
    </View>
  );
}

/** Compact segmented switch inside a card. */
export function Pills<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={kit.pills}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[kit.pill, active && kit.pillActive]}
          >
            <Text style={[kit.pillText, active && { color: colors.text }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Friend chip for the comparison picker. */
export function Chip({ label, selected, color, onPress }: { label: string; selected: boolean; color: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Vergleichen mit ${label}`}
      style={({ pressed }) => [
        kit.chip,
        selected && { borderColor: color, backgroundColor: colors.surfaceAlt },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={[kit.avatar, selected && { backgroundColor: color }]}>
        <Text style={[kit.avatarText, selected && { color: '#ffffff' }]}>{label.slice(0, 1).toUpperCase()}</Text>
      </View>
      <Text style={[kit.chipText, selected && { color: colors.text }]} numberOfLines={1}>
        {label}
      </Text>
      {selected ? <Ionicons name="close" size={14} color={colors.muted} /> : null}
    </Pressable>
  );
}

export const kit = StyleSheet.create({
  section: { gap: 2, paddingHorizontal: 4, marginTop: 8 },
  sectionIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  sectionCaption: { color: colors.muted, fontSize: 13 },
  cardTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  metricValue: { color: colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.6 },
  metricUnit: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  caption: { color: colors.muted, fontSize: 12 },
  iconBtn: { padding: 6, borderRadius: radius.sm, backgroundColor: colors.bg },
  kpi: { backgroundColor: colors.bg, borderRadius: 14, padding: 12, gap: 3, flexGrow: 1 },
  kpiLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  kpiValue: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.4, flexShrink: 1 },
  kpiUnit: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  kpiSub: { color: colors.faint, fontSize: 11, fontWeight: '600' },
  kpiFriend: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  pills: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: 10, padding: 3, alignSelf: 'flex-start', flexWrap: 'wrap' },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  pillActive: { backgroundColor: colors.surfaceAlt },
  pillText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4,
    paddingRight: 12,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    maxWidth: 200,
  },
  avatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  chipText: { color: colors.muted, fontSize: 14, fontWeight: '700', flexShrink: 1 },
});

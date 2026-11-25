import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { GLICKO, type LeaderboardEntry, type RatingPool } from '@shared';
import { Button, Card, ErrorText, Loading, Screen, Segmented } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useLeaderboard } from '@/lib/leaderboard';
import { colors, radius } from '@/lib/theme';

const POOLS: { value: RatingPool; label: string; short: string }[] = [
  { value: 'x01', label: 'X01', short: 'X01' },
  { value: 'cricket', label: 'Cricket', short: 'Cricket' },
  { value: 'atc', label: 'Around the Clock', short: 'ATC' },
  { value: 'all', label: 'Champion of Champions', short: 'Champions' },
];

const METRIC: Record<RatingPool, { label: string; short: string; format: (v: number) => string } | null> = {
  x01: { label: 'Ø 3-Dart', short: 'Ø', format: (v) => v.toFixed(1).replace('.', ',') },
  cricket: { label: 'MPR', short: 'MPR', format: (v) => v.toFixed(2).replace('.', ',') },
  atc: { label: 'Treffer', short: 'Treffer', format: (v) => `${Math.round(v)} %` },
  all: null,
};

const MEDALS = ['#f5c542', '#c3ccd6', '#d08a4c'];

function Change({ value }: { value: number | null }) {
  if (value === null || value === 0) return null;
  const up = value > 0;
  return (
    <Text style={{ color: up ? colors.accent : colors.danger, fontSize: 12, fontWeight: '700' }}>
      {up ? '▲' : '▼'} {Math.abs(value)}
    </Text>
  );
}

function RankBadge({ rank }: { rank: number | null }) {
  if (rank === null) return <View style={s.rank} />;
  const medal = rank <= 3 ? MEDALS[rank - 1] : null;
  return (
    <View style={[s.rank, medal ? { backgroundColor: medal + '26', borderColor: medal, borderWidth: 1 } : null]}>
      {medal ? <Ionicons name="trophy" size={13} color={medal} /> : null}
      <Text style={[s.rankText, medal ? { color: medal } : null]}>{rank}</Text>
    </View>
  );
}

function EntryRow({ e, pool, me, wide }: { e: LeaderboardEntry; pool: RatingPool; me: boolean; wide: boolean }) {
  const metric = METRIC[pool];
  const games = e.matches ? `${e.matches} ${e.matches === 1 ? 'Spiel' : 'Spiele'} · ${e.wins} ${e.wins === 1 ? 'Sieg' : 'Siege'}` : 'noch kein Spiel gegen andere';
  const metricText = metric && e.metric !== null ? `${metric.short} ${metric.format(e.metric)}` : null;
  return (
    <View style={[s.row, me && s.rowMe]}>
      <RankBadge rank={e.rank} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={[s.name, me && { color: colors.accent }]} numberOfLines={1}>
            {e.displayName}
          </Text>
          {me ? <Text style={s.tagMe}>Du</Text> : null}
          {e.provisional ? <Text style={s.tag}>noch {GLICKO.rankedFrom - e.matches}</Text> : null}
        </View>
        {!wide ? (
          <Text style={s.sub} numberOfLines={2}>
            {games}
            {metricText ? ` · ${metricText}` : ''}
          </Text>
        ) : null}
      </View>
      {wide ? (
        <>
          <Text style={[s.col, { width: 150 }]}>{games}</Text>
          {metric ? <Text style={[s.col, { width: 110, textAlign: 'right' }]}>{e.metric !== null ? metric.format(e.metric) : '–'}</Text> : null}
        </>
      ) : null}
      <View style={{ width: wide ? 110 : 74, alignItems: 'flex-end' }}>
        <Text style={s.rating}>{e.rating ?? '–'}</Text>
        <Change value={e.lastChange} />
      </View>
    </View>
  );
}

export default function LeaderboardScreen() {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [pool, setPool] = useState<RatingPool>('x01');
  const [explain, setExplain] = useState(false);
  const { user } = useAuth();
  const board = useLeaderboard();

  if (!board.data) {
    if (board.error) {
      return (
        <Screen>
          <ErrorText>{board.error}</ErrorText>
          <Button title="Erneut versuchen" variant="secondary" icon="refresh" onPress={() => void board.reload()} />
        </Screen>
      );
    }
    return <Loading label="Rangliste wird berechnet …" />;
  }

  const entries = board.data.pools[pool] ?? [];
  const ranked = entries.filter((e) => e.rank !== null);
  const provisional = entries.filter((e) => e.provisional);
  const unrated = entries.filter((e) => e.matches === 0);
  const mine = entries.find((e) => e.userId === user?.id) ?? null;
  const metric = METRIC[pool];

  return (
    <Screen maxWidth={1100} style={{ gap: 16, paddingBottom: 40 }}>
      <Segmented
        options={POOLS.map((p) => ({ value: p.value, label: wide || width >= 520 ? p.label : p.short }))}
        value={pool}
        onChange={setPool}
      />

      <Pressable onPress={() => setExplain((v) => !v)} accessibilityRole="button" style={s.explainHead}>
        <Ionicons name="information-circle-outline" size={18} color={colors.muted} />
        <Text style={{ color: colors.muted, fontSize: 13, flex: 1 }}>
          {pool === 'all' ? 'Alle Spielarten zusammen – ' : ''}So wird gewertet
        </Text>
        <Ionicons name={explain ? 'chevron-up' : 'chevron-down'} size={16} color={colors.muted} />
      </Pressable>
      {explain ? (
        <Card style={{ gap: 8 }}>
          <Text style={s.p}>
            Die Wertung ist ein Glicko-Rating (Elo mit Unsicherheit). Gezählt werden nur komplett gespielte Matches gegen andere Spieler mit
            Konto – abgebrochene Spiele nie. Solo-Training und Spiele gegen Gäste ändern die Wertung nicht.
          </Text>
          <Text style={s.p}>
            Jedes Match zählt halb für den Sieg und halb für die Legs: ein 3:0 bringt mehr als ein 3:2. Gegen starke Gegner gibt ein Sieg
            mehr Punkte als gegen schwache.
          </Text>
          <Text style={s.p}>
            Einen Platz gibt es ab {GLICKO.rankedFrom} gewerteten Spielen – vorher steht man unter „Vorläufig“. Ein einziger Sieg macht also
            noch keinen Platz 1. Neue Spieler bewegen sich anfangs schneller, mit jedem Spiel wird die Wertung genauer.
          </Text>
          {metric ? (
            <Text style={[s.p, { color: colors.muted }]}>
              {metric.label}: über alle fertigen {pool === 'x01' ? 'X01' : pool === 'cricket' ? 'Cricket' : 'Around-the-Clock'}-Matches, auch Training –
              nur zur Info, zählt nicht für den Platz.
            </Text>
          ) : null}
        </Card>
      ) : null}

      {mine ? (
        <Card style={s.mine}>
          <RankBadge rank={mine.rank} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' }}>Dein Platz</Text>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>
              {mine.rank ? `Platz ${mine.rank} von ${ranked.length}` : mine.provisional ? 'Vorläufig' : 'Noch nicht gewertet'}
            </Text>
            <Text style={s.sub}>
              {mine.rank
                ? `${mine.matches} ${mine.matches === 1 ? 'Spiel' : 'Spiele'} · ${mine.wins} ${mine.wins === 1 ? 'Sieg' : 'Siege'}`
                : mine.provisional
                  ? `Noch ${GLICKO.rankedFrom - mine.matches} ${GLICKO.rankedFrom - mine.matches === 1 ? 'Spiel' : 'Spiele'} bis zu deinem Platz`
                  : 'Spiel ein Match gegen einen anderen Spieler mit Konto.'}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[s.rating, { fontSize: 24 }]}>{mine.rating ?? '–'}</Text>
            <Change value={mine.lastChange} />
          </View>
        </Card>
      ) : null}

      <Card style={{ padding: 0, overflow: 'hidden', opacity: board.pending ? 0.6 : 1 }}>
        {wide ? (
          <View style={[s.row, s.head]}>
            <View style={s.rank} />
            <Text style={[s.headText, { flex: 1 }]}>Spieler</Text>
            <Text style={[s.headText, { width: 150 }]}>Spiele</Text>
            {metric ? <Text style={[s.headText, { width: 110, textAlign: 'right' }]}>{metric.label}</Text> : null}
            <Text style={[s.headText, { width: 110, textAlign: 'right' }]}>Wertung</Text>
          </View>
        ) : null}
        {ranked.length ? (
          ranked.map((e) => <EntryRow key={e.userId} e={e} pool={pool} me={e.userId === user?.id} wide={wide} />)
        ) : (
          <View style={{ padding: 24, alignItems: 'center', gap: 6 }}>
            <Ionicons name="trophy-outline" size={28} color={colors.faint} />
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Noch niemand mit Platz</Text>
            <Text style={[s.sub, { textAlign: 'center' }]}>
              Einen Platz gibt es ab {GLICKO.rankedFrom} komplett gespielten Matches gegen andere Spieler mit Konto.
            </Text>
          </View>
        )}
      </Card>

      {provisional.length ? (
        <View style={{ gap: 8 }}>
          <Text style={s.section}>
            Vorläufig · {provisional.length} – Platz ab {GLICKO.rankedFrom} Spielen
          </Text>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {provisional.map((e) => (
              <EntryRow key={e.userId} e={e} pool={pool} me={e.userId === user?.id} wide={wide} />
            ))}
          </Card>
        </View>
      ) : null}

      {unrated.length ? (
        <View style={{ gap: 8 }}>
          <Text style={s.section}>Noch nicht gewertet · {unrated.length}</Text>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {unrated.map((e) => (
              <EntryRow key={e.userId} e={e} pool={pool} me={e.userId === user?.id} wide={wide} />
            ))}
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowMe: { backgroundColor: colors.accentDim + '55' },
  head: { paddingVertical: 8, backgroundColor: colors.surfaceAlt },
  headText: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  rank: { width: 44, height: 28, borderRadius: radius.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  rankText: { color: colors.muted, fontSize: 15, fontWeight: '800' },
  name: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  sub: { color: colors.muted, fontSize: 12 },
  col: { color: colors.muted, fontSize: 13 },
  rating: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tag: { color: colors.warning, fontSize: 11, fontWeight: '700', borderWidth: 1, borderColor: colors.warning + '66', borderRadius: 6, paddingHorizontal: 5 },
  tagMe: { color: colors.accent, fontSize: 11, fontWeight: '700', borderWidth: 1, borderColor: colors.accent + '66', borderRadius: 6, paddingHorizontal: 5 },
  explainHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  p: { color: colors.text, fontSize: 14, lineHeight: 20 },
  mine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  section: { color: colors.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 4 },
});

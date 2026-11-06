import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import type { PlayerStats } from '@shared';
import { Badge, Card, ErrorText, H2, Loading, P, Screen, Stat } from '@/components/ui';
import { useFocusFetch } from '@/lib/hooks';
import { colors, radius } from '@/lib/theme';

interface StatsResponse {
  matches: number;
  wins: number;
  x01: PlayerStats & { matches: number };
  cricket: PlayerStats & { matches: number };
  recent: {
    id: string;
    title: string;
    mode: 'x01' | 'cricket';
    won: boolean;
    opponents: string[];
    average: number;
    mpr: number;
    finishedAt: string;
  }[];
}

export default function StatsScreen() {
  const { data, error, loading } = useFocusFetch<StatsResponse>('/api/stats/me');
  if (loading && !data) return <Loading />;
  if (error && !data) return <Screen><ErrorText>{error}</ErrorText></Screen>;
  if (!data) return null;
  const x = data.x01;
  const c = data.cricket;
  const winRate = data.matches ? Math.round((data.wins / data.matches) * 100) : 0;
  return (
    <Screen>
      <Card>
        <H2>Übersicht</H2>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Stat label="Spiele" value={data.matches} />
          <Stat label="Siege" value={data.wins} />
          <Stat label="Siegquote" value={`${winRate} %`} />
        </View>
        {data.matches === 0 ? <P muted>Spiele ein Match als „du“, um hier Statistiken zu sehen.</P> : null}
      </Card>
      <Card>
        <H2>X01 · {x.matches} Spiele</H2>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Stat label="3-Dart-Average" value={x.average.toFixed(2)} />
          <Stat label="First-9-Average" value={x.first9Average.toFixed(2)} />
          <Stat label="Checkout-Quote" value={`${x.checkoutRate.toFixed(1)} %`} sub={`${x.checkouts} / ${x.dartsAtDouble}`} />
          <Stat label="Höchster Checkout" value={x.highestCheckout || '–'} />
          <Stat label="Höchste Aufnahme" value={x.highestTurn || '–'} />
          <Stat label="180er" value={x.t180} />
          <Stat label="140+" value={x.t140} />
          <Stat label="100+" value={x.t100} />
          <Stat label="Bestes Leg" value={x.bestLegDarts ?? '–'} sub="Darts" />
          <Stat label="Legs gewonnen" value={x.legsWon} />
        </View>
      </Card>
      <Card>
        <H2>Cricket · {c.matches} Spiele</H2>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Stat label="MPR" value={c.mpr.toFixed(2)} sub="Marks pro Runde" />
          <Stat label="Marks" value={c.marks} />
          <Stat label="Legs gewonnen" value={c.legsWon} />
        </View>
      </Card>
      <Card>
        <H2>Letzte Spiele</H2>
        {data.recent.length === 0 ? <P muted>Noch keine beendeten Spiele.</P> : null}
        {data.recent.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => router.push(`/match/${m.id}`)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.md, backgroundColor: colors.bg }}
          >
            <Badge label={m.won ? 'Sieg' : 'Niederlage'} color={m.won ? colors.accent : colors.danger} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{m.title}</Text>
              <Text style={{ color: colors.muted, fontSize: 13 }}>
                {m.opponents.length ? `vs. ${m.opponents.join(', ')}` : 'Training'} · {new Date(m.finishedAt).toLocaleDateString()}
              </Text>
            </View>
            <Text style={{ color: colors.text, fontWeight: '800' }}>{m.mode === 'x01' ? `Ø ${m.average.toFixed(1)}` : `MPR ${m.mpr.toFixed(2)}`}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}

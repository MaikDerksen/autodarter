import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Legend, SERIES_COLORS, type SeriesInfo } from '@/components/charts';
import { Chip, kit } from '@/components/StatsKit';
import {
  AtcSection,
  CricketSection,
  HeadToHeadSection,
  HeatSection,
  OverviewSection,
  RecentSection,
  X01Section,
  type StatsCtx,
} from '@/components/StatsSections';
import { Button, Card, ErrorText, Loading, Screen, Segmented } from '@/components/ui';
import { useFriends } from '@/lib/friends';
import { statsPath, useStats, type StatsRange } from '@/lib/stats';
import { colors } from '@/lib/theme';

const RANGES: { value: StatsRange; label: string }[] = [
  { value: '7d', label: '7 T' },
  { value: '30d', label: '30 T' },
  { value: '90d', label: '90 T' },
  { value: 'all', label: 'Alle' },
];

export default function StatsScreen() {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [range, setRange] = useState<StatsRange>('all');
  const [friendId, setFriendId] = useState<string | null>(null);
  const friends = useFriends();
  const activeFriend = friends.friends.find((f) => f.id === friendId) ?? null;

  const mine = useStats(statsPath('me', range));
  const theirs = useStats(activeFriend ? statsPath(activeFriend.id, range) : null);

  const friendData = activeFriend && theirs.data?.user.id === activeFriend.id ? theirs.data : null;
  const friendIds = useMemo(() => new Set(friends.friends.map((f) => f.id)), [friends.friends]);

  if (!mine.data) {
    if (mine.error) {
      return (
        <Screen>
          <ErrorText>{mine.error}</ErrorText>
          <Button title="Erneut versuchen" variant="secondary" icon="refresh" onPress={() => void mine.reload()} />
        </Screen>
      );
    }
    return <Loading label="Statistik wird berechnet …" />;
  }

  const series: SeriesInfo[] = [
    { key: 'me', label: 'Du', color: SERIES_COLORS.me },
    ...(friendData ? [{ key: 'friend', label: friendData.user.displayName, color: SERIES_COLORS.friend }] : []),
  ];
  const ctx: StatsCtx = { me: mine.data, friend: friendData, series, wide };
  const empty = mine.data.overview.matches === 0 && (!friendData || friendData.overview.matches === 0);
  const pending = mine.pending || (!!activeFriend && theirs.pending);

  return (
    <Screen maxWidth={1280} style={{ gap: 20, paddingBottom: 40 }}>
      {/* filters: one row above everything they scope */}
      <View style={{ flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch', gap: 12 }}>
        <Segmented options={RANGES} value={range} onChange={setRange} style={wide ? { width: 340 } : undefined} />
        <View style={{ flex: wide ? 1 : undefined, gap: 6, minWidth: 0 }}>
          {friends.friends.length ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={[kit.cardTitle, { flexShrink: 0 }]}>Vergleichen mit</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
                {friends.friends.map((f) => (
                  <Chip
                    key={f.id}
                    label={f.displayName}
                    selected={f.id === friendId}
                    color={SERIES_COLORS.friend}
                    onPress={() => setFriendId((cur) => (cur === f.id ? null : f.id))}
                  />
                ))}
              </ScrollView>
            </View>
          ) : friends.loaded ? (
            <Pressable onPress={() => router.push('/friends')} accessibilityRole="link" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="people-outline" size={16} color={colors.muted} />
              <Text style={{ color: colors.muted, fontSize: 13 }}>Füge Freunde hinzu, um deine Statistik mit ihnen zu vergleichen</Text>
              <Ionicons name="chevron-forward" size={14} color={colors.muted} />
            </Pressable>
          ) : null}
          {activeFriend && theirs.error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{theirs.error}</Text> : null}
        </View>
      </View>
      {friendData ? <Legend series={series} kind="dot" style={{ paddingHorizontal: 4 }} /> : null}
      {mine.error ? <ErrorText>{mine.error}</ErrorText> : null}

      <View style={{ gap: 28, opacity: pending ? 0.55 : 1 }}>
        {empty ? (
          <Card style={{ alignItems: 'center', padding: 32, gap: 12 }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="stats-chart" size={28} color={colors.muted} />
            </View>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>
              {range === 'all' ? 'Noch keine Statistik' : 'Keine Spiele in diesem Zeitraum'}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 420 }}>
              Spiel ein Match als „du“ – danach findest du hier Averages, Doppelquoten, dein Trefferbild, Rekorde und den Vergleich mit deinen
              Freunden.
            </Text>
            {range !== 'all' ? (
              <Button title="Alle Spiele zeigen" variant="secondary" onPress={() => setRange('all')} />
            ) : (
              <Button title="Spiel starten" icon="play" onPress={() => router.push('/')} />
            )}
          </Card>
        ) : (
          <>
            <OverviewSection ctx={ctx} />
            <X01Section ctx={ctx} />
            <CricketSection ctx={ctx} />
            <AtcSection ctx={ctx} />
            <HeatSection ctx={ctx} />
            <HeadToHeadSection ctx={ctx} friendIds={friendIds} onCompare={(id) => setFriendId((cur) => (cur === id ? null : id))} />
            <RecentSection ctx={ctx} />
          </>
        )}
      </View>
    </Screen>
  );
}

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { describeSettings, type FriendMatch, type MatchState, type MatchSummary } from '@shared';
import { Button, Card, ErrorText, H2 } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useFocusFetch } from '@/lib/hooks';
import { useLiveMessages } from '@/lib/live';
import { colors, radius } from '@/lib/theme';

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 1 ? 'gerade eben' : `vor ${min} min`;
}

/**
 * Suggestions on the play screen: running matches of friends. During the first round you can join
 * as another player (you throw at the host's board, or switch to your own one in the match), later
 * you can still watch.
 */
export function FriendMatches() {
  const list = useFocusFetch<FriendMatch[]>('/api/matches/friends');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLiveMessages((msg) => {
    if (msg.type === 'friend_matches') void list.reload();
  });

  if (!list.data?.length) return null;

  const join = async (fm: FriendMatch) => {
    setBusy(fm.match.id);
    setError(null);
    try {
      await api<{ match: MatchSummary; state: MatchState }>(`/api/matches/${fm.match.id}/join`, { method: 'POST' });
      router.push(`/match/${fm.match.id}`);
    } catch (e) {
      setError(errorMessage(e));
      void list.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ borderColor: colors.accentDim }}>
      <H2>Freunde spielen gerade</H2>
      {list.data.map((fm) => (
        <View key={fm.match.id} style={row}>
          <Ionicons name="people" size={20} color={fm.joinable ? colors.accent : colors.muted} />
          <View style={{ flex: 1, gap: 2, minWidth: 160 }}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>
              {fm.ownerName} · {describeSettings(fm.match.settings)}
            </Text>
            <Text style={{ color: colors.muted }}>{fm.match.players.map((p) => p.name).join(' vs. ')}</Text>
            <Text
              style={{
                color: fm.joinable ? colors.accent : colors.faint,
                fontSize: 12,
              }}
            >
              {fm.joinable ? 'Erste Runde – du kannst noch einsteigen' : `Runde ${fm.round}`}
              {fm.boardName ? ` · Board ${fm.boardName}` : ' · ohne Board'} · {ago(fm.lastActivity)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {fm.joinable ? <Button small title="Mitspielen" icon="enter" onPress={() => join(fm)} loading={busy === fm.match.id} /> : null}
            <Button small variant="secondary" title="Zuschauen" icon="eye" onPress={() => router.push(`/match/${fm.match.id}`)} />
          </View>
        </View>
      ))}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

const row = {
  flexDirection: 'row' as const,
  flexWrap: 'wrap' as const,
  alignItems: 'center' as const,
  gap: 10,
  paddingVertical: 10,
  paddingHorizontal: 12,
  borderRadius: radius.md,
  backgroundColor: colors.bg,
};

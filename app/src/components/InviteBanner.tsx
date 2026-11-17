import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeSettings } from '@shared';
import { Button } from '@/components/ui';
import { processPendingInvite } from '@/lib/friends';
import { useLiveMessages } from '@/lib/live';
import { colors, radius } from '@/lib/theme';

interface Notice {
  key: string;
  text: string;
  matchId?: string;
}

/**
 * Global notices on top of every screen: "X hat dich zu einem Spiel eingeladen" and the result
 * of an invite link that was opened before logging in.
 */
export function InviteBanner() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    processPendingInvite().then((text) => text && setNotices((n) => [...n, { key: `inv${Date.now()}`, text }]));
  }, []);

  useLiveMessages((msg) => {
    if (msg.type !== 'match_invite') return;
    const players = msg.match.players.map((p) => p.name).join(' vs. ');
    const text = `${msg.from.displayName} hat dich zu ${describeSettings(msg.match.settings)} eingeladen (${players})`;
    setNotices((n) => [...n.filter((x) => x.matchId !== msg.match.id), { key: msg.match.id, text, matchId: msg.match.id }]);
  });

  // plain notices disappear by themselves
  useEffect(() => {
    if (!notices.some((n) => !n.matchId)) return;
    const t = setTimeout(() => setNotices((n) => n.filter((x) => x.matchId)), 6000);
    return () => clearTimeout(t);
  }, [notices]);

  if (!notices.length) return null;
  const dismiss = (key: string) => setNotices((n) => n.filter((x) => x.key !== key));
  return (
    <View style={[s.wrap, { top: insets.top + 8, pointerEvents: 'box-none' }]}>
      {notices.map((n) => (
        <View key={n.key} style={s.banner}>
          <Ionicons name={n.matchId ? 'game-controller' : 'people'} size={20} color={colors.accent} />
          <Text style={s.text}>{n.text}</Text>
          {n.matchId ? (
            <Button
              small
              title="Öffnen"
              onPress={() => {
                dismiss(n.key);
                router.push(`/match/${n.matchId}`);
              }}
            />
          ) : null}
          <Button small variant="ghost" icon="close" onPress={() => dismiss(n.key)} />
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', top: 8, left: 8, right: 8, alignItems: 'center', gap: 8, zIndex: 100 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 640,
    width: '100%',
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  text: { color: colors.text, flex: 1, fontWeight: '600' },
});

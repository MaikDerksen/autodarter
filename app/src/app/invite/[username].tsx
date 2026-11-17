import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { Logo } from '@/components/Logo';
import { Button, Card, ErrorText, H2, P, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { rememberInvite } from '@/lib/friends';
import { colors } from '@/lib/theme';

/** Opened from an invite link: /invite/<username> */
export default function InviteScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { user } = useAuth();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const self = user?.username === username?.toLowerCase();

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ status: string; user: { displayName: string } }>('/api/friends', { body: { username } });
      setDone(res.status === 'accepted' ? 'Ihr seid jetzt befreundet.' : `Anfrage an ${res.user.displayName} gesendet.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toAuth = async (to: '/login' | '/register') => {
    if (username) await rememberInvite(username);
    router.replace(to);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Einladung' }} />
      <Screen maxWidth={480} style={{ justifyContent: 'center' }}>
        <Logo />
        <Card>
          <Ionicons name="people" size={32} color={colors.accent} />
          <H2>@{username} lädt dich zum Darts ein</H2>
          {!user ? (
            <>
              <P muted>Melde dich an oder registriere dich – die Freundschaftsanfrage wird danach automatisch gesendet.</P>
              <Button title="Registrieren" icon="person-add" onPress={() => toAuth('/register')} />
              <Button title="Ich habe schon ein Konto" variant="secondary" onPress={() => toAuth('/login')} />
            </>
          ) : self ? (
            <P muted>Das ist dein eigener Einladungslink – schick ihn an deine Freunde.</P>
          ) : done ? (
            <>
              <Text style={{ color: colors.accent, fontWeight: '700' }}>{done}</Text>
              <Button title="Zu den Freunden" onPress={() => router.replace('/friends')} />
            </>
          ) : (
            <>
              <P muted>Füge @{username} als Freund hinzu, um gemeinsam zu spielen und zu sehen, wer gerade online ist.</P>
              <Button title="Als Freund hinzufügen" icon="person-add" onPress={add} loading={busy} />
            </>
          )}
          <ErrorText>{error}</ErrorText>
        </Card>
      </Screen>
    </>
  );
}

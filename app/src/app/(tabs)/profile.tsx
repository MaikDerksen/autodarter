import { useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, ErrorText, Field, H2, P, Screen } from '@/components/ui';
import { ServerField } from '@/components/ServerField';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';

export default function ProfileScreen() {
  const { user, logout, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api('/api/auth/me', {
        method: 'PATCH',
        body: { displayName: displayName.trim() || undefined, password: password || undefined },
      });
      await refreshUser();
      setPassword('');
      setMessage('Gespeichert');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen maxWidth={640}>
      <Card>
        <H2>Profil</H2>
        <P muted>Angemeldet als @{user?.username}</P>
        <Field label="Anzeigename" value={displayName} onChangeText={setDisplayName} />
        <Field label="Neues Passwort (optional)" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />
        <ErrorText>{error}</ErrorText>
        {message ? <Text style={{ color: colors.accent }}>{message}</Text> : null}
        <Button title="Speichern" icon="save" onPress={save} loading={busy} />
      </Card>
      <Card>
        <H2>Verbindung</H2>
        <ServerField />
      </Card>
      <Button title="Abmelden" variant="danger" icon="log-out" onPress={() => void logout()} />
      <P muted style={{ textAlign: 'center' }}>Autodarter 0.1.0 · Open Source · selbst gehostet</P>
    </Screen>
  );
}

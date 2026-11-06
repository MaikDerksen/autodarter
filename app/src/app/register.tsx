import { Link } from 'expo-router';
import { useState } from 'react';
import { Logo } from '@/components/Logo';
import { Button, Card, ErrorText, Field, P, Screen } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';
import { ServerField } from '@/components/ServerField';

export default function RegisterScreen() {
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password !== password2) {
      setError('Die Passwörter stimmen nicht überein');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register(username.trim(), password, displayName.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen maxWidth={440} style={{ justifyContent: 'center' }}>
      <Logo />
      <Card>
        <Field label="Benutzername" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
        <Field label="Anzeigename (optional)" value={displayName} onChangeText={setDisplayName} placeholder="z. B. Michael" />
        <Field label="Passwort" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />
        <Field label="Passwort wiederholen" value={password2} onChangeText={setPassword2} secureTextEntry onSubmitEditing={submit} />
        <ErrorText>{error}</ErrorText>
        <Button title="Konto erstellen" icon="person-add" onPress={submit} loading={busy} disabled={!username || !password} />
        <P muted style={{ textAlign: 'center' }}>
          Schon registriert?{' '}
          <Link href="/login" style={{ color: colors.accent, fontWeight: '700' }}>
            Anmelden
          </Link>
        </P>
      </Card>
      <ServerField />
    </Screen>
  );
}

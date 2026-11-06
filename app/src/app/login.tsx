import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { ServerField } from '@/components/ServerField';
import { Button, Card, ErrorText, Field, P, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);

  useEffect(() => {
    api<{ allowRegistration: boolean }>('/api/auth/config')
      .then((c) => setAllowRegistration(c.allowRegistration))
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
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
        <Field label="Benutzername" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" />
        <Field
          label="Passwort"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          onSubmitEditing={submit}
        />
        <ErrorText>{error}</ErrorText>
        <Button title="Anmelden" icon="log-in" onPress={submit} loading={busy} disabled={!username || !password} />
        {allowRegistration ? (
          <P muted style={{ textAlign: 'center' }}>
            Noch kein Konto?{' '}
            <Link href="/register" style={{ color: colors.accent, fontWeight: '700' }}>
              Registrieren
            </Link>
          </P>
        ) : null}
      </Card>
      <ServerField />
    </Screen>
  );
}

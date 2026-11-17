import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Button, Card, ErrorText, Field, H2, P, Row, Screen } from '@/components/ui';
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
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [updater, setUpdater] = useState<{ updaterActive: boolean } | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateErr, setUpdateErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ version?: string }>('/api/health')
      .then((h) => setServerVersion(h.version ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user?.isAdmin) return;
    api<{ updaterActive: boolean }>('/api/admin/update')
      .then(setUpdater)
      .catch(() => undefined);
  }, [user?.isAdmin]);

  const updateServer = async () => {
    setUpdateErr(null);
    setUpdateMsg(null);
    try {
      await api('/api/admin/update', { body: {} });
      setUpdateMsg('Update angefordert. Gibt es eine neue Version, startet der Server in 1–2 Minuten neu – danach die Seite neu laden.');
    } catch (e) {
      setUpdateErr(errorMessage(e));
    }
  };

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
        <H2>Ansagen</H2>
        <P muted>Eigene Stimmen-Pakete: sprich z. B. 180, Big Fish oder Triple 20 selbst ein. Alles andere sagt die Standardstimme.</P>
        <Button title="Stimmen verwalten" icon="mic" variant="secondary" onPress={() => router.push('/voice')} />
      </Card>
      <Card>
        <H2>Verbindung</H2>
        <ServerField />
      </Card>
      {user?.isAdmin ? (
        <Card>
          <H2>Server</H2>
          <P muted>
            Version {serverVersion ?? '…'} ·{' '}
            {updater === null ? 'Auto-Update wird geprüft …' : updater.updaterActive ? 'Auto-Update aktiv' : 'Auto-Update läuft nicht'}
          </P>
          <Row wrap>
            <Button title="Server aktualisieren" icon="cloud-download" variant="secondary" onPress={updateServer} disabled={!updater?.updaterActive} />
          </Row>
          {updater && !updater.updaterActive ? (
            <P muted>Auf dem Server in der .env COMPOSE_PROFILES=autoupdate setzen und „docker compose up -d“ ausführen.</P>
          ) : null}
          {updateMsg ? <Text style={{ color: colors.accent }}>{updateMsg}</Text> : null}
          <ErrorText>{updateErr}</ErrorText>
        </Card>
      ) : null}
      <Button title="Abmelden" variant="danger" icon="log-out" onPress={() => void logout()} />
      <P muted style={{ textAlign: 'center' }}>
        Autodarter · Server-Version {serverVersion ?? '…'} · selbst gehostet
      </P>
    </Screen>
  );
}

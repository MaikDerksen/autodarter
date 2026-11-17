import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FriendUser } from '@shared';
import { OnlineDot } from '@/components/OnlineDot';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, P, Row, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirm } from '@/lib/confirm';
import { inviteLink, shareInvite, useFriends } from '@/lib/friends';
import { colors, radius } from '@/lib/theme';

interface SearchHit {
  id: string;
  username: string;
  displayName: string;
}

function PersonRow({ user, children }: { user: FriendUser | SearchHit; children?: React.ReactNode }) {
  const f = 'online' in user ? user : null;
  return (
    <View style={rowStyle}>
      {f ? <OnlineDot online={f.online} /> : <Ionicons name="person-outline" size={16} color={colors.muted} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>{user.displayName}</Text>
        <Text style={{ color: colors.muted, fontSize: 12 }}>
          @{user.username}
          {f ? (f.playing ? ` · spielt gerade ${f.playing.title}` : f.online ? ' · online' : ' · offline') : ''}
        </Text>
      </View>
      {children}
    </View>
  );
}

export default function FriendsScreen() {
  const { user } = useAuth();
  const friends = useFriends();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // search as you type
  const searching = query.trim().length >= 2;
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const t = setTimeout(() => {
      api<SearchHit[]>(`/api/users/search?q=${encodeURIComponent(q)}`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await friends.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const known = new Set([...friends.friends, ...friends.incoming, ...friends.outgoing].map((f) => f.id));
  const online = friends.friends.filter((f) => f.online).length;

  return (
    <Screen>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>Freunde</H2>
          <Badge label={`${online} online`} color={online ? colors.accent : colors.faint} />
        </Row>
        {!friends.loaded ? <Loading /> : null}
        {friends.error ? <ErrorText>{friends.error}</ErrorText> : null}
        {friends.friends.map((f) => (
          <PersonRow key={f.id} user={f}>
            {f.playing ? (
              <Button small variant="secondary" icon="eye" title="Zuschauen" onPress={() => router.push(`/match/${f.playing!.matchId}`)} />
            ) : null}
            <Button
              small
              variant="ghost"
              icon="person-remove"
              onPress={async () => {
                if (await confirm('Freundschaft beenden?', `${f.displayName} wird aus deiner Freundesliste entfernt.`, 'Entfernen')) {
                  await run(`rm${f.id}`, () => api(`/api/friends/${f.id}`, { method: 'DELETE' }));
                }
              }}
            />
          </PersonRow>
        ))}
        {friends.loaded && friends.friends.length === 0 ? (
          <P muted>Noch keine Freunde. Suche unten nach Spielern oder schick deinen Einladungslink.</P>
        ) : null}
      </Card>

      {friends.incoming.length > 0 ? (
        <Card style={{ borderColor: colors.accent }}>
          <H2>Anfragen an dich</H2>
          {friends.incoming.map((f) => (
            <PersonRow key={f.id} user={f}>
              <Button small icon="checkmark" title="Annehmen" loading={busy === `ok${f.id}`} onPress={() => run(`ok${f.id}`, () => api(`/api/friends/${f.id}/accept`, { body: {} }))} />
              <Button small variant="ghost" icon="close" onPress={() => run(`no${f.id}`, () => api(`/api/friends/${f.id}`, { method: 'DELETE' }))} />
            </PersonRow>
          ))}
        </Card>
      ) : null}

      <Card>
        <H2>Freund hinzufügen</H2>
        <Field
          label="Benutzername oder Name"
          value={query}
          onChangeText={setQuery}
          placeholder="z. B. jonas"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {(searching ? hits : []).map((h) => (
          <PersonRow key={h.id} user={h}>
            {known.has(h.id) ? (
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                {friends.friends.some((f) => f.id === h.id) ? 'Befreundet' : 'Anfrage offen'}
              </Text>
            ) : (
              <Button
                small
                icon="person-add"
                title="Anfrage"
                loading={busy === `add${h.id}`}
                onPress={() =>
                  run(`add${h.id}`, () => api('/api/friends', { body: { username: h.username } }), `Anfrage an ${h.displayName} gesendet`)
                }
              />
            )}
          </PersonRow>
        ))}
        {searching && hits.length === 0 ? <P muted>Kein Spieler gefunden.</P> : null}
        {friends.outgoing.length > 0 ? (
          <>
            <Text style={{ color: colors.muted, fontWeight: '700', marginTop: 4 }}>Offene Anfragen</Text>
            {friends.outgoing.map((f) => (
              <PersonRow key={f.id} user={f}>
                <Button small variant="ghost" title="Zurückziehen" onPress={() => run(`wd${f.id}`, () => api(`/api/friends/${f.id}`, { method: 'DELETE' }))} />
              </PersonRow>
            ))}
          </>
        ) : null}
        <ErrorText>{error}</ErrorText>
        {notice ? <Text style={{ color: colors.accent }}>{notice}</Text> : null}
      </Card>

      <Card>
        <H2>Freunde einladen</H2>
        <P muted>
          Wer den Link öffnet, landet auf deinem Autodarter-Server, kann sich anmelden oder registrieren und schickt dir dann
          automatisch eine Freundschaftsanfrage.
        </P>
        {user ? (
          <Pressable style={[rowStyle, { backgroundColor: colors.bg }]}>
            <Ionicons name="link" size={16} color={colors.muted} />
            <Text selectable style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
              {inviteLink(user.username)}
            </Text>
          </Pressable>
        ) : null}
        <Button
          title="Einladungslink teilen"
          icon="share-social"
          variant="secondary"
          onPress={async () => user && setNotice(await shareInvite(user.username))}
        />
      </Card>
    </Screen>
  );
}

const rowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 10,
  paddingVertical: 10,
  paddingHorizontal: 12,
  borderRadius: radius.md,
  backgroundColor: colors.bg,
};

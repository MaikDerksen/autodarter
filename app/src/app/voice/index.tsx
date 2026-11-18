import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { VoicePack } from '@shared';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, P, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { colors, radius } from '@/lib/theme';
import { useVoicePacks } from '@/lib/voice';

export default function VoicePacksScreen() {
  const { data, error, loading, reload, setData } = useVoicePacks();
  const { refreshUser } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Loading />;

  const activate = async (packId: string | null) => {
    setBusy(packId ?? 'standard');
    setActionError(null);
    try {
      await api('/api/me/voice-pack', { method: 'PUT', body: { packId } });
      if (data) setData({ ...data, activeId: packId });
      void refreshUser();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy('create');
    setActionError(null);
    try {
      const pack = await api<VoicePack>('/api/voice-packs', { body: { name: name.trim() } });
      setName('');
      await reload();
      router.push(`/voice/${pack.id}`);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const packs = data?.packs ?? [];
  const mine = packs.filter((p) => p.mine);
  const shared = packs.filter((p) => !p.mine);

  return (
    <Screen maxWidth={720}>
      <Card>
        <H2>Deine Stimme</H2>
        <P muted>
          Diese Stimme sagt deine Würfe an, wenn im Spiel „Jeder mit eigener Stimme“ eingestellt ist. In Spielen, die du
          erstellst, spricht sie außerdem für Gäste – oder für alle, wenn du „Alle mit meiner Stimme“ wählst. Was im Paket nicht
          eingesprochen ist, übernimmt die Standardstimme.
        </P>
        <ChoiceRow
          title="Standardstimme"
          sub="Computerstimme, sagt alles an"
          active={!data?.activeId}
          busy={busy === 'standard'}
          onPress={() => activate(null)}
        />
        {packs.map((p) => (
          <ChoiceRow
            key={p.id}
            title={p.name}
            sub={`${p.mine ? 'Dein Paket' : `von ${p.ownerName}`} · ${p.keys.length} Ansagen eingesprochen`}
            active={data?.activeId === p.id}
            busy={busy === p.id}
            onPress={() => activate(p.id)}
          />
        ))}
        <ErrorText>{actionError ?? error}</ErrorText>
      </Card>

      <Card>
        <H2>Deine Stimmen-Pakete</H2>
        {mine.length === 0 ? <P muted>Noch kein eigenes Paket. Leg eins an und sprich nur das ein, worauf du Lust hast – z. B. 180 oder Big Fish.</P> : null}
        {mine.map((p) => (
          <PackRow key={p.id} pack={p} />
        ))}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field label="Neues Paket" placeholder="z. B. Maiks Caller" value={name} onChangeText={setName} onSubmitEditing={create} />
          </View>
          <Button title="Anlegen" icon="add" onPress={create} loading={busy === 'create'} disabled={!name.trim()} />
        </View>
      </Card>

      {shared.length ? (
        <Card>
          <H2>Von Freunden geteilt</H2>
          {shared.map((p) => (
            <PackRow key={p.id} pack={p} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

function ChoiceRow({ title, sub, active, busy, onPress }: { title: string; sub: string; active: boolean; busy: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={active || busy}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      style={({ pressed }) => [s.row, active && s.rowActive, pressed && { opacity: 0.8 }]}
    >
      <Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={20} color={active ? colors.accent : colors.muted} />
      <View style={{ flex: 1 }}>
        <Text style={s.title}>{title}</Text>
        <Text style={s.sub}>{sub}</Text>
      </View>
      {busy ? <Text style={s.sub}>…</Text> : null}
    </Pressable>
  );
}

function PackRow({ pack }: { pack: VoicePack }) {
  return (
    <Pressable onPress={() => router.push(`/voice/${pack.id}`)} style={({ pressed }) => [s.row, pressed && { opacity: 0.8 }]}>
      <Ionicons name="mic" size={20} color={colors.text} />
      <View style={{ flex: 1 }}>
        <Text style={s.title}>{pack.name}</Text>
        <Text style={s.sub}>
          {pack.mine ? '' : `von ${pack.ownerName} · `}
          {pack.keys.length} Ansagen eingesprochen
        </Text>
      </View>
      {pack.mine ? <Badge label={pack.shared ? 'Geteilt' : 'Privat'} color={pack.shared ? colors.info : colors.muted} /> : null}
      <Ionicons name="chevron-forward" size={16} color={colors.muted} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  rowActive: { borderColor: colors.accent },
  title: { color: colors.text, fontWeight: '700', fontSize: 15 },
  sub: { color: colors.muted, fontSize: 13 },
});

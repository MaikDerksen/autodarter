import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { describeSettings, type InOutMode, type MatchSettings, type MatchState, type MatchSummary } from '@shared';
import { Badge, Button, Card, ErrorText, H2, P, Row, Screen, Segmented, Stepper, styles as ui } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { boardBadge } from '@/lib/boardState';
import { useBoards, useRunningMatches } from '@/lib/hooks';
import { getItem, setItem } from '@/lib/storage';
import { colors, radius } from '@/lib/theme';

type Mode = '301' | '501' | 'cricket';

interface PlayerDraft {
  key: string;
  name: string;
  self: boolean;
}

const LAST_SETUP_KEY = 'autodarter.lastSetup';

export default function PlayScreen() {
  const { user } = useAuth();
  const boards = useBoards();
  const running = useRunningMatches();
  const [mode, setMode] = useState<Mode>('301');
  const [inMode, setInMode] = useState<InOutMode>('straight');
  const [outMode, setOutMode] = useState<InOutMode>('double');
  const [legs, setLegs] = useState(1);
  const [variant, setVariant] = useState<'standard' | 'cutthroat'>('standard');
  const [maxRounds, setMaxRounds] = useState(20);
  const [boardId, setBoardId] = useState<string | null | undefined>(undefined);
  const [players, setPlayers] = useState<PlayerDraft[]>([{ key: 'me', name: user?.displayName ?? 'Ich', self: true }]);
  const [guestName, setGuestName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // restore the last setup
  useEffect(() => {
    getItem(LAST_SETUP_KEY).then((raw) => {
      if (!raw) return;
      try {
        const s = JSON.parse(raw);
        if (s.mode) setMode(s.mode);
        if (s.inMode) setInMode(s.inMode);
        if (s.outMode) setOutMode(s.outMode);
        if (s.legs) setLegs(s.legs);
        if (s.variant) setVariant(s.variant);
        if (typeof s.maxRounds === 'number') setMaxRounds(s.maxRounds);
        if (s.boardId !== undefined) setBoardId(s.boardId);
        if (Array.isArray(s.guests)) {
          setPlayers((p) => [...p.filter((x) => x.self), ...s.guests.map((g: string, i: number) => ({ key: `g${i}${g}`, name: g, self: false }))]);
        }
      } catch {
        // ignore
      }
    });
  }, []);

  // default to the first online board
  useEffect(() => {
    if (boardId === undefined && boards.data) {
      setBoardId(boards.data.find((b) => b.online)?.id ?? null);
    }
    if (boardId && boards.data && !boards.data.some((b) => b.id === boardId)) setBoardId(null);
  }, [boards.data, boardId]);

  const addGuest = () => {
    const name = guestName.trim();
    if (!name || players.length >= 8) return;
    setPlayers((p) => [...p, { key: `${Date.now()}`, name, self: false }]);
    setGuestName('');
  };

  const movePlayer = (idx: number) => {
    if (idx === 0) return;
    setPlayers((p) => {
      const copy = p.slice();
      [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
      return copy;
    });
  };

  const settings: MatchSettings =
    mode === 'cricket'
      ? { mode: 'cricket', variant, legs, maxRounds }
      : { mode: 'x01', startScore: Number(mode), inMode, outMode, legs };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ match: MatchSummary; state: MatchState }>('/api/matches', {
        body: { settings, players: players.map((p) => ({ name: p.name, self: p.self })), boardId: boardId ?? null },
      });
      await setItem(
        LAST_SETUP_KEY,
        JSON.stringify({ mode, inMode, outMode, legs, variant, maxRounds, boardId, guests: players.filter((p) => !p.self).map((p) => p.name) }),
      );
      router.push(`/match/${res.match.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ioOptions: { value: InOutMode; label: string }[] = [
    { value: 'straight', label: 'Straight' },
    { value: 'double', label: 'Double' },
    { value: 'master', label: 'Master' },
  ];

  return (
    <Screen>
      {running.data && running.data.length > 0 ? (
        <Card>
          <H2>Laufende Spiele</H2>
          {running.data.map((m) => (
            <Pressable key={m.id} onPress={() => router.push(`/match/${m.id}`)} style={rowStyle}>
              <Ionicons name="play" size={18} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{describeSettings(m.settings)}</Text>
                <Text style={{ color: colors.muted }}>{m.players.map((p) => p.name).join(' vs. ')}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          ))}
        </Card>
      ) : null}

      <Card>
        <H2>Neues Spiel</H2>
        <Segmented<Mode>
          options={[
            { value: '301', label: '301' },
            { value: '501', label: '501' },
            { value: 'cricket', label: 'Cricket' },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode !== 'cricket' ? (
          <>
            <Text style={ui.label}>In</Text>
            <Segmented options={ioOptions} value={inMode} onChange={setInMode} />
            <Text style={ui.label}>Out</Text>
            <Segmented options={ioOptions} value={outMode} onChange={setOutMode} />
          </>
        ) : (
          <>
            <Text style={ui.label}>Variante</Text>
            <Segmented
              options={[
                { value: 'standard', label: 'Standard' },
                { value: 'cutthroat', label: 'Cut-Throat' },
              ]}
              value={variant}
              onChange={setVariant}
            />
            <Text style={ui.label}>Rundenlimit</Text>
            <Segmented
              options={[
                { value: 0, label: 'Ohne' },
                { value: 10, label: '10' },
                { value: 15, label: '15' },
                { value: 20, label: '20' },
              ]}
              value={maxRounds}
              onChange={setMaxRounds}
            />
          </>
        )}
        <Text style={ui.label}>Legs</Text>
        <Stepper value={legs} onChange={setLegs} min={1} max={11} format={(v) => (v === 1 ? '1 Leg' : `First to ${v}`)} />
      </Card>

      <Card>
        <H2>Spieler</H2>
        {players.map((p, i) => (
          <View key={p.key} style={rowStyle}>
            <Text style={{ color: colors.muted, width: 20, fontWeight: '800' }}>{i + 1}</Text>
            <Ionicons name={p.self ? 'person' : 'person-outline'} size={18} color={p.self ? colors.accent : colors.muted} />
            <Text style={{ color: colors.text, flex: 1, fontWeight: '600' }}>
              {p.name}
              {p.self ? '  (du)' : ''}
            </Text>
            {i > 0 ? <Button small variant="ghost" icon="arrow-up" onPress={() => movePlayer(i)} /> : null}
            {players.length > 1 ? (
              <Button small variant="ghost" icon="close" onPress={() => setPlayers((x) => x.filter((y) => y.key !== p.key))} />
            ) : null}
          </View>
        ))}
        {!players.some((p) => p.self) ? (
          <Button
            small
            variant="secondary"
            icon="person-add"
            title="Mich hinzufügen"
            onPress={() => setPlayers((x) => [{ key: 'me', name: user?.displayName ?? 'Ich', self: true }, ...x])}
          />
        ) : null}
        <Row>
          <TextInput
            value={guestName}
            onChangeText={setGuestName}
            placeholder="Gastspieler hinzufügen"
            placeholderTextColor={colors.faint}
            style={[ui.input, { flex: 1 }]}
            onSubmitEditing={addGuest}
          />
          <Button icon="add" onPress={addGuest} disabled={!guestName.trim() || players.length >= 8} />
        </Row>
      </Card>

      <Card>
        <H2>Board</H2>
        <Pressable onPress={() => setBoardId(null)} style={[rowStyle, boardId === null && selectedStyle]}>
          <Ionicons name="keypad" size={18} color={colors.text} />
          <Text style={{ color: colors.text, flex: 1, fontWeight: '600' }}>Ohne Board – manuelle Eingabe</Text>
          {boardId === null ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
        </Pressable>
        {(boards.data ?? []).map((b) => {
          const badge = boardBadge(b);
          return (
            <Pressable key={b.id} onPress={() => setBoardId(b.id)} style={[rowStyle, boardId === b.id && selectedStyle]}>
              <Ionicons name="videocam" size={18} color={colors.text} />
              <Text style={{ color: colors.text, flex: 1, fontWeight: '600' }}>{b.name}</Text>
              <Badge {...badge} />
              {boardId === b.id ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
            </Pressable>
          );
        })}
        {boards.data && boards.data.length === 0 ? (
          <P muted>Noch kein Board verbunden. Unter „Boards“ kannst du deinen Raspberry Pi hinzufügen.</P>
        ) : null}
      </Card>

      <ErrorText>{error}</ErrorText>
      <Button title={`Spiel starten · ${describeSettings(settings)}`} icon="play" onPress={start} loading={busy} />
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
const selectedStyle = { borderWidth: 1, borderColor: colors.accent };

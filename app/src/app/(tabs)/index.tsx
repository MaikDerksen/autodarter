import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import {
  describeSettings,
  type BoardActiveMatch,
  type BoardSummary,
  type AtcHits,
  type InOutMode,
  type MatchSettings,
  type MatchState,
  type MatchSummary,
} from '@shared';
import { OnlineDot } from '@/components/OnlineDot';
import { Badge, Button, Card, ErrorText, H2, P, Row, Screen, Segmented, Stepper, styles as ui } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { boardBadge } from '@/lib/boardState';
import { confirm } from '@/lib/confirm';
import { useFriends } from '@/lib/friends';
import { useBoards, useRunningMatches } from '@/lib/hooks';
import { live, useLiveMessages } from '@/lib/live';
import { getItem, setItem } from '@/lib/storage';
import { colors, radius } from '@/lib/theme';

type Mode = '301' | '501' | 'cricket' | 'atc';

interface PlayerDraft {
  key: string;
  name: string;
  self: boolean;
  /** friend with an account */
  userId?: string;
}

const LAST_SETUP_KEY = 'autodarter.lastSetup';

/** A board is free when nobody else is playing on it. */
function busyBy(board: BoardSummary, me: string | undefined): BoardActiveMatch | null {
  const a = board.activeMatch;
  return a && a.ownerId !== me ? a : null;
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export default function PlayScreen() {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const boards = useBoards();
  const running = useRunningMatches();
  const friends = useFriends();
  const [mode, setMode] = useState<Mode>('301');
  const [inMode, setInMode] = useState<InOutMode>('straight');
  const [outMode, setOutMode] = useState<InOutMode>('double');
  const [legs, setLegs] = useState(1);
  const [variant, setVariant] = useState<'standard' | 'cutthroat'>('standard');
  const [maxRounds, setMaxRounds] = useState(20);
  const [atcHits, setAtcHits] = useState<AtcHits>('any');
  const [atcSkip, setAtcSkip] = useState(false);
  const [atcBull, setAtcBull] = useState(true);
  const [boardId, setBoardId] = useState<string | null | undefined>(undefined);
  const lastBoard = useRef<string | null>(null);
  /** the user tapped a board (or "manual") – from then on no automatic choice */
  const userPicked = useRef(false);
  const [allPlayers, setPlayers] = useState<PlayerDraft[]>([{ key: 'me', name: user?.displayName ?? 'Ich', self: true }]);
  const [guestName, setGuestName] = useState('');
  const [showAllFriends, setShowAllFriends] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyInfo, setBusyInfo] = useState<BoardActiveMatch | null>(null);
  const [busy, setBusy] = useState(false);

  // restore the last setup (game options and players – the board is chosen automatically)
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
        if (s.atcHits) setAtcHits(s.atcHits);
        if (typeof s.atcSkip === 'boolean') setAtcSkip(s.atcSkip);
        if (typeof s.atcBull === 'boolean') setAtcBull(s.atcBull);
        if (typeof s.boardId === 'string') lastBoard.current = s.boardId;
        const restored: PlayerDraft[] = [];
        if (Array.isArray(s.guests)) {
          s.guests.forEach((g: string, i: number) => restored.push({ key: `g${i}${g}`, name: g, self: false }));
        }
        if (Array.isArray(s.friends)) {
          s.friends.forEach((f: { userId: string; name: string }) => restored.push({ key: `f${f.userId}`, name: f.name, self: false, userId: f.userId }));
        }
        if (restored.length) setPlayers((p) => [...p.filter((x) => x.self), ...restored].slice(0, 8));
      } catch {
        // ignore
      }
    });
  }, []);

  // live status of the boards (online / busy) while the screen is open
  useLiveMessages((msg) => {
    if (msg.type === 'board_status') boards.setData((list) => list?.map((b) => (b.id === msg.board.id ? msg.board : b)) ?? list);
  });
  const ids = (boards.data ?? []).map((b) => b.id).join(',');
  useEffect(() => {
    if (!ids) return;
    const unsubs = ids.split(',').map((id) => live.subscribeBoard(id));
    return () => unsubs.forEach((u) => u());
  }, [ids]);

  // Autodarts-style: always preselect a board that is online and free – manual input only if there is none.
  // Until the user picks a board this follows the boards' live status.
  useEffect(() => {
    if (!boards.data) return;
    const exists = !!boardId && boards.data.some((b) => b.id === boardId);
    if (userPicked.current && (boardId === null || exists)) return;
    const free = boards.data.filter((b) => b.online && !busyBy(b, user?.id));
    const pick = free.find((b) => b.id === lastBoard.current) ?? free[0] ?? boards.data.find((b) => b.online);
    const next = pick?.id ?? null;
    if (next !== boardId) setBoardId(next);
  }, [boards.data, boardId, user?.id]);

  const chooseBoard = (id: string | null) => {
    userPicked.current = true;
    setBoardId(id);
  };


  // friends that are no longer friends (or a restored setup from another account) drop out
  const friendIds = new Set(friends.friends.map((f) => f.id));
  const players = friends.loaded ? allPlayers.filter((p) => !p.userId || friendIds.has(p.userId)) : allPlayers;

  const addGuest = () => {
    const name = guestName.trim();
    if (!name || players.length >= 8) return;
    setPlayers((p) => [...p, { key: `${Date.now()}`, name, self: false }]);
    setGuestName('');
  };

  const addFriend = (f: { id: string; displayName: string }) => {
    if (players.length >= 8 || players.some((p) => p.userId === f.id)) return;
    setPlayers((p) => [...p, { key: `f${f.id}`, name: f.displayName, self: false, userId: f.id }]);
  };

  const movePlayer = (idx: number) => {
    if (idx === 0) return;
    const copy = players.slice();
    [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
    setPlayers(copy);
  };

  const settings: MatchSettings =
    mode === 'cricket'
      ? { mode: 'cricket', variant, legs, maxRounds }
      : mode === 'atc'
        ? { mode: 'atc', hits: atcHits, skip: atcSkip && atcHits === 'any', bull: atcBull, legs }
        : { mode: 'x01', startScore: Number(mode), inMode, outMode, legs };

  const start = async (force = false) => {
    setBusy(true);
    setError(null);
    setBusyInfo(null);
    try {
      const res = await api<{ match: MatchSummary; state: MatchState }>('/api/matches', {
        body: {
          settings,
          players: players.map((p) => (p.self ? { self: true } : p.userId ? { userId: p.userId } : { name: p.name })),
          boardId: boardId ?? null,
          force,
        },
      });
      await setItem(
        LAST_SETUP_KEY,
        JSON.stringify({
          mode,
          inMode,
          outMode,
          legs,
          variant,
          maxRounds,
          atcHits,
          atcSkip,
          atcBull,
          boardId,
          guests: players.filter((p) => !p.self && !p.userId).map((p) => p.name),
          friends: players.filter((p) => p.userId).map((p) => ({ userId: p.userId, name: p.name })),
        }),
      );
      router.push(`/match/${res.match.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.data.code === 'board_busy') {
        const info = e.data.activeMatch as BoardActiveMatch;
        if (e.data.canForce) {
          setBusy(false);
          if (await confirm('Laufendes Spiel beenden?', `${e.message} Soll es abgebrochen und das neue Spiel gestartet werden?`, 'Neu starten')) {
            return start(true);
          }
          return;
        }
        setBusyInfo(info);
      }
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

  const selectedBoard = boards.data?.find((b) => b.id === boardId);
  const inGame = new Set(players.map((p) => p.userId).filter(Boolean));
  const available = friends.friends.filter((f) => !inGame.has(f.id));
  const suggested = available.filter((f) => f.online);
  const others = available.filter((f) => !f.online);

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
            { value: 'atc', label: width < 420 ? 'Clock' : 'Around the Clock' },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode === 'atc' ? (
          <>
            <Text style={ui.label}>Was zählt</Text>
            <Segmented<AtcHits>
              options={[
                { value: 'any', label: 'Ganze Zahl' },
                { value: 'double', label: 'Nur Doubles' },
                { value: 'triple', label: 'Nur Triples' },
              ]}
              value={atcHits}
              onChange={setAtcHits}
            />
            {atcHits === 'any' ? (
              <>
                <Text style={ui.label}>Double / Triple springt 2 / 3 Zahlen weiter</Text>
                <Segmented<'on' | 'off'>
                  options={[
                    { value: 'off', label: 'Aus' },
                    { value: 'on', label: 'An' },
                  ]}
                  value={atcSkip ? 'on' : 'off'}
                  onChange={(v) => setAtcSkip(v === 'on')}
                />
              </>
            ) : null}
            <Text style={ui.label}>Zum Schluss</Text>
            <Segmented<'bull' | 'none'>
              options={[
                { value: 'bull', label: 'Bull treffen' },
                { value: 'none', label: 'Fertig nach der 20' },
              ]}
              value={atcBull ? 'bull' : 'none'}
              onChange={(v) => setAtcBull(v === 'bull')}
            />
          </>
        ) : mode !== 'cricket' ? (
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
            {p.userId ? (
              <OnlineDot online={!!friends.friends.find((f) => f.id === p.userId)?.online} />
            ) : (
              <Ionicons name={p.self ? 'person' : 'person-outline'} size={18} color={p.self ? colors.accent : colors.muted} />
            )}
            <Text style={{ color: colors.text, flex: 1, fontWeight: '600' }}>
              {p.name}
              {p.self ? '  (du)' : p.userId ? '' : '  (Gast)'}
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

        {suggested.length > 0 || others.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={ui.label}>{suggested.length ? 'Freunde online – Vorschläge' : 'Freunde'}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {[...suggested, ...(showAllFriends || !suggested.length ? others : [])].map((f) => (
                <Pressable key={f.id} onPress={() => addFriend(f)} style={[chipStyle, f.online && { borderColor: colors.accent }]} disabled={players.length >= 8}>
                  <OnlineDot online={f.online} size={8} />
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{f.displayName}</Text>
                  {f.playing ? <Text style={{ color: colors.warning, fontSize: 12 }}>spielt</Text> : null}
                  <Ionicons name="add" size={16} color={colors.muted} />
                </Pressable>
              ))}
              {suggested.length > 0 && others.length > 0 ? (
                <Pressable onPress={() => setShowAllFriends((v) => !v)} style={chipStyle}>
                  <Text style={{ color: colors.muted, fontWeight: '700' }}>{showAllFriends ? 'Weniger' : `+${others.length} offline`}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : friends.loaded && friends.friends.length === 0 ? (
          <Pressable onPress={() => router.push('/friends')}>
            <Text style={{ color: colors.info }}>Freunde hinzufügen, um mit ihren Konten zu spielen →</Text>
          </Pressable>
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
        {(boards.data ?? []).map((b) => {
          const badge = boardBadge(b);
          const other = busyBy(b, user?.id);
          return (
            <Pressable key={b.id} onPress={() => chooseBoard(b.id)} style={[rowStyle, boardId === b.id && selectedStyle]}>
              <Ionicons name="videocam" size={18} color={b.online ? colors.text : colors.faint} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>{b.name}</Text>
                {other ? (
                  <Text style={{ color: colors.warning, fontSize: 12 }}>
                    Belegt: {other.ownerName} spielt {other.title} · zuletzt vor {minutesAgo(other.lastActivity)} min
                  </Text>
                ) : b.activeMatch ? (
                  <Text style={{ color: colors.muted, fontSize: 12 }}>Dein Spiel läuft noch ({b.activeMatch.title})</Text>
                ) : b.role === 'member' ? (
                  <Text style={{ color: colors.muted, fontSize: 12 }}>Geteiltes Board</Text>
                ) : null}
              </View>
              <Badge {...(other ? { label: 'Belegt', color: colors.warning } : badge)} />
              {boardId === b.id ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
            </Pressable>
          );
        })}
        <Pressable onPress={() => chooseBoard(null)} style={[rowStyle, boardId === null && selectedStyle]}>
          <Ionicons name="keypad" size={18} color={colors.muted} />
          <Text style={{ color: colors.muted, flex: 1, fontWeight: '600' }}>Ohne Board – manuelle Eingabe</Text>
          {boardId === null ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
        </Pressable>
        {boards.data && boards.data.length === 0 ? (
          <P muted>Noch kein Board verbunden. Unter „Boards“ kannst du deinen Raspberry Pi hinzufügen.</P>
        ) : null}
        {selectedBoard && !selectedBoard.online ? <P muted>Das gewählte Board ist offline – Darts kannst du trotzdem per Hand eingeben.</P> : null}
      </Card>

      <ErrorText>{error}</ErrorText>
      {busyInfo ? (
        <Row wrap>
          <Button title="Zuschauen" variant="secondary" icon="eye" onPress={() => router.push(`/match/${busyInfo.id}`)} />
          {boardId ? (
            <Button
              title="Hängt das Spiel? Auf der Board-Seite beenden"
              variant="ghost"
              icon="stop-circle"
              onPress={() => router.push(`/board/${boardId}`)}
            />
          ) : null}
        </Row>
      ) : null}
      <Button title={`Spiel starten · ${describeSettings(settings)}`} icon="play" onPress={() => start()} loading={busy} />
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
const chipStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 6,
  paddingVertical: 6,
  paddingHorizontal: 12,
  borderRadius: 999,
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.bg,
};

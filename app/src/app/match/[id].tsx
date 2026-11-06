import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  describeSettings,
  segmentCenter,
  type DartView,
  type MatchState,
  type MatchStatus,
  type MatchSummary,
  type Segment,
  type TurnView,
} from '@shared';
import { Dartboard, type BoardHit } from '@/components/Dartboard';
import { Keypad } from '@/components/Keypad';
import { CricketScoreboard, X01Scoreboard } from '@/components/Scoreboards';
import { Badge, Button, Card, ErrorText, H2, Loading, P, Row, Screen, Segmented, Stat } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { boardBadge } from '@/lib/boardState';
import { callerAvailable, say } from '@/lib/caller';
import { confirm } from '@/lib/confirm';
import { useBoardLive, useMatchLive } from '@/lib/live';
import { getItem, setItem } from '@/lib/storage';
import { colors, radius } from '@/lib/theme';

const DART_COLORS = ['#38bdf8', '#facc15', '#f472b6'];

function hitsFor(darts: DartView[], faded = false): BoardHit[] {
  const out: BoardHit[] = [];
  darts.forEach((d, i) => {
    const pos = d.x !== undefined && d.y !== undefined ? { x: d.x, y: d.y } : segmentCenter(d.seg);
    if (pos) out.push({ ...pos, color: faded ? '#94a3b8' : DART_COLORS[i % 3], label: String(i + 1) });
  });
  return out;
}

function previousTurn(state: MatchState): TurnView | null {
  for (let l = state.legs.length - 1; l >= 0; l--) {
    const turns = state.legs[l].turns;
    if (turns.length) return turns[turns.length - 1];
  }
  return null;
}

function callText(state: MatchState, turn: TurnView): string | null {
  if (state.settings.mode === 'x01') {
    if (turn.bust) return 'Bust';
    if (turn.checkout) return state.finished ? 'Game shot, and the match!' : 'Game shot!';
    return turn.points === 0 ? 'No score' : String(turn.points);
  }
  if (state.finished) return 'Game shot, and the match!';
  return null;
}

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [state, setState] = useState<MatchState | null>(null);
  const [status, setStatus] = useState<MatchStatus>('running');
  const [inputMode, setInputMode] = useState<'board' | 'keypad'>('board');
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [callerOn, setCallerOn] = useState(false);
  const announced = useRef<Set<number> | null>(null);

  const board = useBoardLive(match?.boardId ?? null);

  useEffect(() => {
    getItem('autodarter.input').then((v) => (v === 'keypad' || v === 'board') && setInputMode(v));
    getItem('autodarter.caller').then((v) => setCallerOn(v === '1'));
  }, []);

  const applyState = useCallback((s: MatchState) => setState(s), []);

  useEffect(() => {
    if (!id) return;
    api<{ match: MatchSummary; state: MatchState }>(`/api/matches/${id}`)
      .then((r) => {
        setMatch(r.match);
        setStatus(r.match.status);
        applyState(r.state);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [id, applyState]);

  useMatchLive(id, (m) => {
    applyState(m.state);
    setStatus(m.status);
  });

  // caller: announce completed turns once
  useEffect(() => {
    if (!state) return;
    const candidates: TurnView[] = [];
    const prev = previousTurn(state);
    if (prev) candidates.push(prev);
    if (state.turn.complete) candidates.push(state.turn);
    if (announced.current === null) {
      announced.current = new Set(candidates.filter((t) => t.darts.length).map((t) => t.darts[0].eventIndex));
      return;
    }
    for (const t of candidates) {
      if (!t.darts.length || !t.complete) continue;
      const key = t.darts[0].eventIndex;
      if (announced.current.has(key)) continue;
      announced.current.add(key);
      const text = callText(state, t);
      if (callerOn && text) say(text);
    }
  }, [state, callerOn]);

  const run = async (fn: () => Promise<{ state?: MatchState } | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = (await fn()) as { state?: MatchState };
      if (res?.state) applyState(res.state);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const throwSegment = (seg: Segment) => {
    if (selected !== null) {
      const index = selected;
      setSelected(null);
      return run(() => api(`/api/matches/${id}/events/${index}`, { method: 'PUT', body: { segment: seg } }));
    }
    return run(() => api(`/api/matches/${id}/darts`, { body: { segment: seg } }));
  };

  if (!state || !match) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {error ? <ErrorText>{error}</ErrorText> : <Loading label="Spiel wird geladen …" />}
      </View>
    );
  }

  const player = state.players[state.currentPlayer];
  const turnDarts = state.turn.darts;
  const prev = previousTurn(state);
  const showPrev = turnDarts.length === 0 && prev && prev.darts.length > 0;
  const editableDarts = showPrev ? prev!.darts : turnDarts;
  const boardHits = [...(showPrev ? hitsFor(prev!.darts, true) : []), ...hitsFor(turnDarts)];
  const badge = match.boardId ? boardBadge(board.board) : null;
  const legWinner = state.legFinished && !state.finished ? state.legs[state.legs.length - 1].winner : null;
  const boardSize = Math.min(wide ? Math.min(520, (width - 64) * 0.45) : width - 32, 520);
  const cricketTargets = state.settings.mode === 'cricket' ? state.cricket?.targets : undefined;

  const toggleInput = (v: 'board' | 'keypad') => {
    setInputMode(v);
    void setItem('autodarter.input', v);
  };
  const toggleCaller = () => {
    const v = !callerOn;
    setCallerOn(v);
    void setItem('autodarter.caller', v ? '1' : '0');
    if (v) say('Game on');
  };

  const rematch = async () => {
    await run(async () => {
      const players = [...match.players.slice(1), match.players[0]].map((p) => ({ name: p.name, self: !!p.userId }));
      const res = await api<{ match: MatchSummary }>('/api/matches', {
        body: { settings: match.settings, players, boardId: match.boardId },
      });
      router.replace(`/match/${res.match.id}`);
    });
  };

  const abort = async () => {
    if (await confirm('Spiel abbrechen?', 'Das Spiel wird beendet und nicht in der Statistik gewertet.', 'Abbrechen')) {
      await run(() => api(`/api/matches/${id}/abort`, { body: {} }));
      router.back();
    }
  };

  const turnPanel = (
    <Card style={{ gap: 10 }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View>
          <Text style={s.turnTitle}>{state.finished ? 'Spiel beendet' : player.name}</Text>
          <Text style={s.turnSub}>
            Leg {state.legs.length} · Runde {state.round}
            {state.settings.mode === 'cricket' && state.settings.maxRounds ? ` / ${state.settings.maxRounds}` : ''}
          </Text>
        </View>
        {badge ? <Badge {...badge} icon="videocam" /> : <Badge label="Manuelle Eingabe" color={colors.info} icon="keypad" />}
      </Row>

      {showPrev ? <Text style={s.prevLabel}>Letzte Aufnahme · {state.players[prev!.player].name} (antippen zum Korrigieren)</Text> : null}
      <View style={s.slots}>
        {[0, 1, 2].map((i) => {
          const d = editableDarts[i];
          const isSel = d && selected === d.eventIndex;
          return (
            <Pressable
              key={i}
              disabled={!d}
              onPress={() => d && setSelected(isSel ? null : d.eventIndex)}
              style={[s.slot, d && { borderColor: showPrev ? colors.border : DART_COLORS[i] }, isSel && s.slotSelected]}
            >
              <Text style={[s.slotText, !d && { color: colors.faint }]}>{d ? d.label : '–'}</Text>
              {d && state.settings.mode === 'x01' ? <Text style={s.slotPts}>{d.points}</Text> : null}
            </Pressable>
          );
        })}
        <View style={[s.slot, s.total]}>
          <Text style={s.slotText}>
            {showPrev ? (prev!.bust ? 'BUST' : prev!.points) : state.turn.bust ? 'BUST' : state.turn.points}
          </Text>
          <Text style={s.slotPts}>{state.settings.mode === 'x01' ? 'Punkte' : `${showPrev ? prev!.marks : state.turn.marks} Marks`}</Text>
        </View>
      </View>
      {selected !== null ? (
        <Row>
          <Ionicons name="create" size={16} color={colors.warning} />
          <Text style={{ color: colors.warning, flex: 1 }}>Korrektur: wähle das richtige Segment</Text>
          <Button small variant="ghost" title="Abbrechen" onPress={() => setSelected(null)} />
        </Row>
      ) : null}

      {state.checkout ? (
        <Row wrap>
          <Text style={s.checkoutLabel}>Checkout</Text>
          {state.checkout.map((c, i) => (
            <View key={i} style={s.chip}>
              <Text style={s.chipText}>{c}</Text>
            </View>
          ))}
        </Row>
      ) : null}

      {state.awaitingNext && match.boardId ? (
        <P muted>{state.legFinished ? 'Leg beendet.' : 'Aufnahme beendet.'} Darts ziehen – oder „Weiter“ drücken.</P>
      ) : null}

      <Row wrap>
        <Button title="Rückgängig" icon="arrow-undo" variant="secondary" onPress={() => run(() => api(`/api/matches/${id}/undo`, { body: {} }))} disabled={busy || state.eventCount === 0} />
        <Button
          title={state.legFinished ? 'Nächstes Leg' : 'Weiter'}
          icon="play-forward"
          variant={state.awaitingNext ? 'primary' : 'secondary'}
          onPress={() => run(() => api(`/api/matches/${id}/next`, { body: {} }))}
          disabled={busy || state.finished}
          style={{ flexGrow: 1 }}
        />
      </Row>
      <ErrorText>{error}</ErrorText>
    </Card>
  );

  const inputPanel = (
    <Card style={{ alignItems: 'center' }}>
      <Segmented
        style={{ alignSelf: 'stretch' }}
        options={[
          { value: 'board', label: 'Board' },
          { value: 'keypad', label: 'Tastatur' },
        ]}
        value={inputMode}
        onChange={toggleInput}
      />
      {inputMode === 'board' ? (
        <Dartboard
          size={boardSize}
          hits={boardHits}
          highlight={cricketTargets}
          onSegment={state.finished || (state.awaitingNext && selected === null) ? undefined : (seg) => void throwSegment(seg)}
        />
      ) : (
        <Keypad onSegment={(seg) => void throwSegment(seg)} disabled={busy || state.finished || (state.awaitingNext && selected === null)} />
      )}
    </Card>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: describeSettings(state.settings),
          headerRight: () => (
            <Row style={{ marginRight: 8 }} gap={4}>
              {callerAvailable() ? (
                <Button small variant="ghost" icon={callerOn ? 'volume-high' : 'volume-mute'} onPress={toggleCaller} />
              ) : null}
              {status === 'running' ? <Button small variant="ghost" icon="close-circle" onPress={abort} /> : null}
            </Row>
          ),
        }}
      />
      <Screen maxWidth={1400}>
        {status === 'aborted' ? <ErrorText>Dieses Spiel wurde abgebrochen.</ErrorText> : null}
        {legWinner !== null ? (
          <View style={s.banner}>
            <Ionicons name="trophy" size={20} color={colors.warning} />
            <Text style={s.bannerText}>Leg an {state.players[legWinner].name}!</Text>
          </View>
        ) : null}
        {state.finished && state.winner !== null ? (
          <Card style={{ borderColor: colors.accent }}>
            <Row>
              <Ionicons name="trophy" size={28} color={colors.warning} />
              <H2 style={{ fontSize: 24 }}>{state.players[state.winner].name} gewinnt!</H2>
            </Row>
            <StatsTable state={state} />
            <Row wrap>
              <Button title="Revanche" icon="refresh" onPress={rematch} loading={busy} />
              <Button title="Zur Übersicht" variant="secondary" onPress={() => router.replace('/')} />
              <Button title="Letzten Wurf zurücknehmen" variant="ghost" icon="arrow-undo" onPress={() => run(() => api(`/api/matches/${id}/undo`, { body: {} }))} />
            </Row>
          </Card>
        ) : null}
        <View style={wide ? s.wide : s.narrow}>
          <View style={{ flex: wide ? 1.1 : undefined, gap: 16 }}>
            {state.settings.mode === 'x01' ? <X01Scoreboard state={state} compact={!wide && state.players.length > 2} /> : <CricketScoreboard state={state} />}
            {turnPanel}
          </View>
          <View style={{ flex: wide ? 0.9 : undefined, gap: 16 }}>{inputPanel}</View>
        </View>
      </Screen>
    </>
  );
}

function StatsTable({ state }: { state: MatchState }) {
  const x01 = state.settings.mode === 'x01';
  return (
    <View style={{ gap: 10 }}>
      {state.players.map((p, i) => {
        const st = state.stats[i];
        return (
          <View key={p.id} style={{ gap: 6 }}>
            <Text style={{ color: colors.text, fontWeight: '800' }}>{p.name}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {x01 ? (
                <>
                  <Stat label="Average" value={st.average.toFixed(2)} />
                  <Stat label="First 9" value={st.first9Average.toFixed(2)} />
                  <Stat label="Höchste Aufnahme" value={st.highestTurn} />
                  <Stat label="180 / 140+ / 100+" value={`${st.t180} / ${st.t140} / ${st.t100}`} />
                  <Stat label="Checkout" value={`${st.checkoutRate.toFixed(0)} %`} sub={`${st.checkouts}/${st.dartsAtDouble} Darts`} />
                  <Stat label="Bestes Leg" value={st.bestLegDarts ?? '–'} sub="Darts" />
                </>
              ) : (
                <>
                  <Stat label="MPR" value={st.mpr.toFixed(2)} />
                  <Stat label="Marks" value={st.marks} />
                  <Stat label="Darts" value={st.dartsThrown} />
                </>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wide: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  narrow: { gap: 16 },
  turnTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  turnSub: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  prevLabel: { color: colors.muted, fontSize: 13 },
  slots: { flexDirection: 'row', gap: 8 },
  slot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    minHeight: 72,
  },
  slotSelected: { borderColor: colors.warning, backgroundColor: '#2a1f05' },
  slotText: { color: colors.text, fontSize: 24, fontWeight: '900' },
  slotPts: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  total: { backgroundColor: colors.surfaceAlt, borderColor: colors.surfaceAlt },
  checkoutLabel: { color: colors.muted, fontWeight: '700', marginRight: 4 },
  chip: { backgroundColor: colors.accentDim, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  chipText: { color: '#bbf7d0', fontWeight: '800' },
  banner: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    backgroundColor: '#2a1f05',
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  bannerText: { color: colors.warning, fontWeight: '800', fontSize: 16 },
});

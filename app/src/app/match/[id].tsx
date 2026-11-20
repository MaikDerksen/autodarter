import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  atcTarget,
  dartKey,
  dartSay,
  describeSettings,
  scoreKey,
  scoreSay,
  segmentCenter,
  type BoardSummary,
  type DartView,
  type MatchState,
  type MatchStatus,
  type MatchSummary,
  type Segment,
  type TurnView,
} from '@shared';
import { BoardTools } from '@/components/BoardTools';
import { Dartboard, type BoardHit } from '@/components/Dartboard';
import { Keypad } from '@/components/Keypad';
import { AtcScoreboard, CricketScoreboard, X01Scoreboard } from '@/components/Scoreboards';
import { Badge, Button, Card, ErrorText, H2, Loading, Row, Screen, Segmented, Stat } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { boardBadge } from '@/lib/boardState';
import { useAuth } from '@/lib/auth';
import { announce, callerAvailable, type Call } from '@/lib/caller';
import { confirm } from '@/lib/confirm';
import { useBoardLive, useMatchLive } from '@/lib/live';
import { getItem, setItem } from '@/lib/storage';
import { colors, radius } from '@/lib/theme';

/** How long the finished turn stays visible before the next player is shown (matches without board). */
const TURN_HOLD_MS = 1800;

/** 'virtual' = drawn board, otherwise the camera index of the frontal camera view. */
type BoardView = 'virtual' | number;

function hitsFor(darts: DartView[]): BoardHit[] {
  const out: BoardHit[] = [];
  darts.forEach((d, i) => {
    const pos = d.x !== undefined && d.y !== undefined ? { x: d.x, y: d.y } : segmentCenter(d.seg);
    // a dart that fell out stays visible where it was, greyed out (it scores nothing)
    if (pos) out.push({ ...pos, label: String(i + 1), ...(d.out ? { color: '#6b7280' } : {}) });
  });
  return out;
}

/** Second line of a dart slot: why a dart is a MISS by rule. */
function outLabel(d: DartView): string | null {
  return d.out === 'bounce' ? 'Abpraller' : d.out === 'fall' ? 'rausgefallen' : null;
}

function previousTurn(state: MatchState): TurnView | null {
  for (let l = state.legs.length - 1; l >= 0; l--) {
    const turns = state.legs[l].turns;
    if (turns.length) return turns[turns.length - 1];
  }
  return null;
}

const GAME_SHOT: Call = { key: 'game_shot', text: 'Game shot!' };
const GAME_SHOT_MATCH: Call = { key: 'game_shot_match', text: 'Game shot, and the match!' };

/** Call for a finished turn: x01 announces the score, all modes the won leg / match. */
function turnCall(state: MatchState, turn: TurnView, wonLeg: boolean): Call | null {
  if (state.settings.mode === 'x01') {
    if (turn.bust) return { key: 'bust', text: 'Bust' };
    if (turn.checkout) {
      const shot = state.finished ? GAME_SHOT_MATCH : GAME_SHOT;
      // a recorded "Big Fish" replaces the game shot call on a 170 checkout
      return turn.points === 170 ? { key: 'big_fish', text: shot.text } : shot;
    }
    return { key: scoreKey(turn.points), text: scoreSay(turn.points) };
  }
  if (state.finished) return GAME_SHOT_MATCH;
  return wonLeg ? GAME_SHOT : null;
}

/** Highlighted numbers: cricket = still in play, around the clock = the next target of the player. */
function openTargets(state: MatchState, player: number): number[] | undefined {
  if (state.settings.mode === 'atc') {
    const t = atcTarget(state, player);
    return t === null ? [] : [t];
  }
  const c = state.cricket;
  if (state.settings.mode !== 'cricket' || !c) return undefined;
  return c.targets.filter((_, ti) => !c.marks.every((m) => m[ti] >= 3));
}

/** Status ring like on the real board: green = throw, orange = pull darts, red = not ready. */
function ringColor(board: BoardSummary | null, state: MatchState, status: MatchStatus): string | null {
  if (status !== 'running' || state.finished) return null;
  if (!board || !board.online) return colors.danger;
  const s = board.status?.state;
  if (state.awaitingNext || s === 'takeout' || s === 'takeout_in_progress') return colors.warning;
  if (s === 'throw' && board.status?.detecting) return colors.accent;
  return colors.danger;
}

/** Why the board does not count darts right now – null while everything is fine. */
function boardProblem(board: BoardSummary): string | null {
  if (!board.online) return 'Board ist offline';
  const s = board.status;
  if (!s) return null;
  if (!s.detecting) return 'Erkennung ist gestoppt';
  if (s.state === 'calibration_needed') return 'Board muss kalibriert werden';
  if (s.state === 'error') return 'Board meldet einen Fehler';
  if (s.cameras.some((c) => !c.ok)) return 'Eine Kamera liefert kein Bild';
  return null;
}

export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [match, setMatch] = useState<MatchSummary | null>(null);
  const [state, setState] = useState<MatchState | null>(null);
  const [status, setStatus] = useState<MatchStatus>('running');
  const [canControl, setCanControl] = useState(true);
  const [inputMode, setInputMode] = useState<'board' | 'keypad'>('board');
  const [chosenView, setView] = useState<BoardView>('virtual');
  const [chosenDart, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [callerOn, setCallerOn] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [myBoards, setMyBoards] = useState<BoardSummary[] | null>(null);
  /** finished turn that is still shown for a moment after the switch to the next player */
  const [hold, setHold] = useState<TurnView | null>(null);
  const announced = useRef<Set<string> | null>(null);
  const stateRef = useRef<MatchState | null>(null);
  const boardRef = useRef<string | null>(null);

  const [frontCam, setFrontCam] = useState<number | null>(null);
  // remote play: show the board of the player whose turn it is
  const turnPlayer = state ? (hold && state.turn.darts.length === 0 ? hold.player : state.currentPlayer) : 0;
  const viewBoardId = (state?.players[turnPlayer]?.boardId ?? match?.boardId) || null;
  const live = useBoardLive(viewBoardId, { front: frontCam });
  const board = live.board;
  // the chosen camera may be gone / not calibrated -> virtual board
  const cams = (board?.status?.cameras ?? []).filter((c) => c.calibrated);
  const view: BoardView = typeof chosenView === 'number' && board && !cams.some((c) => c.index === chosenView) ? 'virtual' : chosenView;
  const wantedFront = typeof view === 'number' ? view : null;
  if (wantedFront !== frontCam) setFrontCam(wantedFront);
  // without a board the next player is up right after the 3rd dart – keep the finished turn visible for a moment
  const shownTurn: TurnView | null = state ? (hold && state.turn.darts.length === 0 ? hold : state.turn) : null;
  const holding = !!state && shownTurn !== state.turn;
  // a correction only makes sense for darts of the visible turn
  const selected = chosenDart !== null && shownTurn?.darts.some((d) => d.eventIndex === chosenDart) ? chosenDart : null;

  useEffect(() => {
    getItem('autodarter.input').then((v) => (v === 'keypad' || v === 'board') && setInputMode(v));
    getItem('autodarter.caller').then((v) => setCallerOn(v === '1'));
    getItem('autodarter.view').then((v) => v && v !== 'virtual' && Number.isInteger(Number(v)) && setView(Number(v)));
  }, []);

  const applyState = useCallback((s: MatchState) => {
    const old = stateRef.current;
    stateRef.current = s;
    setState(s);
    if (!old || boardRef.current) return;
    // the turn of the previous player just ended (3rd dart, bust or checkout) -> show it briefly
    const prev = previousTurn(s);
    const last = prev?.darts[prev.darts.length - 1];
    if (s.eventCount > old.eventCount && s.turn.darts.length === 0 && prev?.complete && last && last.eventIndex >= old.eventCount) {
      setHold(prev);
    }
  }, []);

  // release the held turn after a moment (not while one of its darts is being corrected)
  useEffect(() => {
    if (!hold || chosenDart !== null) return;
    const t = setTimeout(() => setHold(null), TURN_HOLD_MS);
    return () => clearTimeout(t);
  }, [hold, chosenDart]);

  useEffect(() => {
    if (!id) return;
    api<{ match: MatchSummary; state: MatchState; canControl: boolean }>(`/api/matches/${id}`)
      .then((r) => {
        boardRef.current = r.match.boardId;
        setMatch(r.match);
        setStatus(r.match.status);
        setCanControl(r.canControl);
        applyState(r.state);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [id, applyState]);

  useMatchLive(id, (m) => {
    applyState(m.state);
    setStatus(m.status);
  });

  // caller: x01 announces every finished turn, cricket every single dart – each only once
  useEffect(() => {
    if (!state) return;
    const perDart = state.settings.mode !== 'x01';
    const items: { key: string; call: Call | null; player: number }[] = [];
    for (const t of [previousTurn(state), state.turn]) {
      if (!t || !t.darts.length) continue;
      if (perDart) {
        t.darts.forEach((d) => items.push({ key: `d${d.eventIndex}`, call: { key: dartKey(d.seg), text: dartSay(d.seg) }, player: t.player }));
      }
      const wonLeg = t === state.turn && state.legFinished;
      if (t.complete) items.push({ key: `t${t.darts[t.darts.length - 1].eventIndex}`, call: turnCall(state, t, wonLeg), player: t.player });
    }
    if (announced.current === null) {
      announced.current = new Set(items.map((i) => i.key));
      return;
    }
    // undo: forget what was taken back, so it is called again when it is thrown again
    for (const key of [...announced.current]) if (Number(key.slice(1)) >= state.eventCount) announced.current.delete(key);
    for (const it of items) {
      if (announced.current.has(it.key)) continue;
      announced.current.add(it.key);
      // every player is announced with their own voice (chosen when the match was created)
      if (callerOn && it.call) announce(match?.voices?.[it.player] ?? match?.voice, it.call);
    }
  }, [state, callerOn, match?.voice, match?.voices]);

  // somebody joined: reload the match (names, voices)
  const playerCount = state?.players.length ?? 0;
  useEffect(() => {
    if (!id || !match || !playerCount || match.players.length === playerCount) return;
    api<{ match: MatchSummary; canControl: boolean }>(`/api/matches/${id}`)
      .then((r) => {
        setMatch(r.match);
        setCanControl(r.canControl);
      })
      .catch(() => undefined);
  }, [id, match, playerCount]);

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

  const turn = shownTurn ?? state.turn;
  const player = state.players[holding ? turn.player : state.currentPlayer];
  const turnDarts = turn.darts;
  const badge = viewBoardId ? boardBadge(board) : null;
  const legWinner = state.legFinished && !state.finished ? state.legs[state.legs.length - 1].winner : null;
  const boardSize = Math.min(wide ? Math.min(520, (width - 64) * 0.45) : width - 32, 520);
  const targets = openTargets(state, holding ? turn.player : state.currentPlayer);
  const atc = state.settings.mode === 'atc';
  const myIndex = user ? state.players.findIndex((p) => p.userId === user.id) : -1;
  const turnBoardName = state.players[turn.player]?.boardId ? state.players[turn.player]?.boardName : null;
  const ring = viewBoardId ? ringColor(board, state, status) : null;
  const frontFrame = typeof view === 'number' ? live.frontFrames[view] : undefined;
  const inputLocked = !canControl || state.finished || (state.awaitingNext && selected === null);
  // technical tools (reset, calibration, restart) for board members while the match runs
  const tools = !!viewBoardId && !!board && board.role !== 'guest' && status === 'running' && !state.finished;
  const problem = tools && board ? boardProblem(board) : null;

  const toggleInput = (v: 'board' | 'keypad') => {
    setInputMode(v);
    void setItem('autodarter.input', v);
  };
  const changeView = (v: BoardView) => {
    setView(v);
    void setItem('autodarter.view', String(v));
  };
  const toggleCaller = () => {
    const v = !callerOn;
    setCallerOn(v);
    void setItem('autodarter.caller', v ? '1' : '0');
    if (v) announce(match.voice, { key: 'game_on', text: 'Game on' });
  };

  const openRemote = () => {
    setRemoteOpen(!remoteOpen);
    if (!myBoards) {
      api<BoardSummary[]>('/api/boards')
        .then(setMyBoards)
        .catch((e) => setError(errorMessage(e)));
    }
  };
  const chooseBoard = (boardId: string | null) =>
    run(async () => {
      const res = await api<{ match: MatchSummary; state: MatchState }>(`/api/matches/${id}/players/${myIndex}/board`, {
        method: 'PUT',
        body: { boardId },
      });
      setMatch(res.match);
      setRemoteOpen(false);
      return res;
    });

  const rematch = async () => {
    await run(async () => {
      const players = [...match.players.slice(1), match.players[0]].map((p) => (p.userId ? { userId: p.userId } : { name: p.name }));
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

  // One line with a fixed height below the dart slots – the panel never changes its size.
  let info: ReactNode = null;
  if (error) {
    info = (
      <>
        <Ionicons name="alert-circle" size={16} color={colors.danger} />
        <Text style={[s.infoText, { color: '#fecaca' }]} numberOfLines={1}>
          {error}
        </Text>
      </>
    );
  } else if (selected !== null) {
    info = (
      <>
        <Ionicons name="create" size={16} color={colors.warning} />
        <Text style={[s.infoText, { color: colors.warning }]} numberOfLines={1}>
          Korrektur: tippe das richtige Segment
        </Text>
        <Button small variant="ghost" title="Abbrechen" onPress={() => setSelected(null)} />
      </>
    );
  } else if (holding) {
    info = (
      <>
        <Ionicons name="arrow-forward-circle" size={16} color={colors.accent} />
        <Text style={[s.infoText, { color: colors.accent }]} numberOfLines={1}>
          {legWinner !== null ? `Leg an ${state.players[legWinner].name}! ` : ''}Gleich ist {state.players[state.currentPlayer].name} dran …
        </Text>
      </>
    );
  } else if (problem) {
    info = (
      <>
        <Ionicons name="warning" size={16} color={colors.danger} />
        <Text style={[s.infoText, { color: '#fecaca' }]} numberOfLines={1}>
          {problem}
        </Text>
        <Button small variant="secondary" icon="construct" title="Technik" onPress={() => setToolsOpen(true)} />
      </>
    );
  } else if (!canControl) {
    info = (
      <>
        <Ionicons name="eye" size={16} color={colors.muted} />
        <Text style={s.infoText}>Du schaust zu – eingeben können nur die Mitspieler.</Text>
      </>
    );
  } else if (legWinner !== null) {
    info = (
      <>
        <Ionicons name="trophy" size={16} color={colors.warning} />
        <Text style={[s.infoText, { color: colors.warning, fontWeight: '800' }]} numberOfLines={1}>
          Leg an {state.players[legWinner].name}!{match.boardId ? ' Darts ziehen – dann geht es weiter.' : ''}
        </Text>
      </>
    );
  } else if (atc && !state.awaitingNext && !state.finished && atcTarget(state, state.currentPlayer) !== null) {
    const t = atcTarget(state, state.currentPlayer);
    info = (
      <>
        <Text style={s.checkoutLabel}>Ziel</Text>
        <View style={s.chip}>
          <Text style={s.chipText}>{t === 25 ? 'Bull' : t}</Text>
        </View>
        <Text style={[s.infoText, { color: colors.faint }]} numberOfLines={1}>
          {state.settings.mode === 'atc' && state.settings.hits !== 'any' ? (state.settings.hits === 'double' ? 'nur Double' : 'nur Triple') : ''}
        </Text>
      </>
    );
  } else if (state.checkout && !state.awaitingNext) {
    info = (
      <>
        <Text style={s.checkoutLabel}>Checkout</Text>
        {state.checkout.map((c, i) => (
          <View key={i} style={s.chip}>
            <Text style={s.chipText}>{c}</Text>
          </View>
        ))}
      </>
    );
  } else if (state.awaitingNext && match.boardId && !state.finished) {
    info = (
      <>
        <Ionicons name="hand-left" size={16} color={colors.warning} />
        <Text style={[s.infoText, { color: colors.warning }]} numberOfLines={1}>
          Darts ziehen – danach ist {state.players[(state.currentPlayer + 1) % state.players.length].name} dran.
        </Text>
      </>
    );
  } else if (turnDarts.length > 0 && !state.finished) {
    info = (
      <Text style={[s.infoText, { color: colors.faint }]} numberOfLines={1}>
        Falsch erkannt? Dart antippen und korrigieren.
      </Text>
    );
  }

  const turnPanel = (
    <Card style={{ gap: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flexShrink: 1 }}>
          <Text style={s.turnTitle} numberOfLines={1}>
            {state.finished ? 'Spiel beendet' : player.name}
          </Text>
          <Text style={s.turnSub}>
            Leg {state.legs.length} · Runde {holding && state.currentPlayer <= turn.player ? Math.max(1, state.round - 1) : state.round}
            {state.settings.mode === 'cricket' && state.settings.maxRounds ? ` / ${state.settings.maxRounds}` : ''}
            {turnBoardName ? ` · an ${turnBoardName}` : ''}
          </Text>
        </View>
        {!canControl ? (
          <Badge label="Zuschauer" color={colors.muted} icon="eye" />
        ) : badge ? (
          <Badge {...badge} icon="videocam" />
        ) : (
          <Badge label="Manuelle Eingabe" color={colors.info} icon="keypad" />
        )}
      </Row>

      <View style={s.slots}>
        {[0, 1, 2].map((i) => {
          const d = turnDarts[i];
          const isSel = d && selected === d.eventIndex;
          return (
            <Pressable
              key={i}
              disabled={!d || !canControl}
              onPress={() => d && setSelected(isSel ? null : d.eventIndex)}
              style={[s.slot, d && s.slotFilled, isSel && s.slotSelected]}
            >
              <Text style={[s.slotText, !d && { color: colors.faint }]}>{d ? d.label : '–'}</Text>
              <Text style={[s.slotPts, atc && d ? { color: d.hit ? colors.accent : colors.faint } : null]}>
                {d && outLabel(d) ? outLabel(d) : d && state.settings.mode === 'x01' ? d.points : d && atc ? (d.hit ? 'Treffer' : 'daneben') : ' '}
              </Text>
            </Pressable>
          );
        })}
        <View style={[s.slot, s.total]}>
          <Text style={s.slotText}>{turn.bust ? 'BUST' : atc ? turn.marks : turn.points}</Text>
          <Text style={s.slotPts}>{state.settings.mode === 'x01' ? 'Punkte' : atc ? 'Treffer' : `${turn.marks} Marks`}</Text>
        </View>
      </View>

      <View style={s.info}>{info}</View>

      <Row>
        <Button
          title="Rückgängig"
          icon="arrow-undo"
          variant="secondary"
          onPress={() => run(() => api(`/api/matches/${id}/undo`, { body: {} }))}
          disabled={busy || !canControl || state.eventCount === 0}
        />
        <Button
          title={state.legFinished && !state.finished ? 'Nächstes Leg' : 'Weiter'}
          icon="play-forward"
          variant={state.awaitingNext && !state.finished ? 'primary' : 'secondary'}
          onPress={() => run(() => api(`/api/matches/${id}/next`, { body: {} }))}
          disabled={busy || !canControl || state.finished}
          style={{ flexGrow: 1 }}
        />
      </Row>
    </Card>
  );

  // remote play: a player throws at their own board (e.g. at home) – default is the board of the match
  const myBoard = myIndex >= 0 ? state.players[myIndex].boardId ?? null : null;
  const remotePanel =
    myIndex >= 0 && status === 'running' && !state.finished && match.boardId ? (
      <Card style={{ gap: 10 }}>
        <Pressable onPress={openRemote} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessibilityRole="button">
          <Ionicons name="globe-outline" size={18} color={myBoard ? colors.info : colors.muted} />
          <Text style={[s.infoText, { color: myBoard ? colors.text : colors.muted }]} numberOfLines={1}>
            {myBoard ? `Du wirfst remote an ${state.players[myIndex].boardName ?? 'deinem Board'}` : 'Remote spielen – an deinem eigenen Board werfen'}
          </Text>
          <Ionicons name={remoteOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.muted} />
        </Pressable>
        {remoteOpen ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.faint, fontSize: 13 }}>
              Standard: alle werfen am Board des Spiels. Wer woanders steht, wählt hier sein eigenes Board – gezählt wird dann immer das
              Board des Spielers, der dran ist.
            </Text>
            <View style={s.viewRow}>
              <Pressable onPress={() => chooseBoard(null)} style={[s.viewChip, !myBoard && s.viewChipActive]}>
                <Ionicons name="home" size={14} color={!myBoard ? colors.text : colors.muted} />
                <Text style={[s.viewChipText, !myBoard && { color: colors.text }]}>Board des Spiels</Text>
              </Pressable>
              {(myBoards ?? [])
                .filter((b) => b.id !== match.boardId)
                .map((b) => (
                  <Pressable
                    key={b.id}
                    onPress={() => chooseBoard(b.id)}
                    disabled={busy}
                    style={[s.viewChip, myBoard === b.id && s.viewChipActive, !b.online && { opacity: 0.5 }]}
                  >
                    <Ionicons name="videocam" size={14} color={myBoard === b.id ? colors.text : colors.muted} />
                    <Text style={[s.viewChipText, myBoard === b.id && { color: colors.text }]}>
                      {b.name}
                      {b.online ? '' : ' (offline)'}
                    </Text>
                  </Pressable>
                ))}
            </View>
            {myBoards && myBoards.filter((b) => b.id !== match.boardId).length === 0 ? (
              <Text style={{ color: colors.faint, fontSize: 13 }}>Du hast kein weiteres Board in deinem Konto.</Text>
            ) : null}
          </View>
        ) : null}
      </Card>
    ) : null;

  const viewOptions: { value: BoardView; label: string }[] = [
    { value: 'virtual', label: 'Virtuell' },
    ...cams.map((c) => ({ value: c.index as BoardView, label: `${width < 480 ? 'Cam' : 'Kamera'} ${c.index + 1}` })),
  ];
  const viewIssue = typeof view === 'number' ? cams.find((c) => c.index === view)?.issue : null;

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
        <>
          {viewBoardId && cams.length > 0 ? (
            <View style={s.viewRow}>
              {viewOptions.map((o) => {
                const active = o.value === view;
                return (
                  <Pressable key={String(o.value)} onPress={() => changeView(o.value)} style={[s.viewChip, active && s.viewChipActive]}>
                    <Ionicons
                      name={o.value === 'virtual' ? 'disc' : cams.find((c) => c.index === o.value)?.issue ? 'warning' : 'videocam'}
                      size={14}
                      color={o.value !== 'virtual' && cams.find((c) => c.index === o.value)?.issue ? colors.danger : active ? colors.text : colors.muted}
                    />
                    <Text style={[s.viewChipText, active && { color: colors.text }]}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {/* constant padding for the status ring glow, so nothing moves when it appears */}
          <View style={{ padding: viewBoardId ? 10 : 0 }}>
            <Dartboard
              size={boardSize - (viewBoardId ? 20 : 0)}
              hits={hitsFor(turnDarts)}
              targets={typeof view === 'number' ? undefined : targets}
              image={typeof view === 'number' ? (frontFrame?.uri ?? null) : null}
              ring={ring}
              onSegment={inputLocked ? undefined : (seg) => void throwSegment(seg)}
            />
          </View>
          {typeof view === 'number' && !frontFrame ? <Text style={s.viewHint}>Kamerabild wird geladen …</Text> : null}
          {viewIssue === 'mirrored' ? (
            <Text style={[s.viewHint, { color: colors.danger }]}>
              Die Kalibrierung dieser Kamera ist spiegelverkehrt – Bild und Markierungen passen nicht zusammen, ihre Darts werden ignoriert. Bitte neu
              kalibrieren.
            </Text>
          ) : viewIssue === 'inconsistent' ? (
            <Text style={[s.viewHint, { color: colors.warning }]}>Diese Kamera liegt oft neben den anderen – Kalibrierung prüfen.</Text>
          ) : typeof view === 'number' && frontFrame ? (
            <Text style={s.viewHint}>Die Zahlen markieren die Spitze – der Rest des Darts ragt aus dem Board und erscheint deshalb als langer Strich.</Text>
          ) : null}
        </>
      ) : (
        <Keypad onSegment={(seg) => void throwSegment(seg)} disabled={busy || inputLocked} />
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
              {tools ? <Button small variant="ghost" icon="construct-outline" onPress={() => setToolsOpen(true)} /> : null}
              {callerAvailable() ? (
                <Button small variant="ghost" icon={callerOn ? 'volume-high' : 'volume-mute'} onPress={toggleCaller} />
              ) : null}
              {status === 'running' && canControl ? <Button small variant="ghost" icon="close-circle" onPress={abort} /> : null}
            </Row>
          ),
        }}
      />
      <Screen maxWidth={1400}>
        {status === 'aborted' ? <ErrorText>Dieses Spiel wurde abgebrochen.</ErrorText> : null}
        {state.finished && state.winner !== null ? (
          <Card style={{ borderColor: colors.accent }}>
            <Row>
              <Ionicons name="trophy" size={28} color={colors.warning} />
              <H2 style={{ fontSize: 24 }}>{state.players[state.winner].name} gewinnt!</H2>
            </Row>
            <StatsTable state={state} />
            {canControl ? (
              <Row wrap>
                <Button title="Revanche" icon="refresh" onPress={rematch} loading={busy} />
                <Button title="Zur Übersicht" variant="secondary" onPress={() => router.replace('/')} />
                <Button
                  title="Letzten Wurf zurücknehmen"
                  variant="ghost"
                  icon="arrow-undo"
                  onPress={() => run(() => api(`/api/matches/${id}/undo`, { body: {} }))}
                />
              </Row>
            ) : null}
          </Card>
        ) : null}
        <View style={wide ? s.wide : s.narrow}>
          <View style={{ flex: wide ? 1.1 : undefined, gap: 16 }}>
            {state.settings.mode === 'x01' ? (
              <X01Scoreboard state={state} compact={!wide && state.players.length > 2} />
            ) : atc ? (
              <AtcScoreboard state={state} compact={!wide && state.players.length > 2} />
            ) : (
              <CricketScoreboard state={state} compact={!wide} />
            )}
            {turnPanel}
            {remotePanel}
          </View>
          <View style={{ flex: wide ? 0.9 : undefined, gap: 16 }}>{inputPanel}</View>
        </View>
      </Screen>
      {tools && board ? <BoardTools board={board} visible={toolsOpen} onClose={() => setToolsOpen(false)} /> : null}
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
  slots: { flexDirection: 'row', gap: 8 },
  slot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    height: 76,
  },
  slotFilled: { borderColor: '#3b4a5e', backgroundColor: colors.surfaceAlt },
  slotSelected: { borderColor: colors.warning, backgroundColor: '#2a1f05' },
  slotText: { color: colors.text, fontSize: 24, fontWeight: '900', lineHeight: 30 },
  slotPts: { color: colors.muted, fontSize: 12, fontWeight: '600', lineHeight: 16 },
  total: { backgroundColor: colors.surfaceAlt, borderColor: colors.surfaceAlt },
  info: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 8, overflow: 'hidden' },
  infoText: { color: colors.muted, fontSize: 14, flexShrink: 1, flexGrow: 1 },
  checkoutLabel: { color: colors.muted, fontWeight: '700', marginRight: 2 },
  chip: { backgroundColor: colors.accentDim, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  chipText: { color: '#bbf7d0', fontWeight: '800' },
  viewRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignSelf: 'stretch', justifyContent: 'center' },
  viewChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  viewChipActive: { borderColor: colors.accent, backgroundColor: '#0f2418' },
  viewChipText: { color: colors.muted, fontWeight: '700', fontSize: 13 },
  viewHint: { color: colors.faint, fontSize: 12 },
});

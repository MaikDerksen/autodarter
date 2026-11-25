import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { segmentLabel, type BugReportKind, type MatchState, type Segment } from '@shared';
import { api, errorMessage } from '@/lib/api';
import { colors, radius } from '@/lib/theme';
import { Keypad } from './Keypad';
import { Button, ErrorText } from './ui';

interface Candidate {
  eventIndex: number;
  label: string;
  dart: number;
  player: string;
}

type Choice = number | 'missed';

const sameSeg = (a: Segment, b: Segment) => a.number === b.number && a.multiplier === b.multiplier;

/** Darts of the last two turns, newest first (the running turn is not in legs[].turns yet). */
function candidates(state: MatchState): Candidate[] {
  const done = state.legs.flatMap((l) => l.turns);
  const turns = (state.turn.complete ? done : [...done, state.turn]).filter((t) => t.darts.length > 0);
  return turns
    .slice(-2)
    .flatMap((t) => t.darts.map((d, i) => ({ eventIndex: d.eventIndex, label: d.label, dart: i + 1, player: state.players[t.player]?.name ?? '?' })))
    .reverse();
}

/**
 * "Fehler melden": which dart was detected wrong (or not at all, or without being thrown) and what it
 * really was. The board sends the camera images of that dart along - for the analysis later.
 * Mounted only while open (every opening starts fresh).
 */
export function ReportBug({
  onClose,
  matchId,
  state,
  canControl,
  onState,
}: {
  onClose: () => void;
  matchId: string;
  state: MatchState;
  canControl: boolean;
  onState: (s: MatchState) => void;
}) {
  const insets = useSafeAreaInsets();
  const centred = useWindowDimensions().width >= 700;
  // the darts as they were when the dialog opened (the game may go on meanwhile)
  const [list] = useState<Candidate[]>(() => candidates(state));
  const [choice, setChoice] = useState<Choice>(list[0]?.eventIndex ?? 'missed');
  /** undefined: not said yet, null: no dart at all */
  const [actual, setActual] = useState<Segment | null | undefined>(undefined);
  const [note, setNote] = useState('');
  const [fix, setFix] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ images: number; boardError: string | null; fixed: string | null } | null>(null);

  const picked = typeof choice === 'number' ? list.find((c) => c.eventIndex === choice) ?? null : null;
  const kind: BugReportKind | null = useMemo(() => {
    if (choice === 'missed') return 'missed';
    if (actual === null) return 'phantom';
    if (actual) return 'wrong';
    return note.trim() ? 'other' : null;
  }, [choice, actual, note]);

  // what can be put right in the game at once
  const lastEvent = state.eventCount - 1;
  const fixable =
    canControl && !state.finished
      ? kind === 'wrong' && picked && actual && !sameSeg(actual, currentSeg(state, picked.eventIndex) ?? actual)
        ? `Im Spiel auf ${segmentLabel(actual)} korrigieren`
        : kind === 'phantom' && picked && picked.eventIndex === lastEvent
          ? 'Wurf aus dem Spiel entfernen (Rückgängig)'
          : kind === 'missed' && actual && !state.awaitingNext
            ? `${segmentLabel(actual)} im Spiel nachtragen`
            : null
      : null;

  const submit = async () => {
    if (!kind) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ id: string; images: number; boardError: string | null }>('/api/reports', {
        body: {
          matchId,
          eventIndex: typeof choice === 'number' ? choice : null,
          kind,
          actual: actual ?? null,
          note: note.trim() || undefined,
        },
      });
      let fixed: string | null = null;
      if (fix && fixable) {
        try {
          let r: { state?: MatchState } | null = null;
          if (kind === 'wrong' && typeof choice === 'number' && actual) {
            r = await api(`/api/matches/${matchId}/events/${choice}`, { method: 'PUT', body: { segment: actual } });
          } else if (kind === 'phantom' && choice === lastEvent) {
            r = await api(`/api/matches/${matchId}/undo`, { body: {} });
          } else if (kind === 'missed' && actual) {
            r = await api(`/api/matches/${matchId}/darts`, { body: { segment: actual } });
          }
          if (r?.state) onState(r.state);
          fixed = 'Im Spiel korrigiert.';
        } catch (e) {
          fixed = `Im Spiel nicht korrigiert: ${errorMessage(e)}`;
        }
      }
      setDone({ images: res.images, boardError: res.boardError, fixed });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <Pressable style={[s.backdrop, centred && { justifyContent: 'center' }]} onPress={close} accessibilityLabel="Schließen">
        <Pressable style={[s.sheet, { marginBottom: Math.max(16, insets.bottom) }]} onPress={() => undefined}>
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <View style={s.head}>
              <Ionicons name="bug" size={20} color={colors.text} />
              <Text style={s.title}>Fehler melden</Text>
              <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Schließen">
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>

            {done ? (
              <View style={{ gap: 12 }}>
                <View style={s.okBox}>
                  <Ionicons name="checkmark-circle" size={22} color={colors.accent} />
                  <Text style={s.okText}>
                    Danke! Gespeichert{done.images ? ` – mit ${done.images} Kamerabildern` : ''}.
                  </Text>
                </View>
                {done.boardError ? (
                  <View style={s.warnBox}>
                    <Ionicons name="warning" size={18} color={colors.warning} />
                    <Text style={s.warnText}>
                      {done.images ? 'Nicht alle Kamerabilder sind angekommen' : 'Ohne Kamerabilder gespeichert'}: {done.boardError}
                    </Text>
                  </View>
                ) : null}
                {done.fixed ? <Text style={s.hint}>{done.fixed}</Text> : null}
                <Button title="Fertig" onPress={onClose} />
              </View>
            ) : (
              <>
                <Text style={s.section}>Welcher Dart?</Text>
                <View style={s.chips}>
                  {list.map((c) => (
                    <Chip
                      key={c.eventIndex}
                      active={choice === c.eventIndex}
                      onPress={() => setChoice(c.eventIndex)}
                      label={`${c.label}`}
                      sub={`${c.player} · Dart ${c.dart}`}
                    />
                  ))}
                  <Chip active={choice === 'missed'} onPress={() => setChoice('missed')} label="Nicht erkannt" sub="Dart fehlt ganz" icon="eye-off" />
                </View>

                <Text style={s.section}>
                  {choice === 'missed' ? 'Was hat er getroffen?' : 'Was war es wirklich?'}
                  {actual !== undefined ? <Text style={s.picked}>  {actual === null ? 'kein Dart geworfen' : segmentLabel(actual)}</Text> : null}
                </Text>
                {choice !== 'missed' ? (
                  <View style={s.chips}>
                    <Chip
                      active={actual === null}
                      onPress={() => setActual(actual === null ? undefined : null)}
                      label="Kein Dart geworfen"
                      sub="Board hat sich einen ausgedacht"
                      icon="sparkles"
                    />
                  </View>
                ) : null}
                <Keypad onSegment={(seg) => setActual(seg)} />

                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Was ist passiert? (optional, z. B. stand vor dem Board, Licht an)"
                  placeholderTextColor={colors.faint}
                  multiline
                  maxLength={1000}
                  style={s.note}
                />

                {fixable ? (
                  <Pressable onPress={() => setFix(!fix)} style={s.check} accessibilityRole="checkbox" accessibilityState={{ checked: fix }}>
                    <Ionicons name={fix ? 'checkbox' : 'square-outline'} size={20} color={fix ? colors.accent : colors.muted} />
                    <Text style={s.checkText}>{fixable}</Text>
                  </Pressable>
                ) : null}

                <Text style={s.hint}>
                  Die Kameras schicken ihre Bilder von diesem Wurf mit – möglichst melden, bevor die nächsten Darts fliegen.
                </Text>
                <ErrorText>{error}</ErrorText>
                {busy ? (
                  <View style={s.busy}>
                    <ActivityIndicator color={colors.text} />
                    <Text style={s.hint}>Bilder werden vom Board geholt …</Text>
                  </View>
                ) : null}
                <Button title="Melden" icon="send" onPress={submit} disabled={!kind} loading={busy} />
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function currentSeg(state: MatchState, eventIndex: number): Segment | null {
  for (const t of [...state.legs.flatMap((l) => l.turns), state.turn]) for (const d of t.darts) if (d.eventIndex === eventIndex) return d.seg;
  return null;
}

function Chip({ active, onPress, label, sub, icon }: { active: boolean; onPress: () => void; label: string; sub: string; icon?: 'eye-off' | 'sparkles' }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: active }} style={[s.chip, active && s.chipActive]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon ? <Ionicons name={icon} size={14} color={active ? colors.text : colors.muted} /> : null}
        <Text style={[s.chipLabel, active && { color: colors.text }]}>{label}</Text>
      </View>
      <Text style={s.chipSub} numberOfLines={1}>
        {sub}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12 },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '92%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  content: { padding: 16, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', flex: 1 },
  section: { color: colors.muted, fontWeight: '700', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  picked: { color: colors.accent, textTransform: 'none', letterSpacing: 0, fontSize: 15, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    minWidth: 92,
    maxWidth: '100%',
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipLabel: { color: colors.muted, fontWeight: '800', fontSize: 16 },
  chipSub: { color: colors.faint, fontSize: 12 },
  note: {
    minHeight: 60,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 10,
    color: colors.text,
    backgroundColor: colors.bg,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  checkText: { color: colors.text, fontWeight: '600', flexShrink: 1 },
  hint: { color: colors.faint, fontSize: 13 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  okBox: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: radius.md, backgroundColor: colors.accentDim },
  okText: { color: colors.text, fontWeight: '700', flex: 1, fontSize: 15 },
  warnBox: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 10, borderRadius: radius.md, backgroundColor: '#2a1f05' },
  warnText: { color: '#fde68a', flex: 1, fontSize: 13 },
});

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardCommand, BoardSummary } from '@shared';
import { api, errorMessage } from '@/lib/api';
import { boardBadge } from '@/lib/boardState';
import { confirm } from '@/lib/confirm';
import { colors, radius } from '@/lib/theme';
import type { IconName } from './ui';

const DONE: Partial<Record<BoardCommand, string>> = {
  start: 'Erkennung läuft wieder.',
  reset: 'Erkennung zurückgesetzt – es kann weitergeworfen werden.',
  rescan: 'Kameras werden neu verbunden …',
  restart: 'Board-Client startet neu – gleich ist er wieder da.',
};

/**
 * Technical emergency tools for the board during a match: reset the detection, recalibrate a camera,
 * reconnect the cameras or restart the board client – without leaving the game.
 */
export function BoardTools({ board, visible, onClose }: { board: BoardSummary; visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  // phones: sheet at the bottom (thumb reach), tablets / PC: centred dialog
  const centred = useWindowDimensions().width >= 700;
  const [busy, setBusy] = useState<BoardCommand | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // the success line disappears after a moment
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 5000);
    return () => clearTimeout(t);
  }, [done]);

  const status = board.status;
  const online = board.online;
  const badge = boardBadge(board);
  const cams = status?.cameras ?? [];
  const stopped = online && status && !status.detecting;

  const command = async (action: BoardCommand) => {
    if (
      action === 'restart' &&
      !(await confirm('Board-Client neu starten?', 'Die Erkennung ist ein paar Sekunden weg. Das Spiel bleibt erhalten.', 'Neu starten'))
    ) {
      return;
    }
    setBusy(action);
    setError(null);
    setDone(null);
    try {
      await api(`/api/boards/${board.id}/command`, { body: { action } });
      setDone(DONE[action] ?? 'Erledigt.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const calibrate = (cam: number) => {
    onClose();
    router.push(`/calibrate/${board.id}?cam=${cam}`);
  };

  const close = () => {
    setDone(null);
    setError(null);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={[s.backdrop, centred && { justifyContent: 'center' }]} onPress={close} accessibilityLabel="Schließen">
        <Pressable style={[s.sheet, { marginBottom: Math.max(16, insets.bottom) }]} onPress={() => undefined}>
          <ScrollView contentContainerStyle={s.content}>
            <View style={s.head}>
              <Ionicons name="construct" size={20} color={colors.text} />
              <Text style={s.title}>Technik</Text>
              <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Schließen">
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>

            <View style={s.statusRow}>
              <View style={[s.dot, { backgroundColor: badge.color }]} />
              <Text style={s.statusText} numberOfLines={1}>
                {board.name} · {badge.label}
                {online && status ? ` · ${status.fps.toFixed(0)} FPS` : ''}
              </Text>
            </View>
            {online && status?.message ? <Text style={s.message}>{status.message}</Text> : null}

            {!online ? (
              <View style={s.warnBox}>
                <Ionicons name="cloud-offline" size={18} color={colors.warning} />
                <Text style={s.warnText}>
                  Das Board ist offline. Prüfe am Pi, ob der Board-Client läuft: docker exec autodarter-board autodarter
                </Text>
              </View>
            ) : null}

            {stopped ? (
              <Action
                icon="play"
                title="Erkennung starten"
                text="Die Erkennung ist gestoppt, deshalb werden keine Darts gezählt."
                onPress={() => command('start')}
                busy={busy === 'start'}
                disabled={!!busy}
                highlight
              />
            ) : null}

            <Action
              icon="refresh"
              title="Erkennung zurücksetzen"
              text="Hängt die Erkennung oder zählt falsch? Erst alle Darts aus dem Board ziehen, dann zurücksetzen."
              onPress={() => command('reset')}
              busy={busy === 'reset'}
              disabled={!online || !!busy}
            />

            <Action
              icon="locate"
              title="Neu kalibrieren"
              text="Landen Treffer an der falschen Stelle, z. B. weil eine Kamera verrutscht ist? Kamera wählen:"
              disabled={!online}
            >
              <View style={s.camRow}>
                {cams.length === 0 ? <Text style={s.actionText}>Keine Kamera gefunden.</Text> : null}
                {cams.map((c) => (
                  <Pressable
                    key={c.index}
                    onPress={() => calibrate(c.index)}
                    disabled={!online || !c.ok}
                    accessibilityRole="button"
                    style={({ pressed }) => [s.camChip, (!online || !c.ok) && { opacity: 0.45 }, pressed && { opacity: 0.7 }]}
                  >
                    <Ionicons
                      name={!c.ok ? 'alert-circle' : c.calibrated ? 'checkmark-circle' : 'ellipse-outline'}
                      size={15}
                      color={!c.ok ? colors.danger : c.calibrated ? colors.accent : colors.warning}
                    />
                    <Text style={s.camChipText}>Kamera {c.index + 1}</Text>
                  </Pressable>
                ))}
              </View>
            </Action>

            <Action
              icon="videocam"
              title="Kameras neu verbinden"
              text="Eine Kamera zeigt kein Bild mehr oder steht auf Fehler."
              onPress={() => command('rescan')}
              busy={busy === 'rescan'}
              disabled={!online || !!busy}
            />

            <Action
              icon="power"
              title="Board-Client neu starten"
              text="Wenn gar nichts mehr reagiert. Dauert ein paar Sekunden, das Spiel bleibt erhalten."
              onPress={() => command('restart')}
              busy={busy === 'restart'}
              disabled={!online || !!busy}
            />

            <View style={s.feedback}>
              {error ? (
                <>
                  <Ionicons name="alert-circle" size={16} color={colors.danger} />
                  <Text style={[s.feedbackText, { color: '#fecaca' }]}>{error}</Text>
                </>
              ) : done ? (
                <>
                  <Ionicons name="checkmark-circle" size={16} color={colors.accent} />
                  <Text style={[s.feedbackText, { color: colors.accent }]}>{done}</Text>
                </>
              ) : null}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Action({
  icon,
  title,
  text,
  onPress,
  busy,
  disabled,
  highlight,
  children,
}: {
  icon: IconName;
  title: string;
  text: string;
  onPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
  highlight?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <>
      <View style={[s.actionIcon, highlight && { backgroundColor: colors.accentDim }]}>
        {busy ? <ActivityIndicator size="small" color={colors.text} /> : <Ionicons name={icon} size={20} color={highlight ? colors.accent : colors.text} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.actionTitle}>{title}</Text>
        <Text style={s.actionText}>{text}</Text>
        {children}
      </View>
    </>
  );
  if (!onPress) return <View style={[s.action, disabled && { opacity: 0.45 }]}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        s.action,
        highlight && { borderColor: colors.accent },
        hovered && !disabled && { backgroundColor: colors.surfaceAlt },
        pressed && { opacity: 0.75 },
        disabled && !busy && { opacity: 0.45 },
      ]}
    >
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 12 },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '90%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  content: { padding: 16, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { color: colors.muted, fontWeight: '600', flexShrink: 1 },
  message: { color: colors.faint, fontSize: 13 },
  warnBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    padding: 10,
    borderRadius: radius.md,
    backgroundColor: '#2a1f05',
  },
  warnText: { color: '#fde68a', flex: 1, fontSize: 13 },
  action: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  actionTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  actionText: { color: colors.muted, fontSize: 13 },
  camRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  camChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  camChipText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  feedback: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 6 },
  feedbackText: { fontSize: 13, flexShrink: 1 },
});

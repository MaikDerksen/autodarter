import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { segmentLabel, type BoardMember, type BoardSettings, type BoardSummary, type CameraInfo } from '@shared';
import { BoardOverlay } from '@/components/BoardOverlay';
import { Dartboard } from '@/components/Dartboard';
import { OnlineDot } from '@/components/OnlineDot';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, P, Row, Screen, Stat } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { boardBadge } from '@/lib/boardState';
import { confirm } from '@/lib/confirm';
import { useFriends } from '@/lib/friends';
import { useBoardLive, type Frame } from '@/lib/live';
import { colors, radius } from '@/lib/theme';

/** Who has the board in their account; the owner shares it with friends. */
function MembersCard({ board, onError }: { board: BoardSummary; onError: (e: string | null) => void }) {
  const { user } = useAuth();
  const friends = useFriends();
  const [members, setMembers] = useState<BoardMember[]>([]);
  const owner = board.role === 'owner';

  const load = () =>
    api<BoardMember[]>(`/api/boards/${board.id}/members`)
      .then(setMembers)
      .catch((e) => onError(errorMessage(e)));
  // reload when the member count changes (somebody added the board with the code)
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id, board.memberCount]);

  const act = async (fn: () => Promise<unknown>) => {
    onError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  const memberIds = new Set(members.map((m) => m.userId));
  const shareable = friends.friends.filter((f) => !memberIds.has(f.id));

  return (
    <Card>
      <H2>Spieler mit Zugriff</H2>
      <P muted>Alle hier können auf dem Board spielen und zuschauen. Läuft ein Spiel, ist das Board für die anderen gesperrt.</P>
      {members.map((m) => (
        <View key={m.userId} style={s.memberRow}>
          <OnlineDot online={m.online} />
          <Text style={{ color: colors.text, fontWeight: '700', flex: 1 }}>
            {m.displayName} <Text style={{ color: colors.muted, fontWeight: '400' }}>@{m.username}</Text>
          </Text>
          <Badge label={m.role === 'owner' ? 'Besitzer' : 'Spieler'} color={m.role === 'owner' ? colors.accent : colors.muted} />
          {owner && m.userId !== user?.id ? (
            <Button
              small
              variant="ghost"
              icon="close"
              onPress={async () => {
                if (await confirm('Zugriff entfernen?', `${m.displayName} kann das Board danach nicht mehr nutzen.`, 'Entfernen')) {
                  await act(() => api(`/api/boards/${board.id}/members/${m.userId}`, { method: 'DELETE' }));
                }
              }}
            />
          ) : null}
        </View>
      ))}
      {owner && shareable.length > 0 ? (
        <>
          <Text style={{ color: colors.muted, fontWeight: '700' }}>Mit Freunden teilen</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {shareable.map((f) => (
              <Button
                key={f.id}
                small
                variant="secondary"
                icon="share-social"
                title={f.displayName}
                onPress={() => act(() => api(`/api/boards/${board.id}/members`, { body: { userId: f.id } }))}
              />
            ))}
          </View>
        </>
      ) : null}
      {board.pairingCode ? (
        <View style={s.codeBox}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700' }}>CODE FÜR WEITERE SPIELER</Text>
            <Text selectable style={s.code}>
              {board.pairingCode}
            </Text>
            <Text style={{ color: colors.faint, fontSize: 12 }}>Unter „Boards → Board hinzufügen“ eingeben. Gilt nur einmal.</Text>
          </View>
          {owner ? (
            <Button
              small
              variant="ghost"
              icon="refresh"
              title="Neuer Code"
              onPress={() => act(() => api(`/api/boards/${board.id}/pairing-code`, { body: {} }))}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function CameraTile({
  cam,
  frame,
  board,
  width,
  tip,
}: {
  cam: CameraInfo;
  frame: Frame | undefined;
  board: BoardSummary;
  width: number;
  tip: { x: number; y: number } | null;
}) {
  const aspect = frame ? frame.height / frame.width : cam.height / cam.width || 9 / 16;
  const height = width * aspect;
  const calibration = board.calibration?.[String(cam.index)];
  return (
    <View style={{ width, gap: 8 }}>
      <View style={[s.camBox, { width, height }]}>
        {frame ? (
          <Image source={{ uri: frame.uri }} style={{ width, height }} resizeMode="stretch" />
        ) : (
          <View style={s.camPlaceholder}>
            <Ionicons name={cam.ok ? 'hourglass' : 'videocam-off'} size={28} color={colors.faint} />
            <Text style={{ color: colors.faint }}>{cam.ok ? 'Warte auf Bild …' : 'Kamera nicht verfügbar'}</Text>
          </View>
        )}
        <BoardOverlay points={calibration?.points} width={width} height={height} tip={tip} />
      </View>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>
            Kamera {cam.index + 1} · {cam.width}×{cam.height}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
            {cam.name} · {cam.fps.toFixed(0)} FPS
          </Text>
        </View>
        <Row gap={6}>
          <Badge label={cam.calibrated ? 'Kalibriert' : 'Nicht kalibriert'} color={cam.calibrated ? colors.accent : colors.warning} />
          <Button small variant="secondary" icon="locate" title="Kalibrieren" onPress={() => router.push(`/calibrate/${board.id}?cam=${cam.index}`)} />
        </Row>
      </Row>
    </View>
  );
}

const SETTING_FIELDS: { key: keyof BoardSettings; label: string; hint: string }[] = [
  { key: 'fps', label: 'FPS', hint: 'Bilder pro Sekunde je Kamera' },
  { key: 'diffThreshold', label: 'Differenz-Schwelle', hint: 'Helligkeitsänderung, ab der ein Pixel als verändert gilt' },
  { key: 'minDartArea', label: 'Min. Dart-Fläche', hint: 'Kleinste Änderung (px), die als Dart zählt' },
  { key: 'takeoutArea', label: 'Takeout-Fläche', hint: 'Ab dieser Änderung (px) wird eine Hand/Takeout angenommen' },
  { key: 'settleFrames', label: 'Ruhe-Frames', hint: 'Ruhige Frames bevor ausgewertet wird' },
];

export default function BoardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const [initial, setInitial] = useState<BoardSummary | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** edited values of the detection settings (null = unchanged, show the board's values) */
  const [edited, setSettings] = useState<Record<string, string> | null>(null);
  const live = useBoardLive(id, { stream: true });
  const board = live.board ?? initial;

  useEffect(() => {
    api<BoardSummary>(`/api/boards/${id}`)
      .then((b) => {
        setInitial(b);
        setName(b.name);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  const fromBoard: Record<string, string> = {};
  if (board?.settings) {
    for (const f of SETTING_FIELDS) fromBoard[f.key] = String(board.settings[f.key]);
    fromBoard.resolution = board.settings.resolution.join('x');
  }
  const settings = edited ?? fromBoard;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!board) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}>{error ? <ErrorText>{error}</ErrorText> : <Loading />}</View>;
  }

  const cams = board.status?.cameras ?? [];
  const contentWidth = Math.min(width, 1400) - 84;
  const perRow = contentWidth > 1000 ? 3 : contentWidth > 620 ? 2 : 1;
  const tileWidth = Math.floor((contentWidth - (perRow - 1) * 16) / perRow);
  const badge = boardBadge(board);
  const command = (action: string) => run(action, () => api(`/api/boards/${id}/command`, { body: { action } }));
  const dart = live.lastDart;
  const owner = board.role === 'owner';

  const saveSettings = () =>
    run('settings', async () => {
      const body: Record<string, unknown> = {};
      for (const f of SETTING_FIELDS) {
        const v = Number(settings[f.key]);
        if (Number.isFinite(v)) body[f.key] = v;
      }
      const res = /^(\d+)\s*[x×]\s*(\d+)$/.exec(settings.resolution ?? '');
      if (res) body.resolution = [Number(res[1]), Number(res[2])];
      await api(`/api/boards/${id}/settings`, { method: 'PUT', body });
    });

  return (
    <>
      <Stack.Screen options={{ title: board.name }} />
      <Screen maxWidth={1400}>
        <Card>
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <Row>
              <Ionicons name="disc" size={30} color={board.online ? colors.accent : colors.faint} />
              <View>
                <H2>{board.name}</H2>
                <Text style={{ color: colors.muted, fontSize: 12 }}>ID {board.id}</Text>
              </View>
            </Row>
            <Badge {...badge} />
          </Row>
          {board.status?.message ? <P muted>{board.status.message}</P> : null}
          {board.online && board.status ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Stat label="Darts im Board" value={board.status.darts} />
              <Stat label="Verarbeitung" value={`${board.status.fps.toFixed(1)} FPS`} />
              <Stat label="Kameras" value={cams.length} />
              <Stat label="Erkennung" value={board.status.detecting ? 'An' : 'Aus'} />
              <Stat label="Version" value={board.status.version} />
            </View>
          ) : (
            <P muted>Das Board ist offline. Prüfe, ob der Board-Client auf dem Pi läuft und den Server erreicht.</P>
          )}
          <Row wrap>
            <Button small icon="play" title="Start" onPress={() => command('start')} loading={busy === 'start'} disabled={!board.online} />
            <Button small variant="secondary" icon="stop" title="Stopp" onPress={() => command('stop')} loading={busy === 'stop'} disabled={!board.online} />
            <Button small variant="secondary" icon="refresh" title="Reset" onPress={() => command('reset')} loading={busy === 'reset'} disabled={!board.online} />
            <Button small variant="secondary" icon="search" title="Kameras neu suchen" onPress={() => command('rescan')} loading={busy === 'rescan'} disabled={!board.online} />
          </Row>
          {board.activeMatch ? (
            <Row wrap style={s.activeRow}>
              <Ionicons name="game-controller" size={18} color={colors.warning} />
              <Text style={{ color: colors.text, flex: 1 }}>
                Läuft gerade: <Text style={{ fontWeight: '800' }}>{board.activeMatch.title}</Text> · {board.activeMatch.players.join(' vs. ')} (von{' '}
                {board.activeMatch.ownerName})
              </Text>
              <Button small variant="secondary" icon="eye" title="Öffnen" onPress={() => router.push(`/match/${board.activeMatch!.id}`)} />
              <Button
                small
                variant="danger"
                icon="stop-circle"
                title="Spiel beenden"
                loading={busy === 'endMatch'}
                onPress={async () => {
                  const a = board.activeMatch!;
                  if (
                    await confirm(
                      'Laufendes Spiel beenden?',
                      `${a.title} von ${a.ownerName} (${a.players.join(' vs. ')}) wird abgebrochen und das Board ist wieder frei.`,
                      'Spiel beenden',
                    )
                  ) {
                    await run('endMatch', () => api(`/api/matches/${a.id}/abort`, { body: {} }));
                  }
                }}
              />
            </Row>
          ) : null}
          <Row wrap>
            <Button
              small
              variant="secondary"
              icon="reload"
              title="Board-Client neu starten"
              loading={busy === 'restart'}
              disabled={!board.online}
              onPress={async () => {
                if (await confirm('Board-Client neu starten?', 'Die Software auf dem Pi startet neu und ist nach ca. 10–20 Sekunden wieder online.', 'Neu starten')) {
                  await command('restart');
                }
              }}
            />
            <Button
              small
              variant="secondary"
              icon="cloud-download"
              title="Software aktualisieren"
              loading={busy === 'update'}
              disabled={!owner || !board.online || !board.status?.capabilities?.update}
              onPress={async () => {
                if (
                  await confirm(
                    'Board-Software aktualisieren?',
                    'Der Pi lädt die neueste Version aus der Registry. Gibt es eine neue, startet der Board-Client kurz neu.',
                    'Aktualisieren',
                  )
                ) {
                  await command('update');
                }
              }}
            />
            <Button
              small
              variant="danger"
              icon="power"
              title="Raspberry Pi neu starten"
              loading={busy === 'reboot'}
              disabled={!owner || !board.online || !board.status?.capabilities?.reboot}
              onPress={async () => {
                if (await confirm('Raspberry Pi neu starten?', 'Der komplette Pi bootet neu. Das Board ist danach ca. 1–2 Minuten offline.', 'Pi neu starten')) {
                  await command('reboot');
                }
              }}
            />
          </Row>
          {!owner ? (
            <P muted>Update, Pi-Neustart, Einstellungen und Name ändert nur der Besitzer des Boards.</P>
          ) : board.online ? (
            <>
              {!board.status?.capabilities?.reboot ? (
                <P muted>Pi-Neustart ist nicht freigegeben: in board/.env ALLOW_REBOOT=true setzen und den Board-Client neu starten.</P>
              ) : null}
              {!board.status?.capabilities?.update ? (
                <P muted>Auto-Update ist auf dem Pi nicht aktiv: in board/.env COMPOSE_PROFILES=autoupdate setzen.</P>
              ) : null}
            </>
          ) : null}
          <ErrorText>{error}</ErrorText>
        </Card>

        <Card>
          <H2>Kameras</H2>
          {cams.length === 0 ? <P muted>Keine Kameras gefunden.</P> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            {cams.map((cam) => (
              <CameraTile
                key={cam.index}
                cam={cam}
                frame={live.frames[cam.index]}
                board={board}
                width={tileWidth}
                tip={dart?.tips?.[cam.index] ?? null}
              />
            ))}
          </View>
        </Card>

        <Card>
          <H2>Erkennungstest</H2>
          <P muted>Wirf einen Dart – hier siehst du sofort, was erkannt wurde (auch ohne laufendes Spiel).</P>
          <Row wrap gap={20} style={{ alignItems: 'flex-start' }}>
            <Dartboard size={Math.min(300, contentWidth)} hits={dart ? [{ x: dart.x, y: dart.y, color: '#ef4444' }] : []} />
            <View style={{ gap: 8, flex: 1, minWidth: 200 }}>
              {dart ? (
                <>
                  <Text style={{ color: colors.text, fontSize: 40, fontWeight: '900' }}>{segmentLabel(dart.seg)}</Text>
                  <P muted>
                    Position: x {dart.x.toFixed(1)} mm, y {dart.y.toFixed(1)} mm{'\n'}
                    Kameras: {dart.cameras.map((c) => c + 1).join(', ')} · Sicherheit {(dart.confidence * 100).toFixed(0)} %
                  </P>
                </>
              ) : (
                <P muted>Noch kein Dart erkannt.</P>
              )}
              {live.lastEvent ? (
                <Badge
                  label={live.lastEvent.event === 'takeout_started' ? 'Takeout gestartet' : 'Takeout beendet'}
                  color={colors.warning}
                />
              ) : null}
            </View>
          </Row>
        </Card>

        <Card>
          <H2>Erkennungs-Einstellungen</H2>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            <View style={{ flexBasis: 200, flexGrow: 1 }}>
              <Field
                label="Auflösung"
                value={settings.resolution ?? ''}
                onChangeText={(t) => setSettings({ ...settings, resolution: t })}
                placeholder="1280x720"
              />
            </View>
            {SETTING_FIELDS.map((f) => (
              <View key={f.key} style={{ flexBasis: 200, flexGrow: 1 }}>
                <Field
                  label={f.label}
                  value={settings[f.key] ?? ''}
                  onChangeText={(t) => setSettings({ ...settings, [f.key]: t })}
                  keyboardType="numeric"
                />
                <Text style={{ color: colors.faint, fontSize: 12, marginTop: 4 }}>{f.hint}</Text>
              </View>
            ))}
          </View>
          <Button title="Einstellungen speichern" icon="save" onPress={saveSettings} loading={busy === 'settings'} disabled={!owner || !board.online} />
        </Card>

        <MembersCard board={board} onError={setError} />

        <Card>
          <H2>Verwaltung</H2>
          <Row wrap style={{ alignItems: 'flex-end' }}>
            <View style={{ flexGrow: 1, flexBasis: 220 }}>
              <Field label="Name" value={name} onChangeText={setName} />
            </View>
            <Button
              title="Umbenennen"
              variant="secondary"
              disabled={!owner}
              onPress={() =>
                run('rename', async () => {
                  const b = await api<BoardSummary>(`/api/boards/${id}`, { method: 'PATCH', body: { name } });
                  setInitial(b);
                })
              }
              loading={busy === 'rename'}
            />
          </Row>
          <Button
            title="Board aus meinem Konto entfernen"
            variant="danger"
            icon="unlink"
            onPress={async () => {
              const text =
                owner && board.memberCount > 1
                  ? 'Die anderen Spieler behalten das Board, der am längsten dabei ist wird Besitzer.'
                  : owner
                    ? 'Du bist der Letzte mit diesem Board – es kann danach mit dem Code neu hinzugefügt werden.'
                    : 'Du kannst es später mit dem Code wieder hinzufügen.';
              if (await confirm('Board entfernen?', text, 'Entfernen')) {
                await run('remove', () => api(`/api/boards/${id}`, { method: 'DELETE' }));
                router.replace('/boards');
              }
            }}
          />
        </Card>
      </Screen>
    </>
  );
}

const s = StyleSheet.create({
  camBox: { backgroundColor: '#000', borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  camPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  activeRow: { backgroundColor: '#2a1f05', borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: colors.warning + '66' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, backgroundColor: colors.bg },
  codeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  code: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 6,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});

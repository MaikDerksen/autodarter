import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { BugReportDetail, Segment } from '@shared';
import { Badge, Button, Card, ErrorText, H2, Loading, P, Row, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { confirm } from '@/lib/confirm';
import { ENTRY_LABEL, KIND_LABEL, REASON_LABEL, download, formatTime, reportUrl, segText } from '@/lib/reports';
import { colors, radius } from '@/lib/theme';

/** What the board sent along (see collect_report in the board client). */
interface Entry {
  n: number;
  id: string;
  kind: string;
  at: number;
  info: { seg?: Segment; x?: number; y?: number; confidence?: number; cameras?: number[]; reason?: string; areas?: Record<string, number>; rawAreas?: Record<string, number> };
  frames: Record<string, { before?: string; peak?: string; after?: string }>;
}
interface BoardReport {
  entries?: Entry[];
  missing?: string[];
  now?: Record<string, { reference?: string | null; empty?: string | null; live?: string }>;
  version?: string;
}
interface TurnDart {
  eventIndex: number;
  label: string;
  bid?: string;
  det?: { seg: Segment };
}

const PART_LABEL: Record<string, string> = { before: 'vorher', peak: 'Bewegung', after: 'nachher', live: 'live', reference: 'Referenz', empty: 'leeres Board' };
// fixed order (the database does not keep the key order of JSON objects)
const DETECTION_PARTS = ['before', 'peak', 'after'];
const NOW_PARTS = ['live', 'reference', 'empty'];

export default function ReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const [report, setReport] = useState<BugReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api<BugReportDetail>(`/api/reports/${id}`)
      .then(setReport)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  if (!report) {
    return error ? (
      <Screen>
        <ErrorText>{error}</ErrorText>
      </Screen>
    ) : (
      <Loading />
    );
  }

  const details = report.details as { boardReport?: BoardReport | null; turn?: { playerName?: string; darts?: TurnDart[] }; dart?: { eventIndex?: number; bid?: string } | null };
  const board = details.boardReport ?? null;
  const entries = board?.entries ?? [];
  const url = (name: string) => reportUrl(`/api/reports/${report.id}/files/${encodeURIComponent(name)}`, report.fileToken);
  const cols = width >= 900 ? 3 : 2;

  const setStatus = async (status: 'open' | 'done') => {
    setBusy(true);
    try {
      await api(`/api/reports/${report.id}`, { method: 'PATCH', body: { status } });
      setReport({ ...report, status });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm('Bericht löschen?', 'Der Bericht und alle Bilder werden endgültig gelöscht.', 'Löschen'))) return;
    try {
      await api(`/api/reports/${report.id}`, { method: 'DELETE' });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const images = (frames: Record<string, string | null | undefined>, order: string[]) =>
    order.map((part) => [part, frames[part]] as const).filter((e): e is [string, string] => !!e[1]);

  return (
    <>
      <Stack.Screen options={{ title: KIND_LABEL[report.kind] }} />
      <Screen maxWidth={1200}>
        <Card>
          <Row style={{ justifyContent: 'space-between' }} wrap>
            <H2>
              {KIND_LABEL[report.kind]}
              {report.kind === 'wrong' ? `: ${segText(report.detected)} → ${segText(report.actual)}` : ''}
            </H2>
            <Badge label={report.status === 'done' ? 'Erledigt' : 'Offen'} color={report.status === 'done' ? colors.accent : colors.warning} />
          </Row>
          <P muted>
            {formatTime(report.createdAt)} · gemeldet von {report.reporter ?? '?'} · {report.boardName ?? 'Board?'}
            {board?.version ? ` · Board ${board.version}` : ''}
          </P>
          <Text style={s.fact}>
            Board hat erkannt: <Text style={s.factValue}>{report.kind === 'missed' ? 'nichts' : segText(report.detected, 'nichts / von Hand eingegeben')}</Text>
            {'   '}Wirklich: <Text style={s.factValue}>{report.kind === 'phantom' ? 'kein Dart geworfen' : segText(report.actual, '?')}</Text>
          </Text>
          {details.turn?.darts?.length ? (
            <Text style={s.fact}>
              Aufnahme von {details.turn.playerName ?? '?'}:{' '}
              {details.turn.darts.map((d, i) => (
                <Text key={d.eventIndex} style={d.eventIndex === details.dart?.eventIndex ? s.factValue : undefined}>
                  {i ? ' · ' : ''}
                  {d.label}
                  {d.det ? ` (erkannt ${segText(d.det.seg)})` : ''}
                </Text>
              ))}
            </Text>
          ) : null}
          {report.note ? <Text style={s.note}>„{report.note}“</Text> : null}
          {report.boardError ? (
            <View style={s.warnBox}>
              <Ionicons name="warning" size={18} color={colors.warning} />
              <Text style={s.warnText}>Bilder unvollständig: {report.boardError}</Text>
            </View>
          ) : null}
          {board?.missing?.length ? (
            <View style={s.warnBox}>
              <Ionicons name="time" size={18} color={colors.warning} />
              <Text style={s.warnText}>Für den gemeldeten Dart hatte das Board keine Bilder mehr (zu spät gemeldet, zu viele Würfe danach).</Text>
            </View>
          ) : null}
          <ErrorText>{error}</ErrorText>
          <Row wrap>
            {report.status === 'open' ? (
              <Button title="Erledigt" icon="checkmark" onPress={() => setStatus('done')} loading={busy} />
            ) : (
              <Button title="Wieder öffnen" icon="refresh" variant="secondary" onPress={() => setStatus('open')} loading={busy} />
            )}
            <Button title="ZIP herunterladen" icon="download" variant="secondary" onPress={() => download(reportUrl(`/api/reports/${report.id}/download`, report.fileToken))} />
            {report.matchId ? <Button title="Zum Spiel" icon="disc" variant="ghost" onPress={() => router.push(`/match/${report.matchId}`)} /> : null}
            <Button title="Löschen" icon="trash" variant="ghost" onPress={remove} />
          </Row>
        </Card>

        {entries.map((e) => (
          <Card key={e.id}>
            <H2 style={{ fontSize: 18 }}>
              {e.n}. {ENTRY_LABEL[e.kind] ?? e.kind}
              {e.info.seg ? `: ${segText(e.info.seg)}` : ''}
              {e.info.reason ? `: ${REASON_LABEL[e.info.reason] ?? e.info.reason}` : ''}
            </H2>
            <P muted>
              {new Date(e.at * 1000).toLocaleTimeString('de-DE')}
              {e.info.x !== undefined && e.info.y !== undefined ? ` · Position ${e.info.x.toFixed(1)} / ${e.info.y.toFixed(1)} mm` : ''}
              {e.info.confidence !== undefined ? ` · Sicherheit ${Math.round(e.info.confidence * 100)} %` : ''}
              {e.info.cameras ? ` · Kameras ${e.info.cameras.map((c) => c + 1).join(', ')}` : ''}
              {e.info.areas ? ` · Fläche ${Object.values(e.info.areas).join(' / ')} px` : ''}
            </P>
            {Object.entries(e.frames).map(([cam, frames]) => (
              <View key={cam} style={{ gap: 6 }}>
                <Text style={s.cam}>Kamera {Number(cam) + 1}</Text>
                <Grid cols={cols} items={images(frames, DETECTION_PARTS).map(([part, name]) => ({ key: name, label: PART_LABEL[part] ?? part, uri: url(name) }))} />
              </View>
            ))}
          </Card>
        ))}

        {board?.now ? (
          <Card>
            <H2 style={{ fontSize: 18 }}>Beim Melden</H2>
            <P muted>Live-Bild jeder Kamera, dazu das Bild, mit dem die Erkennung gerade vergleicht (Referenz), und das leere Board.</P>
            {Object.entries(board.now).map(([cam, frames]) => (
              <View key={cam} style={{ gap: 6 }}>
                <Text style={s.cam}>Kamera {Number(cam) + 1}</Text>
                <Grid cols={cols} items={images(frames, NOW_PARTS).map(([part, name]) => ({ key: `${part}-${name}`, label: PART_LABEL[part] ?? part, uri: url(name) }))} />
              </View>
            ))}
          </Card>
        ) : !report.boardError ? null : (
          <Card>
            <P muted>Keine Kamerabilder.</P>
          </Card>
        )}

        <Card>
          <Pressable onPress={() => setRaw(!raw)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessibilityRole="button">
            <Ionicons name={raw ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.muted} />
            <Text style={s.cam}>Rohdaten (Erkennung, Kalibrierung, Einstellungen)</Text>
          </Pressable>
          {raw ? (
            <Text selectable style={s.raw}>
              {JSON.stringify(report.details, null, 2)}
            </Text>
          ) : null}
        </Card>
      </Screen>
    </>
  );
}

function Grid({ cols, items }: { cols: number; items: { key: string; label: string; uri: string }[] }) {
  return (
    <View style={s.grid}>
      {items.map((it) => (
        <Pressable key={it.key} onPress={() => void Linking.openURL(it.uri)} style={[s.cell, { width: `${100 / cols - 1.5}%` }]} accessibilityLabel={`${it.label} in voller Größe`}>
          <Image source={{ uri: it.uri }} style={s.image} resizeMode="contain" />
          <Text style={s.caption}>{it.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  fact: { color: colors.muted, fontSize: 15 },
  factValue: { color: colors.text, fontWeight: '800' },
  note: { color: colors.text, fontStyle: 'italic', fontSize: 15 },
  warnBox: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', padding: 10, borderRadius: radius.md, backgroundColor: '#2a1f05' },
  warnText: { color: '#fde68a', flex: 1, fontSize: 13 },
  cam: { color: colors.muted, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { gap: 4 },
  image: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.sm, backgroundColor: '#000' },
  caption: { color: colors.faint, fontSize: 12 },
  raw: { color: colors.muted, fontFamily: 'monospace', fontSize: 11 },
});

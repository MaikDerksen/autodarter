import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BugReportStatus, BugReportSummary } from '@shared';
import { Button, Card, ErrorText, H2, Loading, P, Row, Screen, Segmented } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { KIND_LABEL, download, formatTime, reportUrl, segText } from '@/lib/reports';
import { colors, radius } from '@/lib/theme';

type Filter = BugReportStatus | 'all';

export default function ReportsScreen() {
  const [filter, setFilter] = useState<Filter>('open');
  const [data, setData] = useState<{ reports: BugReportSummary[]; downloadToken: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((f: Filter) => {
    api<{ reports: BugReportSummary[]; downloadToken: string }>(`/api/reports?status=${f}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(filter);
    }, [load, filter]),
  );

  const change = (f: Filter) => {
    setFilter(f);
    setData(null);
  };

  return (
    <Screen maxWidth={900}>
      <Card>
        <H2>Fehlerberichte</H2>
        <P muted>
          Gemeldete Fehlerkennungen mit den Kamerabildern des Boards. Als ZIP herunterladen (eine Mappe pro Bericht mit report.json und
          allen Bildern) – oder auf dem Server: docker compose exec -T server node dist/export-reports.js {'>'} berichte.zip
        </P>
        <Segmented
          options={[
            { value: 'open', label: 'Offen' },
            { value: 'done', label: 'Erledigt' },
            { value: 'all', label: 'Alle' },
          ]}
          value={filter}
          onChange={change}
        />
        <ErrorText>{error}</ErrorText>
        {!data && !error ? <Loading /> : null}
        {data && data.reports.length === 0 ? <P muted>Keine Berichte.</P> : null}
        {data?.reports.map((r) => (
          <Pressable
            key={r.id}
            onPress={() => router.push(`/reports/${r.id}`)}
            accessibilityRole="button"
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.row, hovered && { backgroundColor: colors.surfaceAlt }, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name={r.status === 'done' ? 'checkmark-circle' : 'bug'} size={20} color={r.status === 'done' ? colors.accent : colors.warning} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.title} numberOfLines={1}>
                {KIND_LABEL[r.kind]}
                {r.kind === 'missed' ? `: ${segText(r.actual, '?')}` : r.kind === 'phantom' ? `: ${segText(r.detected)}` : r.kind === 'wrong' ? `: ${segText(r.detected)} → ${segText(r.actual)}` : ''}
              </Text>
              <Text style={s.sub} numberOfLines={2}>
                {formatTime(r.createdAt)} · {r.reporter ?? '?'} · {r.boardName ?? 'Board?'} · {r.images} Bilder
                {r.boardError ? ' · ⚠ unvollständig' : ''}
                {r.note ? ` · „${r.note}“` : ''}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.faint} />
          </Pressable>
        ))}
        {data && data.reports.length > 0 ? (
          <Row wrap>
            <Button
              title={`Alle ${data.reports.length} als ZIP`}
              icon="download"
              variant="secondary"
              onPress={() => download(reportUrl('/api/reports/download', data.downloadToken, { status: filter }))}
            />
          </Row>
        ) : null}
      </Card>
    </Screen>
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
  title: { color: colors.text, fontWeight: '800', fontSize: 15 },
  sub: { color: colors.muted, fontSize: 13 },
});

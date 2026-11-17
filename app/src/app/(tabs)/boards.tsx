import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { BoardSummary } from '@shared';
import { Badge, Button, Card, ErrorText, Field, H2, Loading, P, Row, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { boardBadge } from '@/lib/boardState';
import { useBoards } from '@/lib/hooks';
import { live, useLiveMessages } from '@/lib/live';
import { colors, radius } from '@/lib/theme';

function BoardRow({ board }: { board: BoardSummary }) {
  const badge = boardBadge(board);
  const cams = board.status?.cameras ?? [];
  const calibrated = cams.filter((c) => c.calibrated).length;
  return (
    <Pressable
      onPress={() => router.push(`/board/${board.id}`)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: colors.bg },
        (hovered || pressed) && { backgroundColor: colors.surfaceAlt },
      ]}
    >
      <Ionicons name="disc" size={28} color={board.online ? colors.accent : colors.faint} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{board.name}</Text>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          {board.online
            ? `${cams.length} Kamera${cams.length === 1 ? '' : 's'} · ${calibrated}/${cams.length} kalibriert · ${board.status?.fps?.toFixed(0) ?? 0} FPS`
            : board.lastSeen
              ? `Zuletzt online ${new Date(board.lastSeen).toLocaleString()}`
              : 'Noch nie online'}
          {` · ${board.role === 'owner' ? 'Besitzer' : 'Geteilt'}${board.memberCount > 1 ? ` · ${board.memberCount} Spieler` : ''}`}
        </Text>
        {board.activeMatch ? (
          <Text style={{ color: colors.warning, fontSize: 12 }}>
            Läuft: {board.activeMatch.title} · {board.activeMatch.players.join(' vs. ')}
          </Text>
        ) : null}
      </View>
      <Badge {...badge} />
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

export default function BoardsScreen() {
  const boards = useBoards();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // live status updates for boards we already listed
  useLiveMessages((msg) => {
    if (msg.type === 'board_status') {
      boards.setData((list) => list?.map((b) => (b.id === msg.board.id ? msg.board : b)) ?? list);
    }
  });

  const ids = (boards.data ?? []).map((b) => b.id).join(',');
  useEffect(() => {
    if (!ids) return;
    const unsubs = ids.split(',').map((id) => live.subscribeBoard(id));
    return () => unsubs.forEach((u) => u());
  }, [ids]);

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const board = await api<BoardSummary>('/api/boards/claim', { body: { code: code.trim(), name: name.trim() || undefined } });
      setCode('');
      setName('');
      await boards.reload();
      router.push(`/board/${board.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card>
        <H2>Meine Boards</H2>
        {boards.loading ? <Loading /> : null}
        {boards.error ? <ErrorText>{boards.error}</ErrorText> : null}
        {boards.data?.map((b) => <BoardRow key={b.id} board={b} />)}
        {boards.data && boards.data.length === 0 ? <P muted>Du hast noch kein Board verbunden.</P> : null}
      </Card>

      <Card>
        <H2>Board hinzufügen</H2>
        <P muted>
          1. Starte den Autodarter Board-Client auf deinem Raspberry Pi (docker compose up -d im Ordner board/).{'\n'}
          2. Öffne http://&lt;IP-des-Pi&gt;:3180 – dort (und im Log) steht der 6-stellige Kopplungscode.{'\n'}
          3. Gib den Code hier ein.{'\n'}
          Ein Board kann in mehreren Konten sein: Wer den Code kennt (Pi-Statusseite oder Board-Seite in der App), fügt es
          ebenfalls hinzu. Der Code ändert sich nach jeder Verwendung.
        </P>
        <Row wrap gap={12} style={{ alignItems: 'flex-end' }}>
          <View style={{ flexGrow: 1, flexBasis: 200 }}>
            <Field
              label="Kopplungscode"
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase())}
              placeholder="z. B. K7M2QX"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
            />
          </View>
          <View style={{ flexGrow: 1, flexBasis: 200 }}>
            <Field label="Name (optional)" value={name} onChangeText={setName} placeholder="z. B. Keller" />
          </View>
        </Row>
        <ErrorText>{error}</ErrorText>
        <Button title="Board koppeln" icon="link" onPress={claim} loading={busy} disabled={code.trim().length < 4} />
      </Card>
    </Screen>
  );
}

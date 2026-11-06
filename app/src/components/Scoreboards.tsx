import { StyleSheet, Text, View } from 'react-native';
import type { MatchState } from '@shared';
import { colors, radius } from '@/lib/theme';

export function X01Scoreboard({ state, compact }: { state: MatchState; compact?: boolean }) {
  const lastTurn = (p: number) => {
    const leg = state.legs[state.legs.length - 1];
    for (let i = leg.turns.length - 1; i >= 0; i--) if (leg.turns[i].player === p) return leg.turns[i];
    return null;
  };
  return (
    <View style={styles.players}>
      {state.players.map((p, i) => {
        const active = i === state.currentPlayer && !state.finished;
        const lt = lastTurn(i);
        const s = state.stats[i];
        return (
          <View key={p.id} style={[styles.player, active && styles.playerActive, compact && { minWidth: 140 }]}>
            <View style={styles.playerHead}>
              <Text style={[styles.name, active && { color: colors.text }]} numberOfLines={1}>
                {p.name}
              </Text>
              {state.settings.legs > 1 ? <Text style={styles.legs}>{state.legsWon[i]} Legs</Text> : null}
            </View>
            <Text style={[styles.remaining, compact && { fontSize: 48 }, active && { color: colors.text }]}>{state.remaining[i]}</Text>
            <View style={styles.playerFoot}>
              <Text style={styles.meta}>Ø {s.average.toFixed(1)}</Text>
              <Text style={styles.meta}>
                {lt ? (lt.bust ? 'Bust' : `Letzte: ${lt.points}`) : ''}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Marks({ n }: { n: number }) {
  if (n <= 0) return <Text style={styles.markEmpty}>·</Text>;
  if (n === 1) return <Text style={styles.mark}>/</Text>;
  if (n === 2) return <Text style={styles.mark}>✕</Text>;
  return <Text style={[styles.mark, { color: colors.accent }]}>⊗</Text>;
}

export function CricketScoreboard({ state }: { state: MatchState }) {
  const c = state.cricket;
  if (!c) return null;
  return (
    <View style={styles.cricket}>
      <View style={styles.cRow}>
        <Text style={[styles.cTarget, { color: colors.muted }]} />
        {state.players.map((p, i) => (
          <View key={p.id} style={[styles.cCell, i === state.currentPlayer && !state.finished && styles.cActive]}>
            <Text style={styles.cName} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={styles.cPoints}>{c.points[i]}</Text>
            {state.settings.legs > 1 ? <Text style={styles.legs}>{state.legsWon[i]} Legs</Text> : null}
          </View>
        ))}
      </View>
      {c.targets.map((t, ti) => {
        const closedAll = c.marks.every((m) => m[ti] >= 3);
        return (
          <View key={t} style={[styles.cRow, closedAll && { opacity: 0.35 }]}>
            <Text style={styles.cTarget}>{t === 25 ? 'B' : t}</Text>
            {state.players.map((p, i) => (
              <View key={p.id} style={[styles.cCell, i === state.currentPlayer && !state.finished && styles.cActive]}>
                <Marks n={c.marks[i][ti]} />
              </View>
            ))}
          </View>
        );
      })}
      <View style={styles.cRow}>
        <Text style={[styles.cTarget, { fontSize: 12, color: colors.muted }]}>MPR</Text>
        {state.players.map((p, i) => (
          <View key={p.id} style={styles.cCell}>
            <Text style={styles.meta}>{state.stats[i].mpr.toFixed(2)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  players: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  player: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 160,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.border,
    padding: 14,
    gap: 2,
  },
  playerActive: { borderColor: colors.accent, backgroundColor: '#0f2418' },
  playerHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  name: { color: colors.muted, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  legs: { color: colors.warning, fontSize: 12, fontWeight: '800' },
  remaining: { color: colors.muted, fontSize: 64, fontWeight: '900', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  playerFoot: { flexDirection: 'row', justifyContent: 'space-between' },
  meta: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  cricket: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  cRow: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: colors.border },
  cTarget: { width: 56, textAlign: 'center', alignSelf: 'center', color: colors.text, fontSize: 22, fontWeight: '900' },
  cCell: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 2 },
  cActive: { backgroundColor: '#0f2418' },
  cName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  cPoints: { color: colors.text, fontSize: 30, fontWeight: '900' },
  mark: { color: colors.text, fontSize: 26, fontWeight: '800' },
  markEmpty: { color: colors.faint, fontSize: 22 },
});

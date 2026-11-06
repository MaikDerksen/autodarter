import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Multiplier, Segment } from '@shared';
import { colors, radius } from '@/lib/theme';

/** Manual score input: pick a multiplier, then a number. */
export function Keypad({ onSegment, disabled }: { onSegment: (seg: Segment) => void; disabled?: boolean }) {
  const [mult, setMult] = useState<Multiplier>(1);

  const press = (n: number) => {
    if (disabled) return;
    if (n === 0) onSegment({ number: 0, multiplier: 0 });
    else if (n === 25) onSegment({ number: 25, multiplier: mult >= 2 ? 2 : 1 });
    else onSegment({ number: n, multiplier: mult });
    setMult(1);
  };

  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  return (
    <View style={[styles.wrap, disabled && { opacity: 0.5 }]}>
      <View style={styles.row}>
        {([
          [2, 'Double'],
          [3, 'Triple'],
        ] as const).map(([m, label]) => (
          <Pressable
            key={m}
            onPress={() => setMult(mult === m ? 1 : m)}
            style={[styles.mod, mult === m && { backgroundColor: m === 2 ? colors.boardGreen : colors.boardRed }]}
          >
            <Text style={styles.modText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.grid}>
        {numbers.map((n) => (
          <Pressable key={n} onPress={() => press(n)} style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
            <Text style={styles.keyText}>{mult === 3 ? `T${n}` : mult === 2 ? `D${n}` : n}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => press(25)} style={({ pressed }) => [styles.key, styles.wide, pressed && styles.keyPressed]}>
          <Text style={styles.keyText}>{mult >= 2 ? 'BULL' : '25'}</Text>
        </Pressable>
        <Pressable onPress={() => press(0)} style={({ pressed }) => [styles.key, styles.wide, styles.miss, pressed && styles.keyPressed]}>
          <Text style={styles.keyText}>MISS</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, width: '100%' },
  row: { flexDirection: 'row', gap: 8 },
  mod: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: {
    flexBasis: '18%',
    flexGrow: 1,
    paddingVertical: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
  },
  keyPressed: { backgroundColor: colors.border },
  wide: { flexBasis: '40%' },
  miss: { backgroundColor: colors.dangerDim },
  keyText: { color: colors.text, fontWeight: '700', fontSize: 16 },
});

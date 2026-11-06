import { Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '@/lib/theme';

export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="-50 -50 100 100">
      <Circle r={46} fill={colors.boardBlack} stroke={colors.accent} strokeWidth={4} />
      <Circle r={32} fill="none" stroke={colors.boardRed} strokeWidth={6} />
      <Circle r={18} fill="none" stroke={colors.boardGreen} strokeWidth={6} />
      <Circle r={6} fill={colors.boardRed} />
      <Path d="M8 -8 L40 -40" stroke={colors.text} strokeWidth={4} strokeLinecap="round" />
      <Path d="M34 -44 L44 -44 L44 -34" stroke={colors.text} strokeWidth={4} fill="none" strokeLinecap="round" />
    </Svg>
  );
}

export function Logo() {
  return (
    <View style={{ alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <LogoMark size={64} />
      <Text style={{ color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -1 }}>Autodarter</Text>
      <Text style={{ color: colors.muted, fontSize: 15 }}>Automatische Dart-Erkennung – selbst gehostet</Text>
    </View>
  );
}

import { View } from 'react-native';
import { colors } from '@/lib/theme';

/** Green glowing dot = online, grey = offline. */
export function OnlineDot({ online, size = 10 }: { online: boolean; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: online ? colors.accent : colors.faint,
        ...(online ? ({ boxShadow: `0 0 6px ${colors.accent}` } as object) : {}),
      }}
    />
  );
}

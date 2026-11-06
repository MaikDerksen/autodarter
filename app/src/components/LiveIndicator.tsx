import { View } from 'react-native';
import { useLiveStatus } from '@/lib/live';
import { colors } from '@/lib/theme';
import { Badge } from './ui';

export function LiveIndicator() {
  const s = useLiveStatus();
  const map = {
    online: { label: 'Live', color: colors.accent },
    connecting: { label: 'Verbinde …', color: colors.warning },
    offline: { label: 'Offline', color: colors.danger },
  } as const;
  return (
    <View style={{ marginRight: 12 }}>
      <Badge {...map[s]} />
    </View>
  );
}

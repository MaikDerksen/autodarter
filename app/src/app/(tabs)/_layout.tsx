import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { LiveIndicator } from '@/components/LiveIndicator';
import { colors } from '@/lib/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '800' },
        headerRight: () => <LiveIndicator />,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Spielen', tabBarIcon: ({ color, size }) => <Ionicons name="play-circle" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="boards"
        options={{ title: 'Boards', tabBarIcon: ({ color, size }) => <Ionicons name="videocam" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="friends"
        options={{ title: 'Freunde', tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="stats"
        options={{ title: 'Statistik', tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="leaderboard"
        options={{ title: 'Rangliste', tabBarIcon: ({ color, size }) => <Ionicons name="trophy" color={color as string} size={size} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profil', tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" color={color as string} size={size} /> }}
      />
    </Tabs>
  );
}

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { InviteBanner } from '@/components/InviteBanner';
import { Loading } from '@/components/ui';
import { AuthProvider, useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';

function RootStack() {
  const { ready, user } = useAuth();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading label="Autodarter wird geladen …" />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Protected guard={!!user}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Autodarter' }} />
          <Stack.Screen name="match/[id]" options={{ title: 'Spiel' }} />
          <Stack.Screen name="board/[id]" options={{ title: 'Board' }} />
          <Stack.Screen name="calibrate/[id]" options={{ title: 'Kalibrierung' }} />
          <Stack.Screen name="voice/index" options={{ title: 'Stimmen' }} />
          <Stack.Screen name="voice/[id]" options={{ title: 'Stimmen-Paket' }} />
          <Stack.Screen name="reports/index" options={{ title: 'Fehlerberichte' }} />
          <Stack.Screen name="reports/[id]" options={{ title: 'Fehlerbericht' }} />
        </Stack.Protected>
        <Stack.Protected guard={!user}>
          <Stack.Screen name="login" options={{ headerShown: false, title: 'Anmelden' }} />
          <Stack.Screen name="register" options={{ headerShown: false, title: 'Registrieren' }} />
        </Stack.Protected>
        {/* invite links work logged in and logged out */}
        <Stack.Screen name="invite/[username]" options={{ title: 'Einladung' }} />
      </Stack>
      {/* match invites + result of an invite link, on top of every screen */}
      {user ? <InviteBanner key={user.id} /> : null}
    </View>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootStack />
    </AuthProvider>
  );
}

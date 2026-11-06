import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth';
import { colors } from '@/lib/theme';
import { Button, Field } from './ui';

/** Lets native apps (and dev setups) point to the Autodarter server. */
export function ServerField() {
  const { serverUrl, setServerUrl } = useAuth();
  const [open, setOpen] = useState(Platform.OS !== 'web' && !serverUrl);
  const [value, setValue] = useState(serverUrl);
  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)}>
        <Text style={{ color: colors.muted, textAlign: 'center' }}>
          Server: {serverUrl || (Platform.OS === 'web' ? 'diese Seite' : 'nicht gesetzt')} · ändern
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <Field
        label="Server-Adresse"
        value={value}
        onChangeText={setValue}
        placeholder="http://192.168.1.10:3000"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Button title="Server übernehmen" variant="secondary" small onPress={() => setServerUrl(value).then(() => setOpen(false))} />
    </View>
  );
}

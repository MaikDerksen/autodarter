import { Platform } from 'react-native';

/** Very small score caller based on the Web Speech API (web only). */
export function callerAvailable(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function say(text: string) {
  if (!callerAvailable()) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    u.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // ignore
  }
}

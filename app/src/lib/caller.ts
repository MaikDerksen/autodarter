import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';
import { voiceClipPath, type MatchVoice } from '@shared';
import { getApiBase } from './api';

/**
 * Score caller: recorded calls of the match's voice pack where available, otherwise the standard
 * voice (native text-to-speech on iOS / Android, Web Speech API in the browser). Calls are queued,
 * so three quick darts are announced one after another.
 */
export function callerAvailable(): boolean {
  if (Platform.OS !== 'web') return true;
  return typeof window !== 'undefined' && ('speechSynthesis' in window || 'Audio' in window);
}

export interface Call {
  /** voice pack key, e.g. "score_180", "dart_T20", "big_fish" */
  key?: string;
  /** what the standard voice says when the pack has no recording for the key */
  text: string | null;
}

const MAX_QUEUE = 6;
let queue: { url: string | null; text: string | null }[] = [];
let running = false;
let audioModeSet = false;

function origin(): string {
  const base = getApiBase();
  if (base) return base;
  return typeof window !== 'undefined' && window.location ? window.location.origin : '';
}

/** URL of a recorded clip (null = not recorded in this pack). */
export function clipUrl(voice: MatchVoice | null | undefined, key: string | undefined): string | null {
  if (!voice || !key || !voice.keys.includes(key)) return null;
  return origin() + voiceClipPath(voice.packId, key, voice.version);
}

export function announce(voice: MatchVoice | null | undefined, ...calls: Call[]) {
  if (!callerAvailable()) return;
  for (const c of calls) {
    const url = clipUrl(voice, c.key);
    if (url || c.text) queue.push({ url, text: c.text });
  }
  // never lag far behind the game
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  void run();
}

/** Play a recorded clip once (preview in the voice pack editor). */
export function playClip(url: string) {
  queue.push({ url, text: null });
  void run();
}

/** Standard voice only (e.g. "Game on" when switching the caller on). */
export function say(text: string) {
  announce(null, { text });
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      const played = item.url ? await playUrl(item.url) : false;
      if (!played && item.text) await speak(item.text);
    }
  } finally {
    running = false;
  }
}

function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // some browsers never fire onDone – do not block the queue
    const timer = setTimeout(finish, 1500 + text.length * 120);
    try {
      Speech.speak(text, {
        language: 'en-GB',
        rate: 1,
        onDone: () => {
          clearTimeout(timer);
          finish();
        },
        onStopped: () => {
          clearTimeout(timer);
          finish();
        },
        onError: () => {
          clearTimeout(timer);
          finish();
        },
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/** Plays a recorded call; false if it could not be played (the standard voice takes over). */
async function playUrl(url: string): Promise<boolean> {
  try {
    if (!audioModeSet) {
      audioModeSet = true;
      await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
    }
    const player = createAudioPlayer(url);
    return await new Promise<boolean>((resolve) => {
      let started = false;
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.remove();
        try {
          player.remove();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      // clips are at most a few seconds long; a clip that never starts falls back to the standard voice
      const timer = setTimeout(() => finish(started), 9000);
      const sub = player.addListener('playbackStatusUpdate', (status) => {
        if (status.playing) started = true;
        if (status.didJustFinish) finish(true);
      });
      player.play();
    });
  } catch {
    return false;
  }
}

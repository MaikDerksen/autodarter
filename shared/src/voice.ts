/**
 * Custom voice packs: everybody can record their own calls ("180", "Big Fish", "Triple 20" …).
 * Every call that is not recorded in the pack is spoken by the standard (text-to-speech) voice.
 */
import { segmentName, type Segment } from './board';

export type VoiceGroup = 'calls' | 'scores' | 'darts';

export interface VoiceKeyDef {
  key: string;
  /** shown in the app */
  label: string;
  /** what the standard voice says */
  say: string;
  group: VoiceGroup;
}

/** Uploaded clips are cut to at most this length (recordings stop automatically). */
export const VOICE_MAX_SECONDS = 10;
/** 10 s as 22 kHz mono WAV are ~440 kB – leaves room for recorded webm/m4a. */
export const VOICE_MAX_BYTES = 600_000;
export const VOICE_MAX_PACKS = 10;

export const VOICE_CALLS: VoiceKeyDef[] = [
  { key: 'game_on', label: 'Game on (Spielstart)', say: 'Game on', group: 'calls' },
  { key: 'game_shot', label: 'Game shot (Leg gewonnen)', say: 'Game shot!', group: 'calls' },
  { key: 'game_shot_match', label: 'Game shot and the match', say: 'Game shot, and the match!', group: 'calls' },
  { key: 'big_fish', label: 'Big Fish (170er Checkout)', say: 'Big Fish!', group: 'calls' },
  { key: 'bust', label: 'Bust', say: 'Bust', group: 'calls' },
];

/** Turn totals worth recording first. */
export const VOICE_SCORE_SUGGESTIONS = [180, 171, 140, 135, 125, 121, 100, 95, 85, 81, 60, 45, 41, 26, 0];

export function scoreKey(points: number): string {
  return `score_${points}`;
}

export function scoreSay(points: number): string {
  return points === 0 ? 'No score' : String(points);
}

export function dartKey(seg: Segment): string {
  return `dart_${segmentName(seg)}`;
}

/** Spoken name of a field, e.g. "Triple 20", "Bullseye". */
export function dartSay(seg: Segment): string {
  const { number: n, multiplier: m } = seg;
  if (!m || !n) return 'Miss';
  if (n === 25) return m === 2 ? 'Bullseye' : 'Bull';
  return m === 3 ? `Triple ${n}` : m === 2 ? `Double ${n}` : String(n);
}

/** All fields a single dart can hit, in the order shown in the app. */
export const VOICE_DART_SEGMENTS: Segment[] = (() => {
  const out: Segment[] = [];
  for (const m of [3, 2, 1] as const) for (let n = 20; n >= 1; n--) out.push({ number: n, multiplier: m });
  out.push({ number: 25, multiplier: 2 }, { number: 25, multiplier: 1 }, { number: 0, multiplier: 0 });
  return out;
})();

export function isVoiceKey(key: string): boolean {
  if (VOICE_CALLS.some((c) => c.key === key)) return true;
  const score = /^score_(\d{1,3})$/.exec(key);
  if (score) return Number(score[1]) <= 180;
  return /^dart_(MISS|[SDT]([1-9]|1\d|20)|[SD]25)$/.test(key);
}

/** Label for any key (for lists in the app). */
export function voiceLabel(key: string): string {
  const call = VOICE_CALLS.find((c) => c.key === key);
  if (call) return call.label;
  const score = /^score_(\d+)$/.exec(key);
  if (score) return Number(score[1]) === 0 ? 'No score (0)' : `${score[1]} Punkte`;
  const seg = VOICE_DART_SEGMENTS.find((s) => dartKey(s) === key);
  return seg ? dartSay(seg) : key;
}

/** A voice pack as the app sees it. */
export interface VoicePack {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  /** visible for friends (they can use it) */
  shared: boolean;
  mine: boolean;
  /** recorded calls */
  keys: string[];
  /** changes whenever a clip changes (cache buster for the clip URLs) */
  version: number;
}

/**
 * Who speaks in a match: "host" = the pack of the player who created the match for everybody,
 * "own" = every player with an account gets the pack chosen in their profile (players without
 * one, and guests, get the host's pack). A pack chosen per player when creating the match wins.
 */
export type VoiceMode = 'host' | 'own';

/** A pack as used in a match. */
export interface MatchVoice {
  packId: string;
  name: string;
  keys: string[];
  version: number;
}

/** URL of a recorded call (served without login – the pack id is the secret). */
export function voiceClipPath(packId: string, key: string, version: number): string {
  return `/api/voice/${packId}/${key}?v=${version}`;
}

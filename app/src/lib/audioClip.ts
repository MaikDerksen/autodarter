/**
 * Upload and trim audio files for voice packs (e.g. a meme from YouTube). Browser only: the file is
 * decoded with the Web Audio API, the chosen part is cut out, levelled and stored as a small mono WAV,
 * so every device can play it without the server having to convert anything.
 */
import { Platform } from 'react-native';

export const CLIP_SAMPLE_RATE = 22050;
const MAX_FILE_BYTES = 60 * 1024 * 1024;

export function canEditAudio(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    typeof window.AudioContext !== 'undefined' &&
    typeof window.OfflineAudioContext !== 'undefined'
  );
}

let ctx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Opens the file dialog; null if the user cancels. */
export function pickAudioFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,video/mp4,video/webm,.mp3,.m4a,.aac,.wav,.ogg,.opus,.webm,.mp4';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  if (blob.size > MAX_FILE_BYTES) throw new Error('Die Datei ist zu groß (max. 60 MB).');
  try {
    return await audioContext().decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error('Die Datei konnte nicht gelesen werden – bitte MP3, M4A, WAV, OGG oder WebM verwenden.');
  }
}

/** Loudness envelope of a part of the file (0..1 per bucket) for the waveform. */
export function peaks(buffer: AudioBuffer, from: number, to: number, buckets: number): number[] {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buffer.length, Math.ceil(to * sr));
  const per = Math.max(1, (b - a) / buckets);
  const out = new Array<number>(buckets).fill(0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < buckets; i++) {
      const s = Math.floor(a + i * per);
      const e = Math.min(b, Math.floor(a + (i + 1) * per));
      // long buckets: sample every few values, the peak is still clearly visible
      const step = Math.max(1, Math.floor((e - s) / 400));
      let m = out[i];
      for (let j = s; j < e; j += step) {
        const v = Math.abs(data[j]);
        if (v > m) m = v;
      }
      out[i] = m;
    }
  }
  const max = Math.max(0.01, ...out);
  return out.map((v) => v / max);
}

/** First moment the file gets audible (skips silence at the start). */
export function firstSound(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(buffer.sampleRate / 1000));
  for (let i = 0; i < data.length; i += step) if (Math.abs(data[i]) > 0.02) return Math.max(0, i / buffer.sampleRate - 0.05);
  return 0;
}

let preview: AudioBufferSourceNode | null = null;

/** Plays the selection; calls onEnd when it is over. */
export function playSelection(buffer: AudioBuffer, start: number, end: number, onEnd: () => void): void {
  stopPreview();
  const ac = audioContext();
  void ac.resume();
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.connect(ac.destination);
  src.onended = () => {
    if (preview === src) preview = null;
    onEnd();
  };
  src.start(0, start, Math.max(0.05, end - start));
  preview = src;
}

export function stopPreview(): void {
  if (!preview) return;
  const p = preview;
  preview = null;
  try {
    p.stop();
  } catch {
    // already stopped
  }
}

/** Cuts start..end out of the file as mono WAV (levelled, short fades against clicks). */
export async function encodeClip(buffer: AudioBuffer, start: number, end: number): Promise<{ data: string; mime: string }> {
  const sr = CLIP_SAMPLE_RATE;
  const duration = Math.max(0.1, end - start);
  const length = Math.ceil(duration * sr);
  const off = new OfflineAudioContext(1, length, sr);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0, start, duration);
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const gain = peak > 0.001 ? Math.min(8, 0.9 / peak) : 1;
  const fade = Math.min(Math.floor(sr * 0.008), Math.floor(pcm.length / 4));

  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(bytes);
  const text = (o: number, t: string) => [...t].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    let x = pcm[i] * gain;
    if (i < fade) x *= i / fade;
    else if (i > pcm.length - 1 - fade) x *= (pcm.length - 1 - i) / fade;
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true);
  }

  // base64 in chunks (String.fromCharCode with huge arrays overflows the stack)
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { data: btoa(bin), mime: 'audio/wav' };
}

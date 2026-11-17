import type { VoicePack } from '@shared';
import { useFocusFetch } from './hooks';

export interface VoicePacksResponse {
  packs: VoicePack[];
  /** pack used for matches I create (null = standard voice) */
  activeId: string | null;
}

export const useVoicePacks = () => useFocusFetch<VoicePacksResponse>('/api/voice-packs');

/** Reads a recorded file (file:// on iOS/Android, blob: on the web) as base64 for the upload. */
export async function readRecording(uri: string, fallbackMime: string): Promise<{ data: string; mime: string }> {
  const blob = await (await fetch(uri)).blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Aufnahme konnte nicht gelesen werden'));
    reader.readAsDataURL(blob);
  });
  const header = /^data:([^;,]+)/.exec(dataUrl)?.[1];
  let mime = blob.type || header || fallbackMime;
  // m4a recordings are reported as audio/x-m4a or application/octet-stream on some devices
  if (!mime.startsWith('audio/')) mime = fallbackMime;
  if (mime === 'audio/x-m4a' || mime === 'audio/m4a') mime = 'audio/mp4';
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mime };
}

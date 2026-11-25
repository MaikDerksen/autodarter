import { Linking, Platform } from 'react-native';
import { segmentLabel, type BugReportKind, type Segment } from '@shared';
import { getApiBase } from './api';

export const KIND_LABEL: Record<BugReportKind, string> = {
  wrong: 'Falsch erkannt',
  phantom: 'Dart ohne Wurf',
  missed: 'Nicht erkannt',
  other: 'Sonstiges',
};

/** Detection kinds and reasons as the board reports them. */
export const ENTRY_LABEL: Record<string, string> = {
  dart: 'Dart erkannt',
  bounce: 'Abpraller',
  discarded: 'Verworfene Änderung',
};

export const REASON_LABEL: Record<string, string> = {
  too_small: 'zu klein für einen Dart',
  shadow: 'als Schatten / Licht verworfen',
  fourth_dart: 'vierter Dart (Board war voll)',
  no_dart_found: 'Änderung, aber keine Dartlinie gefunden',
  flat: 'liegt flach auf dem Board (Schatten- / Lichtstreifen)',
  single_camera: 'nur eine Kamera, die anderen sehen dort nichts',
};

export const segText = (s: Segment | null | undefined, none = '–') => (s ? segmentLabel(s) : none);

/** Absolute link to an image / download of a report (signed token instead of the login header). */
export function reportUrl(path: string, token: string, query: Record<string, string> = {}): string {
  let base = getApiBase();
  if (!base && Platform.OS === 'web' && typeof window !== 'undefined') base = window.location.origin;
  const q = new URLSearchParams({ ...query, t: token }).toString();
  return `${base}${path}?${q}`;
}

export function download(url: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.assign(url); // attachment: the page stays, the browser saves the file
    return;
  }
  void Linking.openURL(url);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

import Ionicons from '@expo/vector-icons/Ionicons';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  VOICE_CALLS,
  VOICE_DART_SEGMENTS,
  VOICE_MAX_SECONDS,
  VOICE_SCORE_SUGGESTIONS,
  dartKey,
  dartSay,
  scoreKey,
  scoreSay,
  voiceClipPath,
  voiceLabel,
  type VoicePack,
} from '@shared';
import { ClipTrimmer } from '@/components/ClipTrimmer';
import { Button, Card, ErrorText, Field, H2, Loading, P, Row, Screen, Segmented } from '@/components/ui';
import { api, errorMessage, getApiBase } from '@/lib/api';
import { canEditAudio, decodeAudio, encodeClip, pickAudioFile } from '@/lib/audioClip';
import { playClip, say } from '@/lib/caller';
import { confirm } from '@/lib/confirm';
import { colors, radius } from '@/lib/theme';
import { readRecording, useVoicePacks } from '@/lib/voice';

/** What the standard voice says for a key (preview + hint). */
function standardText(key: string): string {
  const call = VOICE_CALLS.find((c) => c.key === key);
  if (call) return call.say;
  const score = /^score_(\d+)$/.exec(key);
  if (score) return scoreSay(Number(score[1]));
  const seg = VOICE_DART_SEGMENTS.find((sg) => dartKey(sg) === key);
  return seg ? dartSay(seg) : key;
}

function clipUrl(pack: VoicePack, key: string): string {
  const base = getApiBase() || (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  return base + voiceClipPath(pack.id, key, pack.version);
}

const DART_GROUPS: { title: string; filter: (k: string) => boolean }[] = [
  { title: 'Triple', filter: (k) => /^dart_T/.test(k) },
  { title: 'Double', filter: (k) => /^dart_D(?!25)/.test(k) },
  { title: 'Single', filter: (k) => /^dart_S(?!25)/.test(k) },
  { title: 'Bull & Miss', filter: (k) => /^dart_(D25|S25|MISS)$/.test(k) },
];

export default function VoicePackScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, loading, error, setData } = useVoicePacks();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [selected, setSelected] = useState<string>('score_180');
  const [recording, setRecording] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [extraScores, setExtraScores] = useState<number[]>([]);
  const [scoreInput, setScoreInput] = useState('');
  const [name, setName] = useState<string | null>(null);
  /** file (or existing clip) that is being trimmed for the selected call */
  const [trim, setTrim] = useState<{ key: string; buffer: AudioBuffer } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const pack = data?.packs.find((p) => p.id === id) ?? null;
  if (loading && !data) return <Loading />;
  if (!pack) {
    return (
      <Screen>
        <ErrorText>{error ?? 'Stimmen-Paket nicht gefunden.'}</ErrorText>
      </Screen>
    );
  }

  const recorded = new Set(pack.keys);
  const mine = pack.mine;
  const replacePack = (p: VoicePack) => data && setData({ ...data, packs: data.packs.map((x) => (x.id === p.id ? p : x)) });

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const startRecording = () =>
    run('record', async () => {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) throw new Error('Kein Zugriff aufs Mikrofon – bitte in den Einstellungen erlauben.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      const key = selected;
      setRecording(key);
      setSeconds(0);
      const started = Date.now();
      timer.current = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= VOICE_MAX_SECONDS) finishRecording(key);
      }, 250);
    });

  /** Stop button or time limit: stop, upload, show as recorded. */
  function finishRecording(key: string) {
    if (!timer.current) return; // already stopped
    clearInterval(timer.current);
    timer.current = null;
    setRecording(null);
    void run('upload', async () => {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      const uri = recorder.uri;
      if (!uri) throw new Error('Aufnahme fehlgeschlagen');
      const clip = await readRecording(uri, Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4');
      replacePack(await api<VoicePack>(`/api/voice-packs/${pack!.id}/clips/${key}`, { method: 'PUT', body: clip }));
    });
  }

  /** Upload an audio file (meme, jingle …) and cut out the part for the selected call. */
  const uploadFile = () =>
    run('file', async () => {
      const file = await pickAudioFile();
      if (!file) return;
      setTrim({ key: selected, buffer: await decodeAudio(file) });
    });

  /** Trim the existing recording of the selected call again. */
  const trimExisting = () =>
    run('trimLoad', async () => {
      const res = await fetch(clipUrl(pack, selected));
      if (!res.ok) throw new Error('Aufnahme konnte nicht geladen werden');
      setTrim({ key: selected, buffer: await decodeAudio(await res.blob()) });
    });

  const saveTrim = (start: number, end: number) =>
    run('trimSave', async () => {
      if (!trim) return;
      const clip = await encodeClip(trim.buffer, start, end);
      replacePack(await api<VoicePack>(`/api/voice-packs/${pack.id}/clips/${trim.key}`, { method: 'PUT', body: clip }));
      setTrim(null);
    });

  const removeClip = () =>
    run('delete', async () => {
      replacePack(await api<VoicePack>(`/api/voice-packs/${pack.id}/clips/${selected}`, { method: 'DELETE' }));
    });

  const saveName = () =>
    run('name', async () => {
      if (!name?.trim()) return;
      replacePack(await api<VoicePack>(`/api/voice-packs/${pack.id}`, { method: 'PATCH', body: { name: name.trim() } }));
      setName(null);
    });

  const setShared = (shared: boolean) =>
    run('share', async () => {
      replacePack(await api<VoicePack>(`/api/voice-packs/${pack.id}`, { method: 'PATCH', body: { shared } }));
    });

  const deletePack = async () => {
    if (!(await confirm('Stimmen-Paket löschen?', `„${pack.name}“ mit allen Aufnahmen wird gelöscht.`, 'Löschen'))) return;
    await run('deletePack', async () => {
      await api(`/api/voice-packs/${pack.id}`, { method: 'DELETE' });
      router.back();
    });
  };

  const addScore = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 180) return;
    if (!extraScores.includes(n)) setExtraScores([...extraScores, n]);
    setSelected(scoreKey(n));
    setScoreInput('');
  };

  const scoreKeys = [
    ...new Set([
      ...pack.keys.filter((k) => k.startsWith('score_')).map((k) => Number(k.slice(6))),
      ...extraScores,
      ...(mine ? [180, 140, 100, 0] : []),
    ]),
  ]
    .sort((a, b) => b - a)
    .map(scoreKey);
  const dartKeys = VOICE_DART_SEGMENTS.map(dartKey).filter((k) => mine || recorded.has(k));
  const callKeys = VOICE_CALLS.map((c) => c.key).filter((k) => mine || recorded.has(k));
  const isRec = recorded.has(selected);

  const chip = (key: string, label?: string) => {
    const active = key === selected;
    const has = recorded.has(key);
    return (
      <Pressable
        key={key}
        onPress={() => !recording && !trim && setSelected(key)}
        accessibilityRole="button"
        style={({ pressed }) => [s.chip, has && s.chipRecorded, active && s.chipActive, pressed && { opacity: 0.8 }]}
      >
        {has ? <Ionicons name="checkmark-circle" size={14} color={active ? colors.text : colors.accent} /> : null}
        <Text style={[s.chipText, active && { color: colors.text }]}>{label ?? voiceLabel(key)}</Text>
      </Pressable>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: pack.name }} />
      <Screen maxWidth={900}>
        <Card>
          {mine ? (
            <>
              <Row style={{ alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <Field label="Name" value={name ?? pack.name} onChangeText={setName} onSubmitEditing={saveName} />
                </View>
                {name !== null && name.trim() && name.trim() !== pack.name ? (
                  <Button title="Speichern" icon="save" onPress={saveName} loading={busy === 'name'} />
                ) : null}
              </Row>
              <Segmented<'shared' | 'private'>
                options={[
                  { value: 'shared', label: 'Für Freunde sichtbar' },
                  { value: 'private', label: 'Nur für mich' },
                ]}
                value={pack.shared ? 'shared' : 'private'}
                onChange={(v) => void setShared(v === 'shared')}
              />
            </>
          ) : (
            <P muted>
              Paket von {pack.ownerName}. Du kannst es anhören und unter „Stimmen“ für deine Spiele auswählen – ändern kann es nur{' '}
              {pack.ownerName}.
            </P>
          )}
          <P muted>
            Sprich nur ein, worauf du Lust hast. Alles ohne Aufnahme sagt die Standardstimme. Maximal {VOICE_MAX_SECONDS} Sekunden pro Ansage.
          </P>
          {mine ? (
            <P muted>
              {canEditAudio()
                ? 'Statt aufzunehmen kannst du auch eine Audiodatei hochladen (z. B. ein Meme als MP3) und die passende Stelle zuschneiden.'
                : 'Audiodateien hochladen und zuschneiden geht in der Browser-Version.'}
            </P>
          ) : null}
        </Card>

        {/* action panel for the selected call */}
        <Card style={[s.panel, recording ? { borderColor: colors.danger } : null]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Ionicons name={isRec ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={isRec ? colors.accent : colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={s.panelTitle}>{voiceLabel(trim ? trim.key : selected)}</Text>
              <Text style={s.panelSub}>{isRec ? 'Eigene Aufnahme' : `Standardstimme: „${standardText(selected)}“`}</Text>
            </View>
            {recording ? (
              <View style={s.recBadge}>
                <View style={s.recDot} />
                <Text style={s.recText}>
                  {seconds}/{VOICE_MAX_SECONDS} s
                </Text>
              </View>
            ) : null}
          </View>
          {trim ? (
            <ClipTrimmer
              buffer={trim.buffer}
              maxSeconds={VOICE_MAX_SECONDS}
              saving={busy === 'trimSave'}
              onSave={saveTrim}
              onCancel={() => setTrim(null)}
            />
          ) : (
          <Row wrap>
            {mine ? (
              recording ? (
                <Button title="Stopp & speichern" icon="stop" variant="danger" onPress={() => finishRecording(recording)} />
              ) : (
                <Button
                  title={isRec ? 'Neu aufnehmen' : 'Aufnehmen'}
                  icon="mic"
                  onPress={startRecording}
                  loading={busy === 'record' || busy === 'upload'}
                />
              )
            ) : null}
            <Button
              title="Anhören"
              icon="play"
              variant="secondary"
              onPress={() => (isRec ? playClip(clipUrl(pack, selected)) : say(standardText(selected)))}
              disabled={!!recording}
            />
            {mine && canEditAudio() && !recording ? (
              <Button title="Datei hochladen" icon="cloud-upload" variant="secondary" onPress={uploadFile} loading={busy === 'file'} />
            ) : null}
            {mine && isRec && canEditAudio() && !recording ? (
              <Button title="Zuschneiden" icon="cut" variant="ghost" onPress={trimExisting} loading={busy === 'trimLoad'} />
            ) : null}
            {mine && isRec ? (
              <Button title="Aufnahme löschen" icon="trash" variant="ghost" onPress={removeClip} loading={busy === 'delete'} disabled={!!recording} />
            ) : null}
          </Row>
          )}
          <ErrorText>{actionError}</ErrorText>
        </Card>

        {callKeys.length ? (
          <Card>
            <H2>Ansagen</H2>
            <View style={s.grid}>{callKeys.map((k) => chip(k))}</View>
          </Card>
        ) : null}

        <Card>
          <H2>Punkte einer Aufnahme (X01)</H2>
          <View style={s.grid}>{scoreKeys.map((k) => chip(k, k === 'score_0' ? 'No score' : k.slice(6)))}</View>
          {mine ? (
            <>
              <Row style={{ alignItems: 'flex-end' }}>
                <View style={{ width: 160 }}>
                  <Field
                    label="Weitere Punktzahl"
                    placeholder="0–180"
                    keyboardType="number-pad"
                    value={scoreInput}
                    onChangeText={(t) => setScoreInput(t.replace(/\D/g, '').slice(0, 3))}
                    onSubmitEditing={() => addScore(Number(scoreInput))}
                  />
                </View>
                <Button
                  title="Hinzufügen"
                  icon="add"
                  variant="secondary"
                  onPress={() => addScore(Number(scoreInput))}
                  disabled={!scoreInput || Number(scoreInput) > 180}
                />
              </Row>
              <Text style={s.hint}>Beliebt:</Text>
              <View style={s.grid}>
                {VOICE_SCORE_SUGGESTIONS.filter((n) => !scoreKeys.includes(scoreKey(n))).map((n) => (
                  <Pressable key={n} onPress={() => addScore(n)} style={({ pressed }) => [s.chip, s.chipGhost, pressed && { opacity: 0.8 }]}>
                    <Ionicons name="add" size={14} color={colors.muted} />
                    <Text style={s.chipText}>{n === 0 ? 'No score' : n}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </Card>

        {dartKeys.length ? (
          <Card>
            <H2>Einzelne Darts (Cricket & Around the Clock)</H2>
            {DART_GROUPS.map((g) => {
              const keys = dartKeys.filter(g.filter);
              if (!keys.length) return null;
              return (
                <View key={g.title} style={{ gap: 6 }}>
                  <Text style={s.hint}>{g.title}</Text>
                  <View style={s.grid}>{keys.map((k) => chip(k, k.replace(/^dart_/, '').replace('S25', '25').replace('D25', 'Bull').replace('MISS', 'Miss')))}</View>
                </View>
              );
            })}
          </Card>
        ) : null}

        {mine ? <Button title="Paket löschen" icon="trash" variant="danger" onPress={deletePack} loading={busy === 'deletePack'} /> : null}
      </Screen>
    </>
  );
}

const s = StyleSheet.create({
  panel: { gap: 12 },
  panelTitle: { color: colors.text, fontWeight: '800', fontSize: 18 },
  panelSub: { color: colors.muted, fontSize: 13 },
  recBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.dangerDim },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  recText: { color: '#fecaca', fontWeight: '800', fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 52,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  chipRecorded: { borderColor: colors.accentDim, backgroundColor: '#0f2418' },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipGhost: { borderStyle: 'dashed' },
  chipText: { color: colors.muted, fontWeight: '700', fontSize: 13 },
  hint: { color: colors.faint, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
});

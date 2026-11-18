import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { Button, Row } from '@/components/ui';
import { firstSound, peaks, playSelection, stopPreview } from '@/lib/audioClip';
import { colors, radius } from '@/lib/theme';

const HEIGHT = 96;
const BARS = 220;
const STEP = 0.1;
const MIN_LEN = 0.2;

const sec = (v: number) => `${v.toFixed(1).replace('.', ',')} s`;

/**
 * Pick the part of an audio file that becomes the call: drag on the waveform (the nearer edge
 * follows), fine-tune with the ± buttons, listen, save. At most maxSeconds long.
 */
export function ClipTrimmer({
  buffer,
  maxSeconds,
  saving,
  onSave,
  onCancel,
}: {
  buffer: AudioBuffer;
  maxSeconds: number;
  saving: boolean;
  onSave: (start: number, end: number) => void;
  onCancel: () => void;
}) {
  const duration = buffer.duration;
  const [range, setRange] = useState(() => {
    const s = Math.min(firstSound(buffer), Math.max(0, duration - MIN_LEN));
    return { start: s, end: Math.min(duration, s + maxSeconds) };
  });
  const [zoom, setZoom] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [width, setWidth] = useState(0);
  const drag = useRef<{ edge: 'start' | 'end'; offsetX: number } | null>(null);

  useEffect(() => () => stopPreview(), []);

  // shown part of the file: everything, or the selection with a bit around it
  const view = useMemo(() => {
    if (!zoom) return { from: 0, to: duration };
    const pad = Math.max(1, (range.end - range.start) * 0.4);
    return {
      from: Math.max(0, range.start - pad),
      to: Math.min(duration, range.end + pad),
    };
    // the zoom window is fixed when zooming in, not while dragging
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, duration]);
  const bars = useMemo(() => peaks(buffer, view.from, view.to, BARS), [buffer, view]);

  const toX = (t: number) => ((t - view.from) / (view.to - view.from)) * width;
  const toT = (x: number) => view.from + (Math.min(width, Math.max(0, x)) / Math.max(1, width)) * (view.to - view.from);

  /** Move one edge; the other one follows if the selection would get too long or too short. */
  const moveEdge = (edge: 'start' | 'end', t: number) => {
    setRange((r) => {
      let { start, end } = r;
      if (edge === 'start') {
        start = Math.min(Math.max(0, t), duration - MIN_LEN);
        if (end - start < MIN_LEN) end = start + MIN_LEN;
        if (end - start > maxSeconds) end = start + maxSeconds;
      } else {
        end = Math.max(Math.min(duration, t), MIN_LEN);
        if (end - start < MIN_LEN) start = end - MIN_LEN;
        if (end - start > maxSeconds) start = end - maxSeconds;
      }
      return { start: Math.max(0, start), end: Math.min(duration, end) };
    });
  };

  const onGrant = (e: GestureResponderEvent) => {
    const { locationX, pageX } = e.nativeEvent;
    const t = toT(locationX);
    const edge = Math.abs(t - range.start) <= Math.abs(t - range.end) ? 'start' : 'end';
    drag.current = { edge, offsetX: pageX - locationX };
    moveEdge(edge, t);
  };
  const onMove = (e: GestureResponderEvent) => {
    if (!drag.current) return;
    moveEdge(drag.current.edge, toT(e.nativeEvent.pageX - drag.current.offsetX));
  };

  const togglePlay = () => {
    if (playing) {
      stopPreview();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    playSelection(buffer, range.start, range.end, () => setPlaying(false));
  };

  const len = range.end - range.start;
  const barW = width / BARS;

  return (
    <View style={{ gap: 10 }}>
      <Text style={s.info}>
        Datei: {sec(duration)} · markiere bis zu {maxSeconds} s. Ziehe auf der Welle, die nähere Kante folgt.
      </Text>
      <View
        style={s.wave}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={() => (drag.current = null)}
        onResponderTerminate={() => (drag.current = null)}
      >
        {width > 0 ? (
          <Svg width={width} height={HEIGHT} style={{ pointerEvents: 'none' }}>
            <Rect
              x={toX(range.start)}
              y={0}
              width={Math.max(1, toX(range.end) - toX(range.start))}
              height={HEIGHT}
              fill={colors.accentDim}
            />
            {bars.map((v, i) => {
              const t = view.from + ((i + 0.5) / BARS) * (view.to - view.from);
              const inside = t >= range.start && t <= range.end;
              const h = Math.max(1, v * (HEIGHT - 8));
              const x = i * barW + barW / 2;
              return (
                <Line
                  key={i}
                  x1={x}
                  x2={x}
                  y1={(HEIGHT - h) / 2}
                  y2={(HEIGHT + h) / 2}
                  stroke={inside ? colors.accent : colors.faint}
                  strokeWidth={Math.max(1, barW * 0.6)}
                />
              );
            })}
            <Line x1={toX(range.start)} x2={toX(range.start)} y1={0} y2={HEIGHT} stroke={colors.text} strokeWidth={2} />
            <Line x1={toX(range.end)} x2={toX(range.end)} y1={0} y2={HEIGHT} stroke={colors.text} strokeWidth={2} />
          </Svg>
        ) : null}
      </View>

      <Row wrap style={{ alignItems: 'center' }}>
        <Edge label="Start" value={range.start} onStep={(d) => moveEdge('start', range.start + d)} />
        <Edge label="Ende" value={range.end} onStep={(d) => moveEdge('end', range.end + d)} />
        <Text style={[s.info, { color: len > maxSeconds - 0.05 ? colors.warning : colors.muted }]}>Länge {sec(len)}</Text>
      </Row>

      <Row wrap>
        <Button title={playing ? 'Stopp' : 'Auswahl anhören'} icon={playing ? 'stop' : 'play'} variant="secondary" onPress={togglePlay} />
        {duration > maxSeconds * 1.5 ? (
          <Button
            title={zoom ? 'Ganze Datei' : 'Auswahl vergrößern'}
            icon={zoom ? 'contract' : 'expand'}
            variant="ghost"
            onPress={() => setZoom(!zoom)}
          />
        ) : null}
        <Button
          title="Speichern"
          icon="save"
          onPress={() => {
            stopPreview();
            onSave(range.start, range.end);
          }}
          loading={saving}
        />
        <Button
          title="Abbrechen"
          variant="ghost"
          onPress={() => {
            stopPreview();
            onCancel();
          }}
          disabled={saving}
        />
      </Row>
    </View>
  );
}

function Edge({ label, value, onStep }: { label: string; value: number; onStep: (d: number) => void }) {
  return (
    <View style={s.edge}>
      <Text style={s.edgeLabel}>{label}</Text>
      <Pressable onPress={() => onStep(-STEP)} style={s.step} accessibilityLabel={`${label} 0,1 Sekunden früher`}>
        <Text style={s.stepText}>−</Text>
      </Pressable>
      <Text style={s.edgeValue}>{sec(value)}</Text>
      <Pressable onPress={() => onStep(STEP)} style={s.step} accessibilityLabel={`${label} 0,1 Sekunden später`}>
        <Text style={s.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  info: { color: colors.muted, fontSize: 13 },
  wave: {
    height: HEIGHT,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    cursor: 'pointer',
    userSelect: 'none',
  },
  edge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  edgeLabel: {
    color: colors.faint,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  edgeValue: {
    color: colors.text,
    fontWeight: '800',
    minWidth: 52,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  step: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  stepText: { color: colors.text, fontSize: 18, fontWeight: '800' },
});

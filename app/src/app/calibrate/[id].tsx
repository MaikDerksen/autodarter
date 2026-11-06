import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { CALIBRATION_POINTS, type BoardSummary, type Point } from '@shared';
import { boardToImage, wireframePath } from '@/components/BoardOverlay';
import { Button, Card, ErrorText, H2, Loading, P, Row, Screen } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { colors, radius } from '@/lib/theme';

interface Snapshot {
  data: string;
  width: number;
  height: number;
}

/** Rough starting positions: a flat ellipse in the middle of the image (cameras look at the board from the side). */
function defaultPoints(): Point[] {
  return CALIBRATION_POINTS.map((p) => ({ x: 0.5 + (p.x / 170) * 0.3, y: 0.55 - (p.y / 170) * 0.14 }));
}

const POINT_COLORS = ['#f43f5e', '#f59e0b', '#22c55e', '#38bdf8', '#e879f9'];
const LOUPE = 150;
const ZOOM = 4;

export default function CalibrateScreen() {
  const { id, cam: camParam } = useLocalSearchParams<{ id: string; cam: string }>();
  const cam = Number(camParam ?? 0);
  const { width: screenWidth } = useWindowDimensions();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [points, setPoints] = useState<Point[]>(defaultPoints);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const drag = useRef<{ index: number; offsetX: number; offsetY: number } | null>(null);

  const loadSnapshot = useCallback(async () => {
    setBusy('snapshot');
    setError(null);
    try {
      setSnap(await api<Snapshot>(`/api/boards/${id}/cameras/${cam}/snapshot`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [id, cam]);

  useEffect(() => {
    api<BoardSummary>(`/api/boards/${id}`)
      .then((b) => {
        const c = b.calibration?.[String(cam)];
        if (c?.points?.length === CALIBRATION_POINTS.length) setPoints(c.points);
      })
      .catch(() => undefined);
    void loadSnapshot();
  }, [id, cam, loadSnapshot]);

  const imgW = Math.min(screenWidth - 64, 1200);
  const imgH = snap ? (imgW * snap.height) / snap.width : imgW * (9 / 16);

  const wire = useMemo(() => {
    const H = boardToImage(points, imgW, imgH);
    return H ? wireframePath(H) : null;
  }, [points, imgW, imgH]);

  const setPoint = useCallback((index: number, p: Point) => {
    setPoints((pts) => pts.map((q, i) => (i === index ? { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) } : q)));
    setDirty(true);
  }, []);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const stepX = 1 / (snap?.width ?? 1280);
      const stepY = 1 / (snap?.height ?? 720);
      setPoints((pts) => pts.map((q, i) => (i === selected ? { x: q.x + dx * stepX, y: q.y + dy * stepY } : q)));
      setDirty(true);
    },
    [selected, snap],
  );

  // keyboard support on the web: arrows move, shift = 10px, 1-5 select
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      const step = e.shiftKey ? 10 : 1;
      const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (map[e.key]) {
        e.preventDefault();
        nudge(...map[e.key]);
      } else if (/^[1-5]$/.test(e.key)) setSelected(Number(e.key) - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge]);

  const onGrant = (e: GestureResponderEvent) => {
    const { locationX, locationY, pageX, pageY } = e.nativeEvent;
    let best = -1;
    let bestDist = 36;
    points.forEach((p, i) => {
      const d = Math.hypot(p.x * imgW - locationX, p.y * imgH - locationY);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    const index = best >= 0 ? best : selected;
    setSelected(index);
    if (best < 0) setPoint(index, { x: locationX / imgW, y: locationY / imgH });
    drag.current = { index, offsetX: pageX - locationX, offsetY: pageY - locationY };
  };

  const onMove = (e: GestureResponderEvent) => {
    if (!drag.current) return;
    const { pageX, pageY } = e.nativeEvent;
    setPoint(drag.current.index, { x: (pageX - drag.current.offsetX) / imgW, y: (pageY - drag.current.offsetY) / imgH });
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await api(`/api/boards/${id}/cameras/${cam}/calibration`, { method: 'PUT', body: { points } });
      setDirty(false);
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const sel = points[selected];
  const imageUri = snap ? `data:image/jpeg;base64,${snap.data}` : null;

  return (
    <>
      <Stack.Screen options={{ title: `Kalibrierung · Kamera ${cam + 1}` }} />
      <Screen maxWidth={1300}>
        <Card>
          <H2>So geht's</H2>
          <P muted>
            Ziehe jeden farbigen Punkt exakt auf die äußere Kante des Doppelrings an der jeweiligen Segmentgrenze (z. B. „20 | 1“ = Draht zwischen 20 und 1)
            und den Bull-Punkt in die Mitte des Bullseye. Das grüne Netz zeigt live, wie das Board aus Sicht dieser Kamera erkannt wird – es muss genau auf
            den Drähten liegen. Tippen auf eine freie Stelle setzt den ausgewählten Punkt dorthin. Feinjustierung: Pfeiltasten (Shift = 10 px) oder Buttons.
          </P>
          <Row wrap>
            {CALIBRATION_POINTS.map((p, i) => (
              <Pressable key={p.id} onPress={() => setSelected(i)} style={[st.pointChip, selected === i && { borderColor: POINT_COLORS[i], backgroundColor: POINT_COLORS[i] + '22' }]}>
                <View style={[st.dot, { backgroundColor: POINT_COLORS[i] }]} />
                <Text style={{ color: colors.text, fontWeight: '700' }}>
                  {i + 1}. {p.label}
                </Text>
              </Pressable>
            ))}
          </Row>
        </Card>

        <Card style={{ alignItems: 'center' }}>
          {!snap ? (
            busy === 'snapshot' ? (
              <Loading label="Hole Kamerabild …" />
            ) : (
              <ErrorText>{error ?? 'Kein Bild'}</ErrorText>
            )
          ) : (
            <View style={{ width: imgW, height: imgH, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000' }}>
              <Image source={{ uri: imageUri! }} style={{ width: imgW, height: imgH }} resizeMode="stretch" />
              <Svg width={imgW} height={imgH} style={StyleSheet.absoluteFill} pointerEvents="none">
                {wire ? <Path d={wire} stroke="#22c55e" strokeWidth={1.3} fill="none" opacity={0.9} /> : null}
                {points.map((p, i) => (
                  <G key={i}>
                    <Circle cx={p.x * imgW} cy={p.y * imgH} r={selected === i ? 11 : 8} stroke={POINT_COLORS[i]} strokeWidth={3} fill="none" />
                    <Circle cx={p.x * imgW} cy={p.y * imgH} r={1.8} fill={POINT_COLORS[i]} />
                    <SvgText x={p.x * imgW + 13} y={p.y * imgH - 10} fill={POINT_COLORS[i]} fontSize={13} fontWeight="800">
                      {CALIBRATION_POINTS[i].label}
                    </SvgText>
                  </G>
                ))}
              </Svg>
              <View
                style={StyleSheet.absoluteFill}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderTerminationRequest={() => false}
                onResponderGrant={onGrant}
                onResponderMove={onMove}
                onResponderRelease={() => (drag.current = null)}
              />
            </View>
          )}
        </Card>

        {snap && sel ? (
          <Card>
            <Row wrap gap={20} style={{ alignItems: 'center' }}>
              <View style={st.loupe}>
                <Image
                  source={{ uri: imageUri! }}
                  resizeMode="stretch"
                  style={{
                    position: 'absolute',
                    width: imgW * ZOOM,
                    height: imgH * ZOOM,
                    left: LOUPE / 2 - sel.x * imgW * ZOOM,
                    top: LOUPE / 2 - sel.y * imgH * ZOOM,
                  }}
                />
                <Svg width={LOUPE} height={LOUPE} style={StyleSheet.absoluteFill} pointerEvents="none">
                  <Line x1={LOUPE / 2} y1={0} x2={LOUPE / 2} y2={LOUPE} stroke={POINT_COLORS[selected]} strokeWidth={1} />
                  <Line x1={0} y1={LOUPE / 2} x2={LOUPE} y2={LOUPE / 2} stroke={POINT_COLORS[selected]} strokeWidth={1} />
                </Svg>
              </View>
              <View style={{ gap: 8 }}>
                <Text style={{ color: colors.text, fontWeight: '800' }}>
                  Punkt {selected + 1}: {CALIBRATION_POINTS[selected].label}
                </Text>
                <Text style={{ color: colors.muted }}>
                  {Math.round(sel.x * snap.width)} / {Math.round(sel.y * snap.height)} px
                </Text>
                <View style={{ alignItems: 'center', gap: 4 }}>
                  <Button small variant="secondary" icon="chevron-up" onPress={() => nudge(0, -1)} />
                  <Row gap={4}>
                    <Button small variant="secondary" icon="chevron-back" onPress={() => nudge(-1, 0)} />
                    <Button small variant="secondary" icon="chevron-down" onPress={() => nudge(0, 1)} />
                    <Button small variant="secondary" icon="chevron-forward" onPress={() => nudge(1, 0)} />
                  </Row>
                </View>
              </View>
            </Row>
          </Card>
        ) : null}

        <ErrorText>{snap ? error : null}</ErrorText>
        <Row wrap>
          <Button title="Speichern" icon="checkmark" onPress={save} loading={busy === 'save'} disabled={!snap} />
          <Button title="Neues Bild" variant="secondary" icon="camera" onPress={loadSnapshot} loading={busy === 'snapshot'} />
          <Button
            title="Punkte zurücksetzen"
            variant="secondary"
            icon="refresh"
            onPress={() => {
              setPoints(defaultPoints());
              setDirty(true);
            }}
          />
          <Button title="Abbrechen" variant="ghost" onPress={() => router.back()} />
          {dirty ? (
            <Row gap={6}>
              <Ionicons name="ellipse" size={10} color={colors.warning} />
              <Text style={{ color: colors.warning }}>Nicht gespeichert</Text>
            </Row>
          ) : null}
        </Row>
      </Screen>
    </>
  );
}

const st = StyleSheet.create({
  pointChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  loupe: {
    width: LOUPE,
    height: LOUPE,
    borderRadius: LOUPE / 2,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#000',
  },
});

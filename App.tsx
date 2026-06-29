/**
 * Reproduction: SIGABRT in mqt_v_js when `scheduleOnRN` is called from inside
 * a `withTiming` completion callback under concurrent Skia animation load.
 *
 *   jsi.h:2014: Object facebook::jsi::Value::getObject(IRuntime &) &&:
 *               assertion "isObject()" failed
 *   Fatal signal 6 (SIGABRT) in tid mqt_v_js
 *   backtrace: libworklets.so → Value::getObject
 *              → CallInvoker::invokeAsync lambda
 *              → RuntimeScheduler_Modern → JNativeRunnable::run()
 *
 * Buggy pattern (three concurrent instances):
 *
 *   opacity.value = withTiming(0, { duration: D }, finished => {
 *     'worklet';
 *     if (finished) scheduleOnRN(fn, arg);  // ← UAF: JSI ref freed after callback returns
 *   });
 *
 * Fix: replace scheduleOnRN inside withTiming with a JS-side setTimeout.
 */

import { Canvas, Image as SkiaImage, Skia } from '@shopify/react-native-skia';
import type { SkImage } from '@shopify/react-native-skia';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  cancelAnimation,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

// ─── Constants ───────────────────────────────────────────────────────────────

const CROSSFADE_EXIT_DURATION_1 = 700; // mirrors useSkiaCrossfadeTransition
const CROSSFADE_EXIT_DURATION_2 = 600; // mirrors CrossfadeImage
const CROSSFADE_ENTER_DURATION = 400;
const CROSSFADE_INTERVAL_MS = 1000; // > exit duration → animation always completes

const CHAR_EXIT_DURATION = 700; // mirrors SharedCharacterAnimatedImageViewer
const CHAR_CYCLE_MS = 800;
const STAGGER_MS = 80;
const CHARACTER_COUNT = 10; // × 2 layers = 20 total

const SCENE_INTERVAL_MS = 80;

// ─── Image loading ────────────────────────────────────────────────────────────

const IMAGE_URLS = [
  'https://dimg.donga.com/wps/NEWS/IMAGE/2026/03/05/133467661.1.jpg',
  'https://cdn.nc.press/news/photo/202602/608852_817067_3346.jpg',
];

async function fetchSkiaImage(url: string): Promise<SkImage | null> {
  try {
    const res = await fetch(url);
    const data = Skia.Data.fromBytes(new Uint8Array(await res.arrayBuffer()));
    const img = Skia.Image.MakeImageFromEncoded(data);
    data.dispose();
    return img;
  } catch {
    return null;
  }
}

// ─── CrossfadeLayer — Pattern 1 and 2 ────────────────────────────────────────
// Mirrors useSkiaCrossfadeTransition / CrossfadeImage (buggy version).

interface CrossfadeLayerProps {
  imageA: SkImage | null;
  imageB: SkImage | null;
  exitDuration: number;
  label: string;
}

function CrossfadeLayer({
  imageA,
  imageB,
  exitDuration,
  label,
}: CrossfadeLayerProps) {
  const currentSlot = useRef<'A' | 'B'>('A');
  const [slotA, setSlotA] = useState<SkImage | null>(imageA);
  const [slotB, setSlotB] = useState<SkImage | null>(null);
  const [cycle, setCycle] = useState(0);
  const alphaA = useSharedValue(1);
  const alphaB = useSharedValue(0);

  useEffect(() => {
    const id = setInterval(() => setCycle(c => c + 1), CROSSFADE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (cycle === 0) return;
    const imgs = [imageA, imageB];
    const next = imgs[cycle % imgs.length] ?? null;
    const prev = currentSlot.current;
    const nextSlot: 'A' | 'B' = prev === 'A' ? 'B' : 'A';
    currentSlot.current = nextSlot;
    cancelAnimation(alphaA);
    cancelAnimation(alphaB);

    if (nextSlot === 'A') {
      setSlotA(next);
      alphaA.value = withTiming(1, { duration: CROSSFADE_ENTER_DURATION });
      alphaB.value = withTiming(0, { duration: exitDuration }, finished => {
        'worklet';
        if (finished) scheduleOnRN(setSlotB, null); // ← BUGGY
      });
    } else {
      setSlotB(next);
      alphaB.value = withTiming(1, { duration: CROSSFADE_ENTER_DURATION });
      alphaA.value = withTiming(0, { duration: exitDuration }, finished => {
        'worklet';
        if (finished) scheduleOnRN(setSlotA, null); // ← BUGGY
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle]);

  const W = 120;
  const H = 80;
  return (
    <View style={styles.crossfadeWrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ width: W, height: H }}>
        <Canvas style={StyleSheet.absoluteFill}>
          {slotA ? (
            <SkiaImage
              image={slotA}
              x={0}
              y={0}
              width={W}
              height={H}
              fit="cover"
              opacity={alphaA}
            />
          ) : null}
          {slotB ? (
            <SkiaImage
              image={slotB}
              x={0}
              y={0}
              width={W}
              height={H}
              fit="cover"
              opacity={alphaB}
            />
          ) : null}
        </Canvas>
      </View>
    </View>
  );
}

// ─── CharacterUnit — Pattern 3 ────────────────────────────────────────────────
// Mirrors SharedCharacterAnimatedImageViewer (buggy version).

interface CharacterUnitProps {
  id: number;
  shouldExit: boolean;
  onExitComplete: (id: number) => void;
  img: SkImage | null;
}

function CharacterUnit({
  id,
  shouldExit,
  onExitComplete,
  img,
}: CharacterUnitProps) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (!shouldExit) {
      opacity.value = withTiming(1, { duration: 200 });
      return;
    }
    opacity.value = withTiming(
      0,
      { duration: CHAR_EXIT_DURATION },
      finished => {
        'worklet';
        if (finished) scheduleOnRN(onExitComplete, id); // ← BUGGY
      },
    );
  }, [shouldExit, opacity, onExitComplete, id]);

  const W = 56;
  const H = 72;
  return (
    <Canvas style={{ width: W, height: H }}>
      {img ? (
        <SkiaImage
          image={img}
          x={0}
          y={0}
          width={W}
          height={H}
          fit="cover"
          opacity={opacity}
        />
      ) : null}
    </Canvas>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [running, setRunning] = useState(false);
  const [scene, setScene] = useState(0);
  const totalChars = CHARACTER_COUNT * 2;
  const [exits, setExits] = useState<boolean[]>(
    Array.from({ length: totalChars }, () => false),
  );
  const [images, setImages] = useState<[SkImage | null, SkImage | null]>([
    null,
    null,
  ]);
  const [status, setStatus] = useState('Loading images…');
  const exitCount = useRef(0);

  useEffect(() => {
    Promise.all(IMAGE_URLS.map(fetchSkiaImage)).then(([a, b]) => {
      setImages([a, b]);
      setStatus(a && b ? 'Ready — tap Start' : 'Image load failed');
    });
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setScene(s => s + 1), SCENE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    type TimerWithInner = ReturnType<typeof setTimeout> & {
      _inner?: ReturnType<typeof setInterval>;
    };
    const timers: TimerWithInner[] = [];
    for (let i = 0; i < totalChars; i++) {
      let entering = false;
      const tick = (idx: number) => {
        entering = !entering;
        setExits(prev => {
          const n = [...prev];
          n[idx] = !entering;
          return n;
        });
      };
      const t = setTimeout(() => {
        tick(i);
        (t as TimerWithInner)._inner = setInterval(
          () => tick(i),
          CHAR_CYCLE_MS,
        );
      }, i * STAGGER_MS) as TimerWithInner;
      timers.push(t);
    }
    return () =>
      timers.forEach(t => {
        clearTimeout(t);
        clearInterval(t._inner);
      });
  }, [running, totalChars]);

  const onExitComplete = useCallback((_id: number) => {
    exitCount.current += 1;
  }, []);
  const [imgA, imgB] = images;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>scheduleOnRN-in-withTiming SIGABRT repro</Text>
      <Text style={styles.sub}>
        scene {scene} · exits {exitCount.current}
      </Text>
      <Text style={styles.hint}>{status}</Text>
      <Pressable style={styles.btn} onPress={() => setRunning(r => !r)}>
        <Text style={styles.btnText}>{running ? 'Stop' : 'Start'}</Text>
      </Pressable>
      {running ? (
        <CrossfadeLayer
          imageA={imgA}
          imageB={imgB}
          exitDuration={CROSSFADE_EXIT_DURATION_1}
          label={`Pattern 1 — exit ${CROSSFADE_EXIT_DURATION_1}ms`}
        />
      ) : null}
      {running ? (
        <CrossfadeLayer
          imageA={imgB}
          imageB={imgA}
          exitDuration={CROSSFADE_EXIT_DURATION_2}
          label={`Pattern 2 — exit ${CROSSFADE_EXIT_DURATION_2}ms`}
        />
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.grid}>
        {Array.from({ length: totalChars }).map((_, i) => (
          <CharacterUnit
            key={i}
            id={i}
            shouldExit={exits[i] ?? false}
            onExitComplete={onExitComplete}
            img={i % 2 === 0 ? imgA : imgB}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#16171A',
    paddingTop: 52,
    paddingHorizontal: 12,
  },
  title: { color: '#F5F5F6', fontSize: 12, fontWeight: '600', marginBottom: 2 },
  sub: { color: '#F5F5F6', fontSize: 12, marginBottom: 1 },
  hint: { color: '#6b7280', fontSize: 10, marginBottom: 6 },
  btn: {
    backgroundColor: '#3b82f6',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  crossfadeWrap: { marginBottom: 6 },
  label: { color: '#9ca3af', fontSize: 9, marginBottom: 2 },
  scroll: { flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, paddingBottom: 16 },
});

export default App;

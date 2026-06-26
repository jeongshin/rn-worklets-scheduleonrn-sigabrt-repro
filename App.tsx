/**
 * Minimal reproduction for reanimated 4.5.0 + react-native-svg crash on RN 0.86 Android.
 *
 * Pattern (extracted from a real app's episode-player screen):
 *  - An <Animated.View> with useAnimatedStyle (opacity + translateY) driven by withTiming.
 *  - Inside it: multiple <SvgXml> children from react-native-svg (icons + tooltip arrow).
 *  - Sibling: a Skia <Canvas> (gradient shadow) that releases its SurfaceTexture on unmount.
 *  - Rapid toggle that mounts/unmounts the whole subtree while withTiming is in flight.
 *
 * Repeatedly toggling produces the per-frame swallowed exception
 * `synchronouslyUpdateUIProps failed for tag <N>` (RetryableMountingLayerException:
 * Unable to find SurfaceMountingManager for tag) and after a few seconds the app
 * aborts in libworklets.so with `jsi.h:2014: assertion "isObject()" failed`.
 *
 * See https://github.com/software-mansion/react-native-reanimated/issues/9681
 * and PR https://github.com/software-mansion/react-native-reanimated/pull/9694
 * (the swallowed exception loop the present issue is filed against).
 */

import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {SvgXml} from 'react-native-svg';
import {Canvas, Rect} from '@shopify/react-native-skia';

const ICON_XML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
<g>
<path d="M10 2 L12 8 L18 8 L13 12 L15 18 L10 14 L5 18 L7 12 L2 8 L8 8 Z" fill="#F5F5F6"/>
</g>
</svg>`;

const POLYGON_XML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="14" viewBox="0 0 20 14" fill="none">
<path d="M8.37 0.93 C9.17 -0.31 10.83 -0.31 11.63 0.93 L20 14 H0 L8.37 0.93 Z" fill="#D9D9D9"/>
<path d="M8.37 0.93 C9.17 -0.31 10.83 -0.31 11.63 0.93 L20 14 H0 L8.37 0.93 Z" fill="#16171A"/>
</svg>`;

function ProblematicSubtree() {
  const animation = useSharedValue(0);

  useEffect(() => {
    animation.value = withTiming(1, {duration: 150});
  }, [animation]);

  const style = useAnimatedStyle(() => ({
    opacity: animation.value,
    transform: [{translateY: -(8 * (1 - animation.value))}],
  }));

  return (
    <Animated.View style={[styles.tooltip, style]}>
      <View style={styles.row}>
        <SvgXml xml={ICON_XML} width={16} height={16} />
        <Text style={styles.label}>music</Text>
      </View>
      <View style={styles.row}>
        <SvgXml xml={ICON_XML} width={16} height={16} />
        <Text style={styles.label}>audio</Text>
      </View>
      <View style={styles.row}>
        <SvgXml xml={ICON_XML} width={16} height={16} />
        <Text style={styles.label}>text</Text>
      </View>
      <View style={styles.polygon}>
        <SvgXml xml={POLYGON_XML} width={20} height={14} />
      </View>
      {/* Skia Canvas sibling — releases SurfaceTexture on unmount, matching the
          [SurfaceTexture] updateAndRelease message seen immediately before the
          crash loop begins. */}
      <View>
        <Canvas style={styles.canvas}>
          <Rect
            x={0}
            y={0}
            width={200}
            height={60}
            color="black"
            opacity={0.3}
          />
        </Canvas>
      </View>
    </Animated.View>
  );
}

function App() {
  const [visible, setVisible] = useState(false);
  const [autoToggleCount, setAutoToggleCount] = useState(0);
  const [autoToggle, setAutoToggle] = useState(false);

  // Auto-toggle every 200ms — guarantees we are always mounting/unmounting
  // while the previous withTiming(150ms) is in flight, creating the
  // mount/unmount race window.
  useEffect(() => {
    if (!autoToggle) {
      return;
    }
    const interval = setInterval(() => {
      setVisible(v => !v);
      setAutoToggleCount(c => c + 1);
    }, 200);
    return () => clearInterval(interval);
  }, [autoToggle]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        RN 0.86 + Reanimated 4.5.0 + react-native-svg crash repro
      </Text>

      <Pressable
        style={styles.button}
        onPress={() => setVisible(v => !v)}>
        <Text style={styles.buttonText}>
          Manual toggle (visible={String(visible)})
        </Text>
      </Pressable>

      <Pressable
        style={styles.button}
        onPress={() => setAutoToggle(a => !a)}>
        <Text style={styles.buttonText}>
          Auto toggle 200ms (running={String(autoToggle)}, count=
          {autoToggleCount})
        </Text>
      </Pressable>

      <Text style={styles.hint}>
        Tap "Auto toggle" to start the race. Within a few seconds on Android you
        should see per-frame "synchronouslyUpdateUIProps failed for tag"
        warnings in logcat, then SIGABRT with jsi.h "isObject()" assertion in
        libworklets.so.
      </Text>

      <View style={styles.slot}>{visible ? <ProblematicSubtree /> : null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#16171A',
    paddingTop: 80,
    paddingHorizontal: 20,
  },
  title: {
    color: '#F5F5F6',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    color: '#9ca3af',
    fontSize: 12,
    marginTop: 8,
    marginBottom: 20,
  },
  slot: {
    minHeight: 200,
  },
  tooltip: {
    width: 260,
    backgroundColor: '#0B0B0D',
    borderRadius: 12,
    padding: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  label: {
    color: '#F5F5F6',
    fontSize: 14,
  },
  polygon: {
    position: 'absolute',
    right: 18,
    top: -13,
  },
  canvas: {
    width: 200,
    height: 60,
    marginTop: 8,
  },
});

export default App;

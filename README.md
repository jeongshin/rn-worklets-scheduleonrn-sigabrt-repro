# react-native-reanimated SVG crash reproduction (RN 0.86)

Minimal reproduction of a Reanimated 4.5.0 + react-native-svg crash on Android
under React Native 0.86.0 with the New Architecture.

## TL;DR

Repeatedly mounting and unmounting an `<Animated.View>` subtree that contains
multiple `react-native-svg` children (and a sibling `@shopify/react-native-skia`
`<Canvas>`) while a `withTiming` animation is in flight produces:

1. **Per-frame log spam (Symptom A):**

   ```
   W/Reanimated: synchronouslyUpdateUIProps failed for tag <N>
   java.lang.reflect.InvocationTargetException
     ... NativeProxy.synchronouslyUpdateUIProps(NativeProxy.kt:253)
     ... NodesManager.onEventDispatch(NodesManager.kt:212)
     ... FabricEventDispatcher.dispatchEvent
     ... com.horcrux.svg.VirtualView.setClientRect(VirtualView.java:614)
     ... com.horcrux.svg.SvgView.onDraw(SvgView.java:135)
   Caused by: com.facebook.react.bridge.RetryableMountingLayerException:
     Unable to find SurfaceMountingManager for tag: [N]
     ... MountingManager.updatePropsSynchronously(MountingManager.kt:278)
   ```

   The same handful of SVG view tags loop-fail many times per frame.

2. **Eventual SIGABRT (Symptom B):**

   ```
   Abort message: jsi.h:2014: Object facebook::jsi::Value::getObject(IRuntime &) &&:
     assertion "isObject()" failed

   backtrace:
     #02 libworklets.so (facebook::jsi::Value::getObject+120)
     #03–#09 libworklets.so
     #17 libreactnative.so CallInvoker::invokeAsync(...)
     #31 react::Task::execute
     #32 RuntimeScheduler_Modern::executeTask
   ```

PR [#9694](https://github.com/software-mansion/react-native-reanimated/pull/9694)
(shipped in 4.5.0) wraps `MountingManager.updatePropsSynchronously` in a
`try/catch` that swallows the per-frame failure. The catch hides the warning
but does nothing to stop the upstream `svg.setClientRect → onEventDispatch`
from being driven against tags whose surface is gone, and the spam appears to
corrupt the worklets JSI value that later flows into `getObject()`.

## Versions used

| Package | Version |
|---|---|
| `react-native` | 0.86.0 |
| `react` | 19.2.3 |
| `react-native-reanimated` | 4.5.0 |
| `react-native-worklets` | 0.10.0 |
| `react-native-svg` | 15.15.5 |
| `@shopify/react-native-skia` | 2.6.6 |

New Architecture (Fabric) enabled — the RN 0.86 default.

## Steps to reproduce

```bash
# from this directory
npm install
cd android && ./gradlew clean && cd ..  # optional but recommended after fresh clone
npx react-native start --reset-cache &
npx react-native run-android
```

1. Tap **Auto toggle 200ms** in the app. This mounts/unmounts the SVG-heavy
   `<Animated.View>` subtree every 200 ms while a 150 ms `withTiming` is still
   in flight.
2. Within a few seconds you should see per-frame
   `W/Reanimated: synchronouslyUpdateUIProps failed for tag <N>` warnings in
   `adb logcat`.
3. Within roughly 5–30 seconds the app should abort with the
   `jsi.h:2014 isObject()` assertion in `libworklets.so`.

To capture a logcat for an issue:

```bash
adb logcat -c
adb logcat > crash.logcat
# now reproduce in the app, then Ctrl-C the logcat
```

## Related upstream

- Issue [#9681 — Reanimated animations freeze after first touch/tap (RN 0.86)](https://github.com/software-mansion/react-native-reanimated/issues/9681)
- PR [#9694](https://github.com/software-mansion/react-native-reanimated/pull/9694)
  shipped in 4.5.0 — adds a `try/catch` around the reflective
  `updatePropsSynchronously` call. The current repro shows that the swallowed
  exception loop produced by that catch still crashes the app via worklets'
  JSI `getObject()` assertion.
- Issue [#9636](https://github.com/software-mansion/react-native-reanimated/issues/9636)
  / PR [#9649](https://github.com/software-mansion/react-native-reanimated/pull/9649)
  — guarded the sibling `preserveMountedTags` path, but `synchronouslyUpdateUIProps`
  was not given the same surface check.

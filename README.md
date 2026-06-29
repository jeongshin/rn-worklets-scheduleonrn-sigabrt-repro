# `scheduleOnRN` inside `withTiming` callback — SIGABRT on Android (Reanimated 4.5.0 / Worklets 0.10.0)

Minimal reproduction of a use-after-free crash in `libworklets.so` when
`scheduleOnRN` is called from inside a `withTiming` completion callback under
concurrent Skia animation load.

## TL;DR

```ts
opacity.value = withTiming(0, { duration: 700 }, (finished) => {
  'worklet';
  if (finished) {
    scheduleOnRN(fn, arg);  // ← SIGABRT: Value::getObject assertion "isObject()" failed
  }
});
```

When multiple concurrent Skia Canvas animations are running and `mqt_v_js` is
under load, `Value::getObject` is called on a freed JSI value inside
`CallInvoker::invokeAsync` → SIGABRT on `mqt_v_js`.

## Backtrace (Android emulator, arm64, Android 16)

```
pid: 8116, tid: 8155, name: mqt_v_js  >>> com.reanimatedsvgcrashrepro <<<

Abort message: '/…/jsi/jsi.h:2014: Object facebook::jsi::Value::getObject(IRuntime &) &&:
               assertion "isObject()" failed'

backtrace:
  #00 libc.so (abort+156)
  #01 libc.so (__assert2+36)
  #02 libworklets.so (facebook::jsi::Value::getObject(facebook::jsi::IRuntime&) &&+120)
  #03 libworklets.so
  #04 libworklets.so
  #05 libworklets.so
  #06 libworklets.so
  #07 libworklets.so
  #08 libworklets.so
  #09 libworklets.so
  #10 libworklets.so
  #11 libworklets.so
  #12 libworklets.so
  #13 libworklets.so
  #14 libworklets.so
  #15 libreactnative.so
  #16 libreactnative.so
  #17 libreactnative.so (facebook::react::CallInvoker::invokeAsync(std::function<void ()>&&)::'lambda'(jsi::Runtime&)::operator()(jsi::Runtime&) const+24)
  #18 libreactnative.so
  #19 libreactnative.so
  #20 libreactnative.so
  #21 libreactnative.so
  #22 libreactnative.so
  #23 libreactnative.so
  …
  #31 libreactnative.so (facebook::react::Task::execute(jsi::Runtime&, bool)+412)
  #32 libreactnative.so (facebook::react::RuntimeScheduler_Modern::executeTask(jsi::Runtime&, Task&, bool) const+116)
  #33 libreactnative.so (facebook::react::RuntimeScheduler_Modern::runEventLoopTick(jsi::Runtime&, Task&)+204)
  #34 libreactnative.so (facebook::react::RuntimeScheduler_Modern::runEventLoop(jsi::Runtime&)+140)
  …
  #54 libfbjni.so (facebook::jni::MethodWrapper<…JNativeRunnable::run()…>::dispatch+72)
  #55 libfbjni.so (MethodWrapper dispatch)
  #57 JIT — android.os.Handler.handleCallback
  #58 JIT — android.os.Handler.dispatchMessage
  …
  #67 JIT — android.os.Looper.loopOnce
  #68 JIT — android.os.Looper.loop
```

The crash occurs exclusively in the `mqt_v_js` thread inside the
`invokeAsync` lambda posted by `scheduleOnRN`.

## Root cause analysis

`scheduleOnRN(fn, arg)` (called from a UI-thread worklet) posts a
`JNativeRunnable` job to `mqt_v_js` that holds a JSI `Value` referencing `fn`.
After the `withTiming` callback returns on the UI thread, the Reanimated
animation engine frees the completion worklet's closure. The closure owns the
JSI reference to `fn`. When the queued job finally executes on `mqt_v_js`,
`Value::getObject()` is called on the freed reference → assertion failure →
SIGABRT.

This is a race between:

- **Thread A** (UI thread): `withTiming` fires callback → `scheduleOnRN` posts
  job → callback returns → worklet closure freed (JSI ref for `fn` freed).
- **Thread B** (`mqt_v_js`): job dequeued → `getObject()` on freed `fn` → crash.

The crash requires `mqt_v_js` to be under enough load that the job sits in the
queue after the worklet closure is freed. With multiple concurrent Skia Canvas
animations this load is easily reached.

## The buggy pattern

All three concurrent patterns in the repro share the same structure:

```ts
// Pattern 1 — crossfade slot A/B, exitDuration 700 ms
alphaB.value = withTiming(0, { duration: 700 }, (finished) => {
  'worklet';
  if (finished) scheduleOnRN(setSlotB, null);  // ← UAF
});

// Pattern 2 — crossfade slot A/B, exitDuration 600 ms
alphaA.value = withTiming(0, { duration: 600 }, (finished) => {
  'worklet';
  if (finished) scheduleOnRN(setSlotA, null);  // ← UAF
});

// Pattern 3 — 20 independent character units, exitDuration 700 ms
opacity.value = withTiming(0, { duration: 700 }, (finished) => {
  'worklet';
  if (finished) scheduleOnRN(onExitComplete, id);  // ← UAF
});
```

## Fix applied in production

Replace `scheduleOnRN` inside `withTiming` with a JS-thread `setTimeout`.
`setTimeout`'s closure lives on the Hermes heap (a proper GC root) and is not
subject to worklet-closure lifetime:

```ts
opacity.value = withTiming(0, { duration: DURATION });
const timer = setTimeout(() => onExitComplete(name), DURATION);
// cleanup: clearTimeout(timer) if component unmounts before timer fires
```

## Versions

| Package | Version |
|---|---|
| `react-native` | 0.86.0 |
| `react` | 19.2.3 |
| `react-native-reanimated` | 4.5.0 |
| `react-native-worklets` | 0.10.0 |
| `@shopify/react-native-skia` | 2.6.6 |
| Target: Android 16, arm64 (emulator + Samsung Galaxy S24) |

New Architecture (Fabric) enabled.

## Steps to reproduce

```bash
# from this directory
npm install
npx react-native start --reset-cache &
npx react-native run-android
```

1. Wait for the app to load — you should see 20 character images and a **Start** button.
2. Tap **Start**.
3. Three patterns run concurrently:
   - **Pattern 1**: slot-A/B crossfade (exitingDuration=700 ms, URL cycles every 1000 ms).
   - **Pattern 2**: slot-A/B crossfade (exitingDuration=600 ms, URL cycles every 1000 ms).
   - **Pattern 3**: 20 independent character units, each fading out for 700 ms every 800 ms (staggered).
4. The app crashes with the SIGABRT above within ~60 seconds on a stock Android emulator (Medium Phone API 36).

```bash
adb logcat -b crash > crash.logcat
```

## Confirmed environments

| Environment | Crash time |
|---|---|
| Android emulator (sdk_gphone64_arm64, Android 16, API 36) | ~60 s |
| Samsung Galaxy S24 (SM-S921N, Android 16) | ~5 s (4–5 taps equivalent) |

// Shake the phone to capture the screen on show for agents (captureScreen.ts).
// The accelerometer is read natively through expo-sensors; a shake is a few
// hard jolts in a short window, so a bump or a step does not count.

import React from 'react';
import { Accelerometer } from 'expo-sensors';
import { ToastAndroid } from 'react-native';
import { captureScreenForAgents } from './captureScreen';
import { useUiStore } from '../stores/uiStore';

const INTERVAL_MS = 100;
/** Acceleration (g) beyond which one sample is a jolt. */
const JOLT_G = 2.2;
const JOLTS_NEEDED = 3;
const WINDOW_MS = 800;
/** After a capture, ignore further shakes for this long. */
const COOLDOWN_MS = 3000;

/** Feed samples in; returns true on the sample that completes a shake. */
export function makeShakeDetector(): (x: number, y: number, z: number, now: number) => boolean {
  let jolts: number[] = [];
  let quietUntil = 0;
  return (x, y, z, now) => {
    if (now < quietUntil) return false;
    if (Math.sqrt(x * x + y * y + z * z) < JOLT_G) return false;
    jolts = jolts.filter((t) => now - t <= WINDOW_MS);
    jolts.push(now);
    if (jolts.length < JOLTS_NEEDED) return false;
    jolts = [];
    quietUntil = now + COOLDOWN_MS;
    return true;
  };
}

export function useShakeToCapture(route: string): void {
  const routeRef = React.useRef(route);
  routeRef.current = route;
  React.useEffect(() => {
    const detect = makeShakeDetector();
    Accelerometer.setUpdateInterval(INTERVAL_MS);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      if (!detect(x, y, z, Date.now())) return;
      captureScreenForAgents(routeRef.current)
        .then(() => ToastAndroid.show('Screen captured for agents', ToastAndroid.SHORT))
        .catch((err: unknown) =>
          useUiStore
            .getState()
            .pushError(`Could not capture this screen: ${(err as Error).message}`),
        );
    });
    return () => sub.remove();
  }, []);
}

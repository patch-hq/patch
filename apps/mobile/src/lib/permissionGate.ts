// Ask-when-needed permissions (spec/15 § Permissions on first use).
//
// A permission is requested at the moment a feature needs it, never at
// install. Before the OS dialog, an explainer modal says why. If the
// permission is already granted nothing is shown. If the user says "Not now"
// the caller gets false and must surface the feature as unavailable (NO
// FALLBACK — the feature reports why, it does not silently no-op).

import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import { Camera } from 'expo-camera';
import { create } from 'zustand';

export type PermissionKind = 'microphone' | 'camera' | 'notifications';

export const PERMISSION_EXPLAINERS: Record<PermissionKind, { title: string; body: string }> = {
  microphone: {
    title: 'Microphone access',
    body: 'Patch needs the microphone to record voice notes, dictate messages and take voice calls.',
  },
  camera: {
    title: 'Camera access',
    body: 'Patch needs the camera to take a photo to attach to a message, or to scan a pairing QR code.',
  },
  notifications: {
    title: 'Notifications',
    body: 'Patch sends a notification when a chat needs you or has finished, so you can leave it running.',
  },
};

interface PendingExplainer {
  kind: PermissionKind;
  resolve: (proceed: boolean) => void;
}

interface GateState {
  pending: PendingExplainer | null;
}

/** The explainer currently on screen; `PermissionExplainerModal` renders it. */
export const usePermissionGate = create<GateState>(() => ({ pending: null }));

async function isGranted(kind: PermissionKind): Promise<boolean> {
  switch (kind) {
    case 'microphone':
      return (await Audio.getPermissionsAsync()).granted;
    case 'camera':
      return (await Camera.getCameraPermissionsAsync()).granted;
    case 'notifications':
      return (await Notifications.getPermissionsAsync()).granted;
  }
}

async function requestOs(kind: PermissionKind): Promise<boolean> {
  switch (kind) {
    case 'microphone':
      return (await Audio.requestPermissionsAsync()).granted;
    case 'camera':
      return (await Camera.requestCameraPermissionsAsync()).granted;
    case 'notifications':
      return (await Notifications.requestPermissionsAsync()).granted;
  }
}

/** Called by the modal's buttons. */
export function answerExplainer(proceed: boolean): void {
  const p = usePermissionGate.getState().pending;
  if (!p) return;
  usePermissionGate.setState({ pending: null });
  p.resolve(proceed);
}

/**
 * Resolve true when the permission is held (asking first if it is not).
 * Concurrent callers for the same kind share one explainer + one OS dialog.
 */
const inFlight = new Map<PermissionKind, Promise<boolean>>();
export function ensurePermission(kind: PermissionKind): Promise<boolean> {
  const existing = inFlight.get(kind);
  if (existing) return existing;
  const run = (async (): Promise<boolean> => {
    if (await isGranted(kind)) return true;
    const proceed = await new Promise<boolean>((resolve) => {
      usePermissionGate.setState({ pending: { kind, resolve } });
    });
    if (!proceed) return false;
    return requestOs(kind);
  })().finally(() => inFlight.delete(kind));
  inFlight.set(kind, run);
  return run;
}

// Test helper: make a permission "not yet granted" so the gate must ask, and
// answer the explainer modal with Continue so the OS request spy is reached.
import { Audio } from 'expo-av';
import { afterEach, vi } from 'vitest';
import { usePermissionGate, answerExplainer } from '../../src/lib/permissionGate';

let unsub: (() => void) | null = null;

export function micNeedsPrompt(): void {
  vi.spyOn(Audio, 'getPermissionsAsync').mockResolvedValue({ granted: false } as never);
  unsub?.();
  unsub = usePermissionGate.subscribe((s) => {
    if (s.pending) queueMicrotask(() => answerExplainer(true));
  });
}

afterEach(() => {
  unsub?.();
  unsub = null;
  vi.mocked(Audio.getPermissionsAsync).mockRestore?.();
});

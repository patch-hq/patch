// Zen mode — one chat, full screen, nothing else on screen. The mode is the
// `zenMode` flag in uiStore; this hook keeps the real window in step with it:
// entering asks the browser (or the Electron shell) for fullscreen, and leaving
// fullscreen by any route — Esc, the OS, the window controls — leaves zen too,
// so the two can never disagree. A refused fullscreen request is reported, not
// swallowed (no fallback).

import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore.js';

export function useZenMode(): boolean {
  const zen = useUiStore((s) => s.zenMode);

  useEffect(() => {
    if (zen) {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch((err: unknown) => {
          useUiStore.getState().setZenMode(false);
          useUiStore
            .getState()
            .pushError(`Zen mode could not go full screen: ${(err as Error).message}`);
        });
      }
    } else if (document.fullscreenElement) {
      void document.exitFullscreen();
    }
  }, [zen]);

  useEffect(() => {
    const onChange = (): void => {
      if (!document.fullscreenElement) useUiStore.getState().setZenMode(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  return zen;
}

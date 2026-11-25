import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/captureScreen', () => ({ captureScreenForAgents: vi.fn() }));
vi.mock('../src/stores/uiStore', () => ({ useUiStore: {} }));
import { makeShakeDetector } from '../src/lib/shakeToCapture';

describe('shake detector', () => {
  it('fires on three hard jolts inside the window', () => {
    const d = makeShakeDetector();
    expect(d(3, 0, 0, 0)).toBe(false);
    expect(d(-3, 0, 0, 200)).toBe(false);
    expect(d(3, 0, 0, 400)).toBe(true);
  });
  it('ignores gentle movement and slow, spread-out jolts', () => {
    const d = makeShakeDetector();
    expect(d(0.5, 0.5, 1, 0)).toBe(false);
    expect(d(3, 0, 0, 0)).toBe(false);
    expect(d(3, 0, 0, 1000)).toBe(false);
    expect(d(3, 0, 0, 2000)).toBe(false);
  });
  it('is quiet for a while after a shake', () => {
    const d = makeShakeDetector();
    d(3, 0, 0, 0);
    d(3, 0, 0, 100);
    expect(d(3, 0, 0, 200)).toBe(true);
    expect(d(3, 0, 0, 300)).toBe(false);
    expect(d(3, 0, 0, 400)).toBe(false);
    expect(d(3, 0, 0, 500)).toBe(false);
  });
});

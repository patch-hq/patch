import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { actSync, renderRN, update } from './testUtils/render';

let focus: (() => void | (() => void)) | null = null;
vi.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    focus = cb;
  },
}));

import { useFrozenWhenBlurred } from '../src/lib/useFrozenWhenBlurred';

let seen: number[] = [];
function Probe({ value }: { value: number }): null {
  seen.push(useFrozenWhenBlurred(value));
  return null;
}

describe('useFrozenWhenBlurred', () => {
  it('follows the value while focused and holds the last one once blurred', () => {
    seen = [];
    const r = renderRN(<Probe value={1} />);
    let blur: void | (() => void);
    actSync(() => {
      blur = focus!();
    });
    update(r, <Probe value={2} />);
    expect(seen.at(-1)).toBe(2);
    actSync(() => {
      (blur as () => void)();
    });
    update(r, <Probe value={3} />);
    expect(seen.at(-1)).toBe(2);
    actSync(() => {
      focus!();
    });
    expect(seen.at(-1)).toBe(3);
  });
});

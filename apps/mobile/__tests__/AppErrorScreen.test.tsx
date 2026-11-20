// The root error screen: a throwing bundle shows text, versions and a retry
// instead of a white screen.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { byTestId, findHost, renderRN, textOf } from './testUtils/render';

const { recordCrash } = vi.hoisted(() => ({ recordCrash: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/crashReport', async (orig) => ({
  ...(await orig<typeof import('../src/lib/crashReport')>()),
  recordCrash,
}));

import { AppErrorScreen } from '../src/components/AppErrorScreen';

describe('AppErrorScreen', () => {
  it('shows the error and versions, and records the crash', () => {
    const retry = vi.fn();
    const r = renderRN(<AppErrorScreen error={new Error('native module missing')} retry={retry} />);
    expect(textOf(findHost(r.root, byTestId('app-error-message')))).toBe('native module missing');
    expect(textOf(findHost(r.root, byTestId('app-error-versions')))).toContain('Runtime');
    expect(recordCrash).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'native module missing' }),
    );
  });
});

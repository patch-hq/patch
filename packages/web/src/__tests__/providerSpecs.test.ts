// Settings and the welcome step walk one list of providers (decision 16): each
// entry's accounts and strategy come from the wire table, so nothing on those
// pages picks a provider out by name.

import { describe, it, expect } from 'vitest';
import { ACCOUNT_PROVIDERS } from '@patch/wire';
import { PROVIDERS } from '../routes/settings/providers.js';

describe('Settings provider entries', () => {
  it('there is one for every provider with accounts, in the table’s order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(ACCOUNT_PROVIDERS.map((p) => p.backendId));
  });

  it('each reads its accounts and strategy from its accountsKey', () => {
    const secrets = Object.fromEntries(
      ACCOUNT_PROVIDERS.map((p) => [
        p.accountsKey,
        [{ id: p.accountsKey, label: 'x', connected: true }],
      ]),
    ) as never;
    for (const [i, p] of PROVIDERS.entries()) {
      const key = ACCOUNT_PROVIDERS[i]!.accountsKey;
      expect(p.strategyKey).toBe(key);
      expect(p.rows(secrets).map((r) => r.id)).toEqual([key]);
      expect(p.rows({} as never)).toEqual([]);
    }
  });

  it('each says how an account signs in and draws its own welcome card', () => {
    const testIds = PROVIDERS.map((p) => p.welcome.testId);
    expect(new Set(testIds).size).toBe(testIds.length);
    for (const p of PROVIDERS) {
      expect(p.signInDetail).not.toBe('');
      expect(typeof p.SignIn).toBe('function');
      expect(typeof p.welcome.Controls).toBe('function');
    }
  });
});

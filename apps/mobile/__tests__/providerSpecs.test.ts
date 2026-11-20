// Settings → Usage walks one list of providers (decision 16): each entry's
// accounts and strategy come from the wire table, never a provider's name.

import { describe, it, expect } from 'vitest';
import { ACCOUNT_PROVIDERS } from '@patch/wire';
import { PROVIDERS } from '../src/components/settings/providers';

describe('mobile provider entries', () => {
  it('there is one for every provider with accounts, in the table’s order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(ACCOUNT_PROVIDERS.map((p) => p.backendId));
  });

  it('each reads its accounts and strategy from its accountsKey, and has its own sign-in', () => {
    const secrets = Object.fromEntries(
      ACCOUNT_PROVIDERS.map((p) => [p.accountsKey, [{ id: p.accountsKey, connected: true }]]),
    ) as never;
    for (const [i, p] of PROVIDERS.entries()) {
      const key = ACCOUNT_PROVIDERS[i]!.accountsKey;
      expect(p.strategyKey).toBe(key);
      expect(p.rows(secrets).map((r) => r.id)).toEqual([key]);
      expect(typeof p.SignInFlow).toBe('function');
      expect(p.signInDetail).not.toBe('');
    }
  });
});

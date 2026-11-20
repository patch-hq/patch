import { describe, it, expect } from 'vitest';
import { lockableAccounts } from '../src/index.js';

const secrets = {
  claude: [{ id: 'c1', label: 'Claude', connected: true }],
  codex: [{ id: 'x1', label: 'ChatGPT', kind: 'chatgpt' as const, connected: false }],
  acp: [
    {
      id: 'g1',
      agentId: 'gemini',
      label: 'Work',
      last4: '1111',
      state: { state: 'limited' as const },
    },
    { id: 'o1', agentId: 'other', label: 'Other' },
  ],
};

describe('lockableAccounts (spec/10 § Choosing an account)', () => {
  it('is the provider’s list for Claude and Codex models', () => {
    expect(lockableAccounts(secrets, 'claude-sonnet-5').map((a) => a.id)).toEqual(['c1']);
    expect(lockableAccounts(secrets, 'openai/gpt-5').map((a) => a.id)).toEqual(['x1']);
  });

  it('is the agent’s own accounts for an ACP model, each connected with its state', () => {
    expect(lockableAccounts(secrets, 'acp/gemini/auto')).toEqual([
      { id: 'g1', label: 'Work', connected: true, kind: 'apiKey', state: { state: 'limited' } },
    ]);
    expect(lockableAccounts(secrets, 'acp/none/auto')).toEqual([]);
    expect(lockableAccounts(undefined, 'acp/gemini/auto')).toEqual([]);
  });
});

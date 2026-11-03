import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { makeBranchSendBackSummarizer } from '../src/branchSendBackGen.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const withToken: RunOnAccountWithCredit = (_label, run) => run('tok');
const input = {
  chatId: 'c',
  branchId: 'b',
  folder: '/tmp',
  firstMessage: 'Check the build',
  lastAssistantText: 'Build is green.',
};

describe('makeBranchSendBackSummarizer', () => {
  it('runs on the set model', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'Build is green' }]);
    const gen = makeBranchSendBackSummarizer({
      sdkBackend: sdk,
      runOnAccountWithCredit: withToken,
      smallJobModels: ['set-model', 'failover-model'],
      logger: pino({ level: 'silent' }),
    });
    expect(await gen(input)).toBe('Build is green');
    expect(sdk.lastOptions()?.model).toBe('set-model');
  });

  it('fails over to the next small-job model when the set model errors', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'error', errorMessage: 'model not found' }]);
    sdk.enqueue([{ type: 'assistant', content: 'Build is green' }]);
    const gen = makeBranchSendBackSummarizer({
      sdkBackend: sdk,
      runOnAccountWithCredit: withToken,
      smallJobModels: ['set-model', 'failover-model'],
      logger: pino({ level: 'silent' }),
    });
    expect(await gen(input)).toBe('Build is green');
    expect(sdk.lastOptions()?.model).toBe('failover-model');
  });
});

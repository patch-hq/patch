import { describe, expect, it } from 'vitest';
import { modelSpentReason } from '../lib/credit.js';
import type { AccountUsageRow } from '../components/UsagePopover.js';

const NOW = Date.UTC(2026, 10, 21, 12, 0);
const row = (usage: AccountUsageRow['usage']): AccountUsageRow => ({
  key: 'codex:a',
  providerId: 'codex',
  accountId: 'a',
  label: 'me',
  backend: 'ChatGPT',
  title: 'ChatGPT me',
  usage,
});

describe('modelSpentReason', () => {
  it('is null while the provider has credit', () => {
    expect(
      modelSpentReason(
        'openai/gpt-5',
        [row({ week: { status: 'allowed', utilization: 0.2 } })],
        new Set(),
        NOW,
      ),
    ).toBeNull();
  });

  it('names the provider and the date its limit lifts', () => {
    const resetsAt = Date.UTC(2026, 11, 17, 10, 16);
    const reason = modelSpentReason(
      'openai/gpt-5',
      [row({ week: { status: 'rejected', resetsAt } })],
      new Set(),
      NOW,
    );
    expect(reason).toMatch(/^ChatGPT limit reached until 17 Dec \d{2}:\d{2}$/);
  });

  it('claims no date when the reset is unknown', () => {
    expect(
      modelSpentReason('openai/gpt-5', [row({ week: { status: 'rejected' } })], new Set(), NOW),
    ).toBe('ChatGPT limit reached');
  });

  it('is null when usage is not known yet', () => {
    expect(modelSpentReason('openai/gpt-5', [row(undefined)], new Set(), NOW)).toBeNull();
  });
});

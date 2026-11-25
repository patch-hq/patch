import { describe, expect, it } from 'vitest';
import { toolCallSummary } from '../lib/toolSummary.js';

describe('patch_send_to summary', () => {
  it('names the target chat', () => {
    expect(toolCallSummary('mcp__patch__patch_send_to', { chatId: 'c1' }, () => 'Deploys')).toBe(
      'Sent to Deploys',
    );
  });
  it('says another chat when the name is unknown', () => {
    expect(toolCallSummary('mcp__patch__patch_send_to', { chatId: 'c1' }, () => undefined)).toBe(
      'Sent to another chat',
    );
  });
});

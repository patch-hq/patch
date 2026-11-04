import { describe, expect, it } from 'vitest';
import { pickAvailableModel, backendUsable } from '../src/availableModel.js';

const NOW = 1_000_000;
const spent = { session: { status: 'rejected' as const, resetsAt: NOW + 5000 } };
const ok = { connected: true };
const report = (m: Record<string, { accounts?: never[] } | unknown>) => (b: string) =>
  m[b] as never;

describe('pickAvailableModel', () => {
  const catalogue = ['claude-opus-5', 'openai/gpt-5'];
  it('keeps the preferred model when its provider can run', () => {
    expect(
      pickAvailableModel({
        preferred: 'claude-opus-5',
        catalogue,
        now: NOW,
        reportFor: report({ 'claude-code': { accounts: [ok] } }),
      }),
    ).toBe('claude-opus-5');
  });
  it('moves to the next model whose account is not out of usage', () => {
    expect(
      pickAvailableModel({
        preferred: 'claude-opus-5',
        catalogue,
        now: NOW,
        reportFor: report({
          'claude-code': { accounts: [{ connected: true, usage: spent }] },
          codex: { accounts: [ok] },
        }),
      }),
    ).toBe('openai/gpt-5');
  });
  it('skips a signed-out provider', () => {
    expect(
      pickAvailableModel({
        preferred: 'claude-opus-5',
        catalogue,
        now: NOW,
        reportFor: report({
          'claude-code': { accounts: [{ connected: false }] },
          codex: { accounts: [ok] },
        }),
      }),
    ).toBe('openai/gpt-5');
  });
  it('keeps the preferred model when every provider is out', () => {
    const out = { accounts: [{ connected: true, usage: spent }] };
    expect(
      pickAvailableModel({
        preferred: 'claude-opus-5',
        catalogue,
        now: NOW,
        reportFor: report({ 'claude-code': out, codex: out }),
      }),
    ).toBe('claude-opus-5');
  });
  it('is usable when nothing has been reported, and when one account is still in credit', () => {
    expect(backendUsable(undefined, NOW)).toBe(true);
    expect(backendUsable({}, NOW)).toBe(true);
    expect(backendUsable({ accounts: [{ connected: true, usage: spent }, ok] }, NOW)).toBe(true);
  });
  it('an api key never runs dry', () => {
    expect(
      backendUsable({ accounts: [{ connected: true, kind: 'apiKey', usage: spent }] }, NOW),
    ).toBe(true);
  });
});

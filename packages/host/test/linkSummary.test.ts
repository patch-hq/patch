// spec/14 § Message links — the Summarise button's host half: the one-shot
// summariser and the request handler that answers `patch.link_summary.response`.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { makeLinkSummariser, LINK_SUMMARY_MODEL } from '../src/linkSummary.js';
import { handleLinkSummaryRequest } from '../src/index.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const input = {
  requestId: 'r1',
  prompt: 'Summarise tersely.',
  url: 'https://example.com/a',
  text: 'The page body.',
  folder: '/home/patch',
};
const withToken: RunOnAccountWithCredit = async (_l, run) => await run('tok');
const noAccount: RunOnAccountWithCredit = async () => null;

describe('makeLinkSummariser', () => {
  it('runs Haiku with the custom prompt, url and page text, and returns the reply', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '  A summary. ' },
      { type: 'result', sessionId: 's' },
    ]);
    const out = await makeLinkSummariser({ sdkBackend: sdk, runOnAccountWithCredit: withToken })(
      input,
    );
    expect(out).toBe('A summary.');
    const o = sdk.lastOptions();
    expect(o?.model).toBe(LINK_SUMMARY_MODEL);
    expect(o?.prompt).toContain('Summarise tersely.');
    expect(o?.prompt).toContain('https://example.com/a');
    expect(o?.prompt).toContain('The page body.');
  });

  it('rejects on an SDK error rather than returning an empty summary', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'error', errorMessage: 'overloaded' }]);
    await expect(
      makeLinkSummariser({ sdkBackend: sdk, runOnAccountWithCredit: withToken })(input),
    ).rejects.toThrow('overloaded');
  });

  it('resolves null for an empty reply', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'result', sessionId: 's' }]);
    expect(
      await makeLinkSummariser({ sdkBackend: sdk, runOnAccountWithCredit: withToken })(input),
    ).toBeNull();
  });

  it('resolves null when no account can answer', async () => {
    expect(
      await makeLinkSummariser({
        sdkBackend: createMockSdkBackend(),
        runOnAccountWithCredit: noAccount,
      })(input),
    ).toBeNull();
  });
});

describe('handleLinkSummaryRequest', () => {
  const event = {
    type: 'patch.link_summary.request' as const,
    requestId: 'r1',
    hostId: 'host-a',
    prompt: 'p',
    url: 'https://example.com/a',
    text: 't',
  };

  it('answers ok with the summary', async () => {
    const sender = vi.fn();
    await handleLinkSummaryRequest(event, async () => 'S', sender, silent, 'host-a', '/h');
    expect(sender).toHaveBeenCalledWith({
      type: 'patch.link_summary.response',
      requestId: 'r1',
      hostId: 'host-a',
      ok: true,
      summary: 'S',
    });
  });

  it('answers ok:false when nothing was produced', async () => {
    const sender = vi.fn();
    await handleLinkSummaryRequest(event, async () => null, sender, silent, 'host-a', '/h');
    expect(sender.mock.calls[0]![0]).toMatchObject({ ok: false });
  });

  it('answers ok:false with the error message on a throw', async () => {
    const sender = vi.fn();
    await handleLinkSummaryRequest(
      event,
      async () => {
        throw new Error('boom');
      },
      sender,
      silent,
      'host-a',
      '/h',
    );
    expect(sender.mock.calls[0]![0]).toMatchObject({ ok: false, error: 'boom' });
  });
});

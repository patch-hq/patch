import { describe, it, expect } from 'vitest';
import { classifyFailure, backoffMs } from '../src/errorClass.js';

describe('classifyFailure', () => {
  it.each([
    ['API Error: 400 {"type":"invalid_request_error"}', 'permanent'],
    ['API Error: 401 authentication_error', 'permanent'],
    ['API Error: 403 permission_error', 'permanent'],
    ['API Error: 404 not_found_error: model: x', 'permanent'],
    ['Prompt is too long', 'permanent'],
    ['429 You exceeded your current quota (insufficient_quota)', 'permanent'],
    ['Your credit balance is too low to access the Anthropic API', 'permanent'],
    ['API Error: 413 request_too_large', 'permanent'],
    ["ENOENT: no such file or directory, open '/x'", 'permanent'],
    ['API Error: 529 overloaded_error', 'transient'],
    ['API Error: 429 rate_limit_error', 'transient'],
    ['API Error: 500 api_error', 'transient'],
    ['[session_crash] error_name=AbortError api_error_status=none cause_name=none', 'transient'],
    ['API Error: 502 bad gateway', 'transient'],
    ['API Error: 408 request timeout', 'transient'],
    ['read ECONNRESET', 'transient'],
    ['getaddrinfo EAI_AGAIN api.anthropic.com', 'transient'],
    ['fetch failed', 'transient'],
    ['socket hang up', 'transient'],
    ['Claude Code process exited with code 143', 'transient'],
    ['Claude Code process exited with code 137', 'permanent'],
    ['Claude Code process terminated by signal SIGKILL', 'permanent'],
  ])('%s → %s', (msg, kind) => {
    expect(classifyFailure(msg).kind).toBe(kind);
    expect(classifyFailure(msg).reason).not.toBe('unclassified');
  });

  it('names an unrecognised failure as unclassified, and retries it', () => {
    expect(classifyFailure('something odd')).toEqual({ kind: 'transient', reason: 'unclassified' });
  });
});

describe('backoffMs', () => {
  it('doubles and caps', () => {
    expect([1, 2, 3, 10].map((a) => backoffMs(a, 5_000, 60_000))).toEqual([
      5_000, 10_000, 20_000, 60_000,
    ]);
  });
});

describe('out of credit', () => {
  it('is a stated usage limit and an exhausted account, not a retry', async () => {
    const { isRateLimitError } = await import('../src/limitFailure.js');
    const { isAccountExhaustedError } = await import('../src/accountFailover.js');
    const m = 'Error code: 429 - insufficient_quota: You exceeded your current quota';
    expect(isRateLimitError(m)).toBe(true);
    expect(isAccountExhaustedError(m)).toBe(true);
  });
});

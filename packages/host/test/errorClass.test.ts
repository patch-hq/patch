import { describe, it, expect } from 'vitest';
import { classifyFailure, backoffMs } from '../src/errorClass.js';

describe('classifyFailure', () => {
  it.each([
    ['API Error: 400 {"type":"invalid_request_error"}', 'permanent'],
    ['API Error: 401 authentication_error', 'permanent'],
    ['API Error: 403 permission_error', 'permanent'],
    ['API Error: 404 not_found_error: model: x', 'permanent'],
    ['Prompt is too long', 'permanent'],
    ['API Error: 413 request_too_large', 'permanent'],
    ["ENOENT: no such file or directory, open '/x'", 'permanent'],
    ['API Error: 529 overloaded_error', 'transient'],
    ['API Error: 429 rate_limit_error', 'transient'],
    ['API Error: 500 api_error', 'transient'],
    ['API Error: 502 bad gateway', 'transient'],
    ['API Error: 408 request timeout', 'transient'],
    ['read ECONNRESET', 'transient'],
    ['getaddrinfo EAI_AGAIN api.anthropic.com', 'transient'],
    ['fetch failed', 'transient'],
    ['socket hang up', 'transient'],
    ['Claude Code process exited with code 143', 'transient'],
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

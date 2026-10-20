import { describe, it, expect } from 'vitest';
import { splitActionText, parseAskHuman } from '../src/index.js';

describe('splitActionText', () => {
  it('splits a device-code login into text, link and code', () => {
    const segs = splitActionText(
      'Open https://device.sso.eu-west-2.amazonaws.com/?user_code=ABCD-EFGH. Enter ABCD-EFGH to approve',
    );
    expect(segs.filter((s) => s.kind === 'link')).toEqual([
      {
        kind: 'link',
        text: 'https://device.sso.eu-west-2.amazonaws.com/?user_code=ABCD-EFGH',
        href: 'https://device.sso.eu-west-2.amazonaws.com/?user_code=ABCD-EFGH',
      },
    ]);
    expect(segs.filter((s) => s.kind === 'code')).toEqual([{ kind: 'code', text: 'ABCD-EFGH' }]);
    expect(segs.map((s) => s.text).join('')).toBe(
      'Open https://device.sso.eu-west-2.amazonaws.com/?user_code=ABCD-EFGH. Enter ABCD-EFGH to approve',
    );
  });
  it('leaves plain prose, lowercase hyphenations and dates alone', () => {
    expect(splitActionText('plug in the well-known 2026-10-20 cable')).toEqual([
      { kind: 'text', text: 'plug in the well-known 2026-10-20 cable' },
    ]);
    expect(splitActionText('')).toEqual([]);
  });
});

describe('parseAskHuman', () => {
  it('reads task and optional why, rejects other shapes', () => {
    expect(parseAskHuman({ task: 'a', why: 'b' })).toEqual({ task: 'a', why: 'b' });
    expect(parseAskHuman({ task: 'a' })).toEqual({ task: 'a' });
    expect(parseAskHuman({ questions: [] })).toBeNull();
    expect(parseAskHuman(undefined)).toBeNull();
  });
});

import { isGroupableToolCall } from '../src/index.js';
describe('isGroupableToolCall for patch_ask_human', () => {
  it('keeps a well-formed request out of a run, groups a malformed one', () => {
    expect(isGroupableToolCall('mcp__patch__patch_ask_human', { task: 'sign in' })).toBe(false);
    expect(isGroupableToolCall('patch_ask_human', { task: 'sign in' })).toBe(false);
    expect(isGroupableToolCall('patch_ask_human', {})).toBe(true);
  });
});

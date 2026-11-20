import { describe, expect, it } from 'vitest';
import { canEditAt, canSideAt, forkPointIndex, type BranchEntry } from '../src/branch-points.js';

const user = (branchable = false): BranchEntry => ({
  type: 'chat.message',
  role: 'user',
  ...(branchable ? { branchable } : {}),
});
const reply = (branchable = true): BranchEntry => ({
  type: 'chat.message',
  role: 'assistant',
  ...(branchable ? { branchable } : {}),
});
const CLAUDE = 'claude-opus-5';
const CODEX = 'openai/gpt-5';
const ACP = 'acp/gemini/gemini-3';

describe('forkPointIndex', () => {
  it('an edit keeps the nearest earlier entry with a provider id', () => {
    const track = [user(true), reply(), user(true), reply()];
    expect(forkPointIndex('edit', track, 2, CLAUDE)).toBe(1);
  });

  it('an edit passes over a user turn the provider never answered', () => {
    const track = [user(true), reply(), user(false), user(true)];
    expect(forkPointIndex('edit', track, 3, CLAUDE)).toBe(1);
  });

  it('an edit of the first turn starts from an empty context', () => {
    expect(forkPointIndex('edit', [user(), reply()], 0, CLAUDE)).toBe('empty');
  });

  it('an edit is refused when the earlier output carries no provider id', () => {
    const track = [user(), reply(false), user()];
    expect(forkPointIndex('edit', track, 2, CLAUDE)).toBeNull();
  });

  it('an edit is only of a user turn', () => {
    expect(forkPointIndex('edit', [user(true), reply()], 1, CLAUDE)).toBeNull();
  });

  it('a side thread keeps the entry it hangs off, user turn included', () => {
    const track = [user(true), reply(), user(true), reply()];
    expect(forkPointIndex('side', track, 2, CLAUDE)).toBe(2);
    expect(forkPointIndex('side', track, 3, CLAUDE)).toBe(3);
  });

  it('a side thread off an entry with no provider id is refused', () => {
    expect(forkPointIndex('side', [user(), reply(false)], 1, CLAUDE)).toBeNull();
    expect(forkPointIndex('side', [user(), reply()], 0, CLAUDE)).toBeNull();
  });

  it('on a whole-turn provider, a side thread off a user turn keeps the turns before it', () => {
    const track = [user(), reply(), user(), reply()];
    expect(forkPointIndex('side', track, 2, CODEX)).toBe(1);
    expect(forkPointIndex('side', track, 0, CODEX)).toBe('empty');
  });
});

describe('canEditAt / canSideAt', () => {
  it('follow the provider capability as well as the fork point', () => {
    const track = [user(true), reply()];
    expect(canEditAt(track, 0, CLAUDE)).toBe(true);
    expect(canSideAt(track, 1, CLAUDE)).toBe(true);
    // ACP declares neither edit nor branch.
    expect(canEditAt(track, 0, ACP)).toBe(false);
    expect(canSideAt(track, 1, ACP)).toBe(false);
  });

  it('offer nothing on an older entry recorded without a provider id', () => {
    const old = [user(), reply(false), user()];
    expect(canEditAt(old, 2, CLAUDE)).toBe(false);
    expect(canSideAt(old, 1, CLAUDE)).toBe(false);
  });
});

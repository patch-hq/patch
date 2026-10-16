import { describe, expect, it } from 'vitest';
import { titlesOnSeveralHosts } from '../src/ambiguous-titles.js';

describe('titlesOnSeveralHosts', () => {
  it('flags a title that appears on two hosts', () => {
    const out = titlesOnSeveralHosts([
      { hostId: 'a', title: 'Fix login' },
      { hostId: 'b', title: 'Fix login' },
      { hostId: 'a', title: 'Other' },
    ]);
    expect([...out]).toEqual(['Fix login']);
  });

  it('ignores a title repeated on a single host', () => {
    const out = titlesOnSeveralHosts([
      { hostId: 'a', title: 'New chat' },
      { hostId: 'a', title: 'New chat' },
    ]);
    expect(out.size).toBe(0);
  });

  it('is empty for no chats', () => {
    expect(titlesOnSeveralHosts([]).size).toBe(0);
  });
});

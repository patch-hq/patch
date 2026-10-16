import { describe, it, expect } from 'vitest';
import { hasParentSegment } from '../src/chat-routes.js';

describe('hasParentSegment', () => {
  it('refuses a ".." segment however it is spelled', () => {
    for (const p of ['..', '../etc/passwd', 'a/../b', 'a/..', 'a\\..\\b']) {
      expect(hasParentSegment(p), p).toBe(true);
    }
  });

  it('allows names that merely contain two dots', () => {
    for (const p of ['notes..md', 'a..b/c.txt', '...', 'dir/.hidden..', 'v1.2..3']) {
      expect(hasParentSegment(p), p).toBe(false);
    }
  });
});

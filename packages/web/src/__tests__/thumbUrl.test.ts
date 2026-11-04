import { describe, it, expect, vi, afterEach } from 'vitest';
import { thumbUrl, thumbWidth } from '../lib/thumbUrl.js';

describe('thumbWidth', () => {
  it('rounds device pixels up to a bucket and caps at the largest', () => {
    expect(thumbWidth(360, 3)).toBe(1440);
    expect(thumbWidth(360, 1)).toBe(480);
    expect(thumbWidth(800, 3)).toBe(2048);
    expect(thumbWidth(100, 0.5)).toBe(320);
  });
});

describe('thumbUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds the width to a served url, with ? or & as needed', () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('devicePixelRatio', 2);
    expect(thumbUrl('/api/chats/c/blob/abc')).toBe('/api/chats/c/blob/abc?w=960');
    expect(thumbUrl('/api/chats/c/artifact/a?sig=x')).toBe('/api/chats/c/artifact/a?sig=x&w=960');
  });

  it('leaves in-memory urls alone', () => {
    expect(thumbUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(thumbUrl('blob:http://x/1')).toBe('blob:http://x/1');
  });
});

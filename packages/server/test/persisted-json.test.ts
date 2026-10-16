import { describe, expect, it } from 'vitest';
import { parsePersisted } from '../src/persisted-json.js';

describe('parsePersisted', () => {
  it('reads a file written before the host rename under the new names', () => {
    const old = JSON.stringify({
      chats: [{ chatId: 'c1', daemonId: 'h1' }],
      held: [{ daemonId: 'h1', event: { type: 'chat.input', daemonId: 'h1' } }],
    });
    expect(parsePersisted(old)).toEqual({
      chats: [{ chatId: 'c1', hostId: 'h1' }],
      held: [{ hostId: 'h1', event: { type: 'chat.input', hostId: 'h1' } }],
    });
  });
  it('leaves a current file alone', () => {
    const now = { chats: [{ chatId: 'c1', hostId: 'h1' }] };
    expect(parsePersisted(JSON.stringify(now))).toEqual(now);
  });
});

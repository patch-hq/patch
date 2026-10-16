import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontChatPath, parseOpenChat, writeFrontChat } from './front-chat';

test('parseOpenChat stamps changedAt and keeps the three fields', () => {
  assert.deepEqual(parseOpenChat({ chatId: 'c1', name: 'Fix it', folder: '/p/x' }, 42), {
    chatId: 'c1',
    name: 'Fix it',
    folder: '/p/x',
    changedAt: 42,
  });
});

test('parseOpenChat accepts "no chat open" and rejects malformed payloads', () => {
  assert.equal(parseOpenChat({ chatId: null, name: null, folder: null }, 1)?.chatId, null);
  assert.equal(parseOpenChat(null, 1), null);
  assert.equal(parseOpenChat({ chatId: 3, name: null, folder: null }, 1), null);
  assert.equal(parseOpenChat({ chatId: 'c' }, 1), null);
});

test('writeFrontChat writes ~/.patch/front-chat.json atomically and overwrites', () => {
  const home = mkdtempSync(join(tmpdir(), 'front-chat-'));
  try {
    writeFrontChat(home, { chatId: 'a', name: 'A', folder: 'f', changedAt: 1 });
    writeFrontChat(home, { chatId: 'b', name: 'B', folder: 'f', changedAt: 2 });
    assert.deepEqual(JSON.parse(readFileSync(frontChatPath(home), 'utf8')), {
      chatId: 'b',
      name: 'B',
      folder: 'f',
      changedAt: 2,
    });
    assert.deepEqual(readdirSync(join(home, '.patch')), ['front-chat.json']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

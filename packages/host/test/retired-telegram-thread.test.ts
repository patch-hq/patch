// The retired Telegram thread's working folder is removed from the Patch home
// when empty, and left (and said) when it still holds files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  removeRetiredTelegramFolder,
  retiredTelegramFolder,
} from '../src/retiredTelegramThread.js';

const silent = pino({ level: 'silent' });

describe('the retired Telegram thread folder', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-telegram-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is removed when empty, and the other threads are untouched', () => {
    mkdirSync(retiredTelegramFolder(home), { recursive: true });
    mkdirSync(join(home, 'threads', 'manager'), { recursive: true });
    expect(removeRetiredTelegramFolder(home, silent)).toBe('removed');
    expect(existsSync(retiredTelegramFolder(home))).toBe(false);
    expect(existsSync(join(home, 'threads', 'manager'))).toBe(true);
  });

  it('is left when it holds files', () => {
    mkdirSync(retiredTelegramFolder(home), { recursive: true });
    writeFileSync(join(retiredTelegramFolder(home), 'notes.md'), 'mine');
    expect(removeRetiredTelegramFolder(home, silent)).toBe('kept');
    expect(existsSync(join(retiredTelegramFolder(home), 'notes.md'))).toBe(true);
  });

  it('does nothing when there is none', () => {
    expect(removeRetiredTelegramFolder(home, silent)).toBe('absent');
  });
});

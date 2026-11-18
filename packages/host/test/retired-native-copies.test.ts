// spec/04 § History — the pre-migration `native/claude` copies of each chat's
// Claude transcript are removed once, carrying any never-resumed session into
// the chat's own dir first.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatTranscriptPath } from '../src/claudeSessionStore.js';
import {
  RETIRED_NATIVE_COPIES_MARKER,
  removeRetiredNativeCopies,
  retiredNativeDir,
} from '../src/retiredNativeCopies.js';

describe('removeRetiredNativeCopies', () => {
  let home: string;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const chatDir = (id: string) => join(home, 'chats', id);
  const seedOld = (id: string, sessionId: string, body: string) => {
    mkdirSync(retiredNativeDir(chatDir(id)), { recursive: true });
    writeFileSync(join(retiredNativeDir(chatDir(id)), `${sessionId}.jsonl`), body);
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-retired-native-'));
    logger.info.mockClear();
    logger.warn.mockClear();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('removes old copies, keeping the chat’s own transcript as it is', () => {
    seedOld('a', 's1', '{"uuid":"old"}\n');
    const own = chatTranscriptPath(chatDir('a'), '/w', 's1');
    mkdirSync(join(own, '..'), { recursive: true });
    writeFileSync(own, '{"uuid":"own"}\n');
    const r = removeRetiredNativeCopies({ patchHome: home, folderOf: () => '/w', logger });
    expect(r).toMatchObject({ removed: 1, carried: 0, failed: 0 });
    expect(existsSync(join(chatDir('a'), 'native'))).toBe(false);
    expect(readFileSync(own, 'utf8')).toBe('{"uuid":"own"}\n');
  });

  it('carries a never-resumed session into the chat’s own dir before removing its copy', () => {
    seedOld('b', 's2', '{"uuid":"only"}\n');
    const r = removeRetiredNativeCopies({ patchHome: home, folderOf: () => '/w', logger });
    expect(r).toMatchObject({ removed: 1, carried: 1 });
    expect(readFileSync(chatTranscriptPath(chatDir('b'), '/w', 's2'), 'utf8')).toBe(
      '{"uuid":"only"}\n',
    );
    expect(existsSync(retiredNativeDir(chatDir('b')))).toBe(false);
  });

  it('runs once: a marker stops later starts walking every chat', () => {
    seedOld('a', 's1', '{}\n');
    removeRetiredNativeCopies({ patchHome: home, folderOf: () => '/w', logger });
    expect(existsSync(join(home, RETIRED_NATIVE_COPIES_MARKER))).toBe(true);
    seedOld('c', 's3', '{}\n');
    const again = removeRetiredNativeCopies({ patchHome: home, folderOf: () => '/w', logger });
    expect(again.skipped).toBe(true);
    expect(existsSync(retiredNativeDir(chatDir('c')))).toBe(true);
  });

  it('leaves a chat whose folder is unknown, says so, and tries again next start', () => {
    seedOld('d', 's4', '{}\n');
    const r = removeRetiredNativeCopies({ patchHome: home, folderOf: () => undefined, logger });
    expect(r).toMatchObject({ removed: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(existsSync(retiredNativeDir(chatDir('d')))).toBe(true);
    expect(existsSync(join(home, RETIRED_NATIVE_COPIES_MARKER))).toBe(false);
    const next = removeRetiredNativeCopies({ patchHome: home, folderOf: () => '/w', logger });
    expect(next).toMatchObject({ removed: 1, carried: 1, failed: 0 });
  });

  it('does nothing on a host with no chats', () => {
    const r = removeRetiredNativeCopies({ patchHome: home, folderOf: () => '/w', logger });
    expect(r).toMatchObject({ skipped: false, removed: 0, failed: 0 });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

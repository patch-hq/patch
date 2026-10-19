// spec/14 § Artifacts — editing the source file of a published artifact
// republishes it, so an open panel / viewer refreshes without the agent
// having to call patch_artifact again.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { ArtifactAutoRepublisher } from '../src/artifacts.js';

const published = (chatId: string, artifactId: string, path: string): WireEvent =>
  ({
    type: 'chat.artifact',
    chatId,
    artifactId,
    title: 'Page',
    url: 'u',
    path,
    updatedAt: 1,
    seq: 1,
  }) as WireEvent;
const changed = (chatId: string, path: string): WireEvent =>
  ({ type: 'patch.file_changed', chatId, path }) as WireEvent;

describe('ArtifactAutoRepublisher', () => {
  let folder: string;
  const publish = vi.fn(async () => ({ url: '/new?sig=x' }));
  const emitArtifact = vi.fn();
  const error = vi.fn();
  let r: ArtifactAutoRepublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    folder = mkdtempSync(join(tmpdir(), 'patch-aar-'));
    writeFileSync(join(folder, 'page.html'), '<p>v2</p>');
    publish.mockClear();
    emitArtifact.mockClear();
    error.mockClear();
    r = new ArtifactAutoRepublisher({
      folderOf: (id) => (id === 'c1' ? folder : undefined),
      publish,
      emitArtifact,
      logger: { error },
      debounceMs: 100,
    });
    r.observe(published('c1', 'aa', 'page.html'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(folder, { recursive: true, force: true });
  });

  it('republishes the page when its source file changes, once per burst', async () => {
    r.observe(changed('c1', 'page.html'));
    r.observe(changed('c1', 'page.html'));
    await vi.advanceTimersByTimeAsync(150);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', artifactId: 'aa', path: 'page.html', title: 'Page' }),
    );
    expect(emitArtifact).toHaveBeenCalledWith('c1', {
      artifactId: 'aa',
      title: 'Page',
      url: '/new?sig=x',
      path: 'page.html',
    });
  });

  it('ignores files that were never published, and Pad cards', async () => {
    r.observe(published('c1', 'pad-1', 'pad'));
    r.observe(changed('c1', 'other.html'));
    r.observe(changed('c1', 'pad'));
    r.observe(changed('c2', 'page.html'));
    await vi.advanceTimersByTimeAsync(150);
    expect(publish).not.toHaveBeenCalled();
  });

  it('logs loudly, never throws, when the republish fails', async () => {
    publish.mockRejectedValueOnce(new Error('link down'));
    r.observe(changed('c1', 'page.html'));
    await vi.advanceTimersByTimeAsync(150);
    expect(error).toHaveBeenCalledTimes(1);
    expect(emitArtifact).not.toHaveBeenCalled();
  });

  it('logs loudly when the source is gone', async () => {
    rmSync(join(folder, 'page.html'));
    r.observe(changed('c1', 'page.html'));
    await vi.advanceTimersByTimeAsync(150);
    expect(error).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });
});

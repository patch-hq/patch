import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepUpdateWorkDirs } from '../src/selfUpdate.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeDir(root: string, name: string, ageMs: number): void {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'host.tar.gz'), 'x');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(dir, t, t);
}

describe('sweepUpdateWorkDirs', () => {
  it('removes old patch-update folders, keeps recent ones and unrelated entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    roots.push(root);
    makeDir(root, 'patch-update-old', 60 * 60_000);
    makeDir(root, 'patch-update-new', 1_000);
    makeDir(root, 'other-old', 60 * 60_000);
    expect(sweepUpdateWorkDirs(root)).toEqual(['patch-update-old']);
    expect(existsSync(join(root, 'patch-update-old'))).toBe(false);
    expect(existsSync(join(root, 'patch-update-new'))).toBe(true);
    expect(existsSync(join(root, 'other-old'))).toBe(true);
  });

  it('skips an entry it cannot stat, reports it, and still removes the others', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    roots.push(root);
    makeDir(root, 'patch-update-old', 60 * 60_000);
    symlinkSync(join(root, 'missing-target'), join(root, 'patch-update-dangling'));
    const errors: string[] = [];
    let removed: string[] = [];
    expect(() => {
      removed = sweepUpdateWorkDirs(root, Date.now(), 15 * 60_000, (name) => errors.push(name));
    }).not.toThrow();
    expect(removed).toEqual(['patch-update-old']);
    expect(errors).toEqual(['patch-update-dangling']);
    expect(existsSync(join(root, 'patch-update-old'))).toBe(false);
  });
});

describe('sweepUpdateWorkDirs when a removal is refused', () => {
  // root ignores permission bits, so the refusal cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)(
    'reports a folder it may not remove and still sweeps the others',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
      roots.push(root);
      makeDir(root, 'patch-update-a-old', 60 * 60_000);
      makeDir(root, 'patch-update-b-locked', 60 * 60_000);
      makeDir(root, 'patch-update-c-old', 60 * 60_000);
      // A read-only subfolder holding a file: unlinking the file gives EACCES.
      const locked = join(root, 'patch-update-b-locked', 'inner');
      mkdirSync(locked);
      writeFileSync(join(locked, 'f'), 'x');
      chmodSync(locked, 0o555);
      const old = (Date.now() - 60 * 60_000) / 1000;
      utimesSync(join(root, 'patch-update-b-locked'), old, old);
      const errors: { name: string; code: unknown }[] = [];
      try {
        const removed = sweepUpdateWorkDirs(root, Date.now(), 15 * 60_000, (name, err) =>
          errors.push({ name, code: (err as NodeJS.ErrnoException).code }),
        );
        expect(removed.sort()).toEqual(['patch-update-a-old', 'patch-update-c-old']);
        expect(errors).toHaveLength(1);
        expect(errors[0].name).toBe('patch-update-b-locked');
        expect(['EACCES', 'EPERM']).toContain(errors[0].code);
        expect(existsSync(join(root, 'patch-update-a-old'))).toBe(false);
        expect(existsSync(join(root, 'patch-update-c-old'))).toBe(false);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe('update work folder', () => {
  it('lives under the host home, not the system temp dir', async () => {
    const { updateWorkRoot } = await import('../src/selfUpdate.js');
    expect(updateWorkRoot('/home/u/.patch')).toBe('/home/u/.patch/update-work');
  });

  it('sweeping a folder that does not exist yet is a no-op', () => {
    expect(sweepUpdateWorkDirs(join(tmpdir(), 'sweep-missing-never-made'))).toEqual([]);
  });

  it('says plainly when the disk is full', async () => {
    const { describeUpdateRefusal } = await import('../src/selfUpdate.js');
    expect(describeUpdateRefusal('self-update failed: ENOSPC: No space left on device')).toMatch(
      /out of disk space/,
    );
  });
});

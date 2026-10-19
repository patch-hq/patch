// A skill added or edited while a turn is running must reach that turn's agent
// at the next tool boundary, not only the next turn.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillsReloader } from '../src/projectSkills.js';

let home: string;
let folder: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-skills-reload-'));
  folder = join(home, 'project');
  mkdirSync(folder, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(name: string, body: string, mtime?: number): void {
  const dir = join(home, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, body);
  if (mtime) utimesSync(file, mtime, mtime);
}

describe('skillsReloader', () => {
  it('reloads only when the skills on disk changed since the last check', async () => {
    write('a', '---\ndescription: one\n---\n', 1000);
    let reloads = 0;
    const check = skillsReloader(folder, async () => void reloads++, home);
    await check();
    expect(reloads).toBe(0);
    write('b', '---\ndescription: new\n---\n'); // new skill
    await check();
    expect(reloads).toBe(1);
    await check();
    expect(reloads).toBe(1);
    write('a', '---\ndescription: two\n---\n', 2000); // edited skill
    await check();
    expect(reloads).toBe(2);
  });

  it('sees a skill appear in a skills directory that did not exist at the start', async () => {
    let reloads = 0;
    const check = skillsReloader(folder, async () => void reloads++, home);
    write('first', '# first\n');
    await check();
    expect(reloads).toBe(1);
  });

  it('lets a failed reload surface and retries on the next check', async () => {
    write('a', '# a\n', 1000);
    let fail = true;
    let reloads = 0;
    const check = skillsReloader(
      folder,
      async () => {
        reloads++;
        if (fail) throw new Error('boom');
      },
      home,
    );
    write('b', '# b\n');
    await expect(check()).rejects.toThrow('boom');
    fail = false;
    await check();
    expect(reloads).toBe(2);
  });
});

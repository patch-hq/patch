import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, skillCatalogueText } from '../src/projectSkills.js';

const skill = (root: string, dir: string, name: string) => {
  mkdirSync(join(root, '.claude', 'skills', dir), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'skills', dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: does ${name}\n---\nbody\n`,
  );
};

describe('project skill discovery for Codex turns', () => {
  it('sees a renamed skill on the very next call', () => {
    const proj = mkdtempSync(join(tmpdir(), 'ps-'));
    const home = mkdtempSync(join(tmpdir(), 'psh-'));
    skill(proj, 'pixelunion', 'pixelunion');
    expect(discoverSkills(proj, home).map((s) => s.name)).toEqual(['pixelunion']);
    renameSync(join(proj, '.claude/skills/pixelunion'), join(proj, '.claude/skills/photo-access'));
    const after = discoverSkills(proj, home);
    expect(after.map((s) => s.name)).toEqual(['photo-access']);
    expect(skillCatalogueText(after)).toContain('photo-access: does pixelunion');
  });

  it('prefers the project copy and includes host skills', () => {
    const proj = mkdtempSync(join(tmpdir(), 'ps-'));
    const home = mkdtempSync(join(tmpdir(), 'psh-'));
    skill(proj, 'a', 'a');
    skill(home, 'a', 'a-home');
    skill(home, 'b', 'b');
    const got = discoverSkills(proj, home);
    expect(got.map((s) => s.name)).toEqual(['a', 'b']);
    expect(got[0]!.file.startsWith(proj)).toBe(true);
  });

  it('sees skills from ancestor folders, nearest first', () => {
    const root = mkdtempSync(join(tmpdir(), 'ps-'));
    const home = mkdtempSync(join(tmpdir(), 'psh-'));
    skill(root, 'top', 'top');
    skill(root, 'shared', 'shared-root');
    const sub = join(root, 'projects', 'app');
    skill(sub, 'shared', 'shared-sub');
    const got = discoverSkills(sub, home);
    expect(got.map((s) => s.name)).toEqual(['shared', 'top']);
    expect(got[0]!.description).toBe('does shared-sub');
  });

  it('returns no catalogue when there are no skills', () => {
    expect(skillCatalogueText([])).toBeUndefined();
  });
});

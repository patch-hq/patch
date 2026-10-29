import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatterFields } from './claudeSettings.js';

export interface FoundSkill {
  name: string;
  file: string;
  description: string;
}

/**
 * Every `.claude/skills` directory a chat in `folder` can draw on, nearest
 * first: the folder's own, then each ancestor's (a chat in `projects/app`
 * still sees the repo root's skills), then the host's `~/.claude/skills`.
 */
export function skillDirs(folder: string, home = process.env['HOME'] ?? homedir()): string[] {
  const dirs: string[] = [];
  let dir = resolve(folder);
  for (;;) {
    dirs.push(join(dir, '.claude', 'skills'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.push(join(home, '.claude', 'skills'));
  return [...new Set(dirs)];
}

/**
 * The skills a chat in `folder` can invoke: see `skillDirs` for where they come
 * from (a name in more than one resolves to the nearest). Read off disk on EVERY call — there is deliberately no cache, so
 * a renamed or new skill is seen on the very next turn. Symlinks are followed.
 */
export function discoverSkills(
  folder: string,
  home = process.env['HOME'] ?? homedir(),
): FoundSkill[] {
  const found = new Map<string, FoundSkill>();
  for (const dir of skillDirs(folder, home)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      let file: string | undefined;
      let name = entry.name;
      try {
        if (statSync(path).isDirectory()) {
          if (existsSync(join(path, 'SKILL.md'))) file = join(path, 'SKILL.md');
        } else if (entry.name.endsWith('.md')) {
          file = path;
          name = entry.name.slice(0, -'.md'.length);
        }
      } catch {
        continue; // dangling symlink
      }
      if (!file || found.has(name)) continue;
      let description = '';
      try {
        description = parseFrontmatterFields(readFileSync(file, 'utf8'))['description'] ?? '';
      } catch {
        continue;
      }
      found.set(name, { name, file, description });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Codex only discovers its own skill roots (`.agents/skills`), never
 * `.claude/skills`, so a Codex turn gets the catalogue as text. Returns
 * undefined when there are no skills.
 */
export function skillCatalogueText(skills: readonly FoundSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = skills.map((s) => {
    const d = s.description.length > 160 ? s.description.slice(0, 157) + '...' : s.description;
    return `- ${s.name}: ${d} (${s.file})`;
  });
  return [
    'Project and host skills (from .claude/skills). When the user types /<name> or the task matches one, read its SKILL.md at the path given and follow it.',
    ...lines,
  ].join('\n');
}

/**
 * Fingerprint of the skills a chat in `folder` can see: name, file, mtime and
 * description. Any add, remove, rename or edit changes it.
 */
function skillsFingerprint(folder: string, home: string): string {
  return discoverSkills(folder, home)
    .map((s) => `${s.name}\0${s.file}\0${statSync(s.file).mtimeMs}\0${s.description}`)
    .join('\n');
}

/**
 * A check to run at each tool boundary of a live agent process: when the skills
 * on disk differ from the last time it looked, calls `reload` so the process
 * picks them up mid-turn rather than on the next one. A failed reload throws
 * and is retried on the next check.
 */
export function skillsReloader(
  folder: string,
  reload: () => Promise<unknown>,
  home = process.env['HOME'] ?? homedir(),
): () => Promise<void> {
  let seen = skillsFingerprint(folder, home);
  return async () => {
    const now = skillsFingerprint(folder, home);
    if (now === seen) return;
    await reload();
    seen = now;
  };
}

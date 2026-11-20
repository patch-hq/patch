// Nothing outside the adapters branches on a provider by name (spec/02 §
// Provider adapters; plan 2026-11-17 decision 16). Web, mobile and the host's
// core read a provider's facts from the PROVIDERS table (`providerForModel`,
// `providerDescriptor`, `modelHasCapability`) and its host behaviour from
// HARNESS_TRAITS — never from its name, model prefix or session-id prefix.
//
// This scan fails on any branching of that kind. Account and sign-in wiring reads
// the provider table (`accountsKey`, `accountKinds`, `ownSettingsReportedByHost`)
// and each surface's own provider entries.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Where the scan looks: every surface and the host. */
const SCANNED = ['packages/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages/host/src'];

/** The adapters themselves, which are where a provider's own names belong. */
const ADAPTERS = new Set([
  'packages/host/src/codexBackend.ts',
  'packages/host/src/codexAccounts.ts',
  'packages/host/src/codexSessions.ts',
  'packages/host/src/localModels.ts',
  'packages/host/src/openaiCompatBackend.ts',
  'packages/host/src/sdkBackend.ts',
  'packages/host/src/harnesses.ts',
]);

/** Shapes of provider-name branching. Each match is one count. */
const PATTERNS: readonly RegExp[] = [
  // A provider id compared by name.
  /\b(provider|providerId|harness|harnessId)\s*[!=]==\s*'(claude|codex|local)'/g,
  /'(claude|codex|local)'\s*[!=]==\s*(provider|providerId|harness|harnessId)\b/g,
  /providerFor\w*\([^)]*\)\s*[!=]==\s*'/g,
  /case '(claude|codex|claude-code)':/g,
  // A backend id compared by name.
  /\b(backendId|b\.id)\s*[!=]==\s*'(claude-code|codex)'/g,
  // A model prefix or session-id prefix spelled out.
  /['"`](openai|local)\//g,
  /startsWith\(\s*['"`](codex|local)-/g,
  // A provider's accounts picked out of the shared settings by name.
  /\b\w*(secrets|Secrets|Accounts)\??\.(claude|codex)\b/g,
];

const SKIP = /(__tests__|\.test\.|\/test\/|node_modules)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (SKIP.test(`${path}/`)) continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function branchingByFile(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const dir of SCANNED) {
    for (const path of sourceFiles(join(ROOT, dir))) {
      const rel = relative(ROOT, path);
      if (ADAPTERS.has(rel)) continue;
      const src = readFileSync(path, 'utf8');
      const hits = PATTERNS.flatMap((re) => [...src.matchAll(re)].map((m) => m[0]));
      if (hits.length > 0) found[rel] = hits;
    }
  }
  return found;
}

describe('no provider-name branching outside the adapters', () => {
  const found = branchingByFile();

  it('finds none', () => {
    const named = Object.entries(found).map(([file, hits]) => `${file}: ${hits.join(', ')}`);
    expect(named).toEqual([]);
  });

  it('catches each shape it looks for', () => {
    const samples = [
      "if (provider === 'codex') {}",
      "providerForModel(m) === 'claude'",
      "case 'codex':",
      "backendId === 'codex'",
      "model.startsWith('openai/')",
      "id.startsWith('codex-')",
      'shared?.secrets?.codex',
    ];
    for (const s of samples) {
      expect(
        PATTERNS.some((re) => new RegExp(re.source).test(s)),
        s,
      ).toBe(true);
    }
  });
});

/**
 * The chat core (decision 16): the files that run every chat whatever its
 * provider. They reach a provider only through its traits (`harnesses.ts`) and
 * its adapter, and speak of sessions by generic id, so a name of a provider —
 * an identifier such as `isClaudeSessionInvalidError` or `claudeSessionId`, or
 * an import of a provider's own module — has no place in them. Comments do not
 * count; string literals do.
 */
const CORE = [
  'packages/host/src/chatRunner.ts',
  'packages/host/src/chatState.ts',
  'packages/host/src/meta.ts',
  'packages/host/src/chatLog.ts',
  'packages/host/src/readTrack.ts',
  'packages/host/src/recordEntries.ts',
];

/**
 * What the core still names, by file — only the old field names meta keeps on
 * disk for a host rolled back to an older build (`claudeSessionId`,
 * `claudeSessionAccountId`; spec/02 § Session capture). Lower it when disk
 * moves to the new names; never raise it.
 */
const CORE_BASELINE: Record<string, number> = {
  'packages/host/src/meta.ts': 2,
};

const CORE_PATTERNS: readonly RegExp[] = [
  /\b\w*(?:Claude|Codex|Acp|Gemini)\w*\b/g,
  /\b(?:claude|codex|acp|gemini)[A-Z]\w*\b/g,
  /from '\.\/(?:claude|codex|acp)\w*\.js'/g,
];

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('the chat core names no provider', () => {
  const found: Record<string, string[]> = {};
  for (const rel of CORE) {
    const src = withoutComments(readFileSync(join(ROOT, rel), 'utf8'));
    const hits = CORE_PATTERNS.flatMap((re) => [...src.matchAll(re)].map((m) => m[0]));
    if (hits.length > 0) found[rel] = hits;
  }

  it('adds none beyond the recorded baseline', () => {
    const over = Object.entries(found)
      .filter(([file, hits]) => hits.length > (CORE_BASELINE[file] ?? 0))
      .map(
        ([file, hits]) =>
          `${file}: ${hits.length} (baseline ${CORE_BASELINE[file] ?? 0}): ${hits.join(', ')}`,
      );
    expect(over).toEqual([]);
  });

  it('keeps the baseline down to what is still there', () => {
    const stale = Object.entries(CORE_BASELINE)
      .filter(([file, n]) => (found[file]?.length ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n}, now ${found[file]?.length ?? 0} — lower it`);
    expect(stale).toEqual([]);
  });

  it('catches each shape it looks for, and ignores comments', () => {
    const samples = [
      'if (isClaudeSessionInvalidError(err)) {}',
      'state.claudeSessionId = id;',
      'await createClaudeSessionStore(opts);',
      "import { CodexHistory } from './codexHistory.js';",
      "import { x } from './acpBackend.js';",
    ];
    for (const s of samples) {
      expect(
        CORE_PATTERNS.some((re) => new RegExp(re.source).test(withoutComments(s))),
        s,
      ).toBe(true);
    }
    expect(
      CORE_PATTERNS.some((re) => new RegExp(re.source).test(withoutComments('// Claude says'))),
    ).toBe(false);
  });
});

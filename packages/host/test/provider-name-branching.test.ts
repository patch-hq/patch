// Nothing outside the adapters branches on a provider by name (spec/02 §
// Provider adapters; plan 2026-11-17 decision 16). Web, mobile and the host's
// core read a provider's facts from the PROVIDERS table (`providerForModel`,
// `providerDescriptor`, `modelHasCapability`) and its host behaviour from
// HARNESS_TRAITS — never from its name, model prefix or session-id prefix.
//
// This scan fails on any NEW branching of that kind. The files below that still
// have some are a ratchet: when you remove one, lower its count (delete the
// entry at zero); never raise one to get a change through.

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
  'packages/host/src/localModels.ts',
  'packages/host/src/openaiCompatBackend.ts',
  'packages/host/src/sdkBackend.ts',
  'packages/host/src/harnesses.ts',
]);

/**
 * What still branches on a provider's name outside the adapters, by file. Each
 * is per-provider account or sign-in wiring in Settings and the host's account
 * setup, which has not moved behind the table yet.
 */
const BASELINE: Record<string, number> = {
  'packages/web/src/lib/useInstallPickedProviders.ts': 2,
  'packages/web/src/routes/WelcomeRoute.tsx': 4,
  'packages/web/src/routes/settings/ProvidersPage.tsx': 1,
  'packages/web/src/routes/settings/SharedAccounts.tsx': 2,
  'packages/web/src/routes/settings/providers.tsx': 2,
  'apps/mobile/src/components/settings/CreditSourcesSection.tsx': 2,
  'apps/mobile/src/components/settings/ProviderOwnSettings.tsx': 1,
  'apps/mobile/src/components/settings/providers.tsx': 2,
  'packages/host/src/index.ts': 6,
  'packages/host/src/rotationDigest.ts': 1,
};

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

  it('adds none beyond the recorded baseline', () => {
    const over = Object.entries(found)
      .filter(([file, hits]) => hits.length > (BASELINE[file] ?? 0))
      .map(
        ([file, hits]) =>
          `${file}: ${hits.length} (baseline ${BASELINE[file] ?? 0}): ${hits.join(', ')}`,
      );
    expect(over).toEqual([]);
  });

  it('keeps the baseline down to what is still there', () => {
    const stale = Object.entries(BASELINE)
      .filter(([file, n]) => (found[file]?.length ?? 0) < n)
      .map(([file, n]) => `${file}: baseline ${n}, now ${found[file]?.length ?? 0} — lower it`);
    expect(stale).toEqual([]);
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

// expo-router's usePathname / useGlobalSearchParams / useSegments /
// useUnstableGlobalHref / useRootNavigationState call syncStoreRootState()
// during render. With a nested navigator the container's getRootState()
// returns a new object on every call, so a component under the navigator that
// uses one re-renders forever: the JS thread pinned at 100% on every tab
// screen, then out of memory. Unit tests cannot see it (the router is a stub),
// so this holds the line in source: under the navigator, read the route through
// `useCurrentRoute` (src/lib/currentRoute.ts).
//
// The root layout renders above the navigator and is the one place allowed to
// ask whether it has mounted.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const STORE_HOOKS = [
  'usePathname',
  'useGlobalSearchParams',
  'useSegments',
  'useUnstableGlobalHref',
  'useRootNavigationState',
  'useRootNavigation',
];
const ALLOWED: Record<string, string[]> = { 'app/_layout.tsx': ['useRootNavigationState'] };

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('expo-router store hooks', () => {
  it('are not used under the navigator', () => {
    const offenders: string[] = [];
    for (const file of [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'src'))]) {
      const rel = relative(ROOT, file);
      const text = readFileSync(file, 'utf8');
      for (const hook of STORE_HOOKS) {
        // Match the call, not the explanatory comments that name the hooks.
        const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (new RegExp(`\\b${hook}\\s*[(<]`).test(code) && !ALLOWED[rel]?.includes(hook)) {
          offenders.push(`${rel}: ${hook}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { defineConfig } from '@playwright/test';

// The packaged app's first run, end to end (spec/05 § Desktop first run).
// Runs the real Patch.app — build it first with `node scripts/dist.cjs --dir`,
// or point PATCH_DESKTOP_APP at another build's executable.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 15 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/e2e-first-run',
});

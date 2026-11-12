import { defineConfig } from 'vitest/config';

// Against an external relay (test/target.ts) every round trip crosses the
// internet, and the hello-timeout test waits out the deployed timeout.
const external = Boolean(process.env['PATCH_RELAY_TEST_URL']);

export default defineConfig({
  test: {
    testTimeout: external ? 30_000 : 5_000,
    hookTimeout: external ? 30_000 : 10_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // I/O-integration suite (spawns real sidecars, boots UDS/WSS). Transient
    // timing misses under host load retry rather than fail the whole run; a
    // real regression still fails every attempt.
    retry: 2,
    // On a CI runner the suite's real sidecars and fork workers together
    // outgrow the VM's memory and the kernel SIGKILLs the run (exit 137, no
    // assertion failed). Two forks still got killed in merge-group runs, so CI
    // runs one at a time.
    poolOptions: {
      forks: process.env.CI
        ? // A fork that outgrows the heap fails with a V8 out-of-memory error
          // naming the test file, instead of the kernel killing the whole run.
          { minForks: 1, maxForks: 1, execArgv: ['--max-old-space-size=2048'] }
        : {},
    },
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'dist/**',
        // CLI entrypoint: process-bootstrap script launched as a child
        // process by the Claude Code SDK. Its own body is argv-branching +
        // process.exit(), and it delegates all real logic to mcp.ts (which
        // is fully unit tested).
        'src/bin/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});

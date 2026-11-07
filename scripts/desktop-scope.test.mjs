import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, inMacApp } from './desktop-scope.mjs';

test('the shell, server, web UI and host are all in the Mac app', () => {
  for (const p of [
    'packages/desktop/src/main.ts',
    'packages/server/src/app.ts',
    'packages/web/src/components/Sidebar.tsx',
    'packages/host/src/chatRunner.ts',
    'packages/wire/src/events.ts',
    'pnpm-lock.yaml',
    'package.json',
    'scripts/build-server.mjs',
    '.github/workflows/release.yml',
  ]) {
    assert.equal(inMacApp(p), true, p);
  }
});

test('the phone app, specs, docs, tests and other workflows are not', () => {
  for (const p of [
    'apps/mobile/src/api/ws.ts',
    'spec/11-deployment.md',
    'docs/providers.md',
    'design/all-screens.html',
    'README.md',
    'packages/web/src/__tests__/ws.test.ts',
    'packages/web/e2e/meeting-mode.spec.ts',
    'packages/host/test/meeting.test.ts',
    'packages/desktop/src/updater.test.ts',
    'scripts/desktop-scope.test.mjs',
    '.github/workflows/test.yml',
  ]) {
    assert.equal(inMacApp(p), false, p);
  }
});

test('a path nobody listed counts as in the app', () => {
  assert.equal(inMacApp('somewhere/new/thing.ts'), true);
  assert.equal(inMacApp('packages/server/README.md'), true);
});

test('one in-app file among many others is enough to build', () => {
  assert.equal(decide(['apps/mobile/a.ts', 'docs/b.md', 'packages/server/src/c.ts']), 'build');
});

test('a release touching only things outside the app reuses the last build', () => {
  assert.equal(
    decide(['apps/mobile/a.ts', 'spec/b.md', 'packages/web/src/__tests__/c.test.tsx']),
    'reuse',
  );
  assert.equal(decide([]), 'reuse');
});

// What the packaged app carries for a first run on "This computer" (spec/05 §
// Desktop first run). electron-builder copies build/staged/<x> into the app's
// resources; stage-resources writes those folders and the first run reads them.
// The three named different folders once (`daemon` vs `host`), so shipped apps
// carried no host and could not set one up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const stage = readFileSync(join(root, 'scripts', 'stage-resources.cjs'), 'utf8');
const firstRun = readFileSync(join(root, 'src', 'first-run', 'index.ts'), 'utf8');

const carried = [...yml.matchAll(/- from: build\/staged\/(\w+)\n\s+to: (\w+)/g)].map((m) => ({
  from: m[1]!,
  to: m[2]!,
}));

test('the app carries the server and the host, each where it was staged', () => {
  assert.deepEqual(carried, [
    { from: 'server', to: 'server' },
    { from: 'host', to: 'host' },
  ]);
});

test('stage-resources writes exactly those folders', () => {
  for (const { from } of carried) {
    assert.match(stage, new RegExp(`path\\.join\\(staged, '${from}'`), `stages ${from}`);
  }
});

test('the first run reads them from the same names', () => {
  for (const { to } of carried) {
    assert.match(firstRun, new RegExp(`join\\(env\\.resources, '${to}'\\)`), `reads ${to}`);
  }
});

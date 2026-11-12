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

/** Width and height of a PNG, from its header. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('the disk image opens as the install window: Patch, an Applications shortcut and a background the size of the window', () => {
  const dmg = /\ndmg:\n([\s\S]*?)\n(?=\S)/.exec(yml)?.[1] ?? '';
  assert.match(dmg, /background: build\/background\.png/);
  assert.match(dmg, /type: link\n\s+path: \/Applications/);
  const width = Number(/width: (\d+)/.exec(dmg)?.[1]);
  const height = Number(/height: (\d+)/.exec(dmg)?.[1]);
  assert.deepEqual(pngSize(join(root, 'build', 'background.png')), [width, height]);
  assert.deepEqual(pngSize(join(root, 'build', 'background@2x.png')), [width * 2, height * 2]);
});

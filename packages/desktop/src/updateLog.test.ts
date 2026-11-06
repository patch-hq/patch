import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendUpdateLog,
  findUpdateProblems,
  MAX_LOG_ENTRIES,
  parseUpdateLog,
  relaunchesSinceInstall,
} from './updateLog';

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      readFile: (p: string) => files.get(p) ?? null,
      writeFile: (p: string, d: string) => void files.set(p, d),
      rename: (a: string, b: string) => {
        files.set(b, files.get(a) as string);
        files.delete(a);
      },
    },
  };
}
const T = '2026-11-06T10:00:00.000Z';

test('a press followed by one launch counts exactly one relaunch', () => {
  const { fs, files } = memFs();
  appendUpdateLog('l', '0.1.1', 'launch', '', T, fs);
  appendUpdateLog('l', '0.1.1', 'install-requested', '0.1.2', T, fs);
  const e = appendUpdateLog('l', '0.1.2', 'launch', '', T, fs);
  assert.equal(e.relaunches, 1);
  const entries = parseUpdateLog(files.get('l') as string);
  assert.equal(relaunchesSinceInstall(entries), 1);
  assert.deepEqual(findUpdateProblems(entries), []);
});

test('two launches after one press is reported as a problem', () => {
  const { fs, files } = memFs();
  appendUpdateLog('l', '0.1.1', 'install-requested', '0.1.2', T, fs);
  appendUpdateLog('l', '0.1.2', 'launch', '', T, fs);
  appendUpdateLog('l', '0.1.2', 'launch', '', T, fs);
  const problems = findUpdateProblems(parseUpdateLog(files.get('l') as string));
  assert.equal(problems.length, 1);
  assert.match(problems[0] as string, /restarted 2 times/);
});

test('lost-connection wording on a banner is reported', () => {
  const { fs, files } = memFs();
  appendUpdateLog('l', '0.1.1', 'banner', 'Lost connection. Reconnecting…', T, fs);
  const problems = findUpdateProblems(parseUpdateLog(files.get('l') as string));
  assert.match(problems[0] as string, /Lost connection/);
});

test('log is bounded and a corrupt line stays visible', () => {
  const { fs, files } = memFs();
  files.set('l', 'not json\n');
  for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) appendUpdateLog('l', 'v', 'check', `${i}`, T, fs);
  const entries = parseUpdateLog(files.get('l') as string);
  assert.equal(entries.length, MAX_LOG_ENTRIES);
  assert.equal(entries.at(-1)?.detail, `${MAX_LOG_ENTRIES + 4}`);
  const { fs: fs2, files: f2 } = memFs();
  f2.set('l', 'not json\n');
  appendUpdateLog('l', 'v', 'check', 'x', T, fs2);
  assert.match(parseUpdateLog(f2.get('l') as string)[0]?.detail as string, /unreadable/);
});

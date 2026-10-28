import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { classifyLabels, watchSpeakers, type SpeakerSnapshot } from './meeting-speakers';

function fakeChild(): ChildProcessWithoutNullStreams & EventEmitter {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter;
  (child as { stdout: unknown }).stdout = new EventEmitter();
  (child as { stderr: unknown }).stderr = new EventEmitter();
  (child as { kill: unknown }).kill = () => child.emit('exit', null, 'SIGTERM');
  return child;
}

test('classifyLabels: names speakers and participants, drops the local user', () => {
  const got = classifyLabels([
    'Priya Shah (Host), Unmuted, Video on',
    'Dev, Muted',
    'Dev is speaking',
    'Active speaker: Marta',
    'Tom Chambers (Me), Unmuted',
    'Tom Chambers (Me), speaking',
    'Leave',
    '',
  ]);
  assert.deepEqual(got.speaking, ['Dev', 'Marta']);
  assert.deepEqual(got.participants, ['Dev', 'Marta', 'Priya Shah']);
});

test('classifyLabels: control labels are not people', () => {
  const got = classifyLabels([
    'Start speaking',
    'Start talking',
    'Stop speaking',
    'Start, speaking',
    'Start, Muted',
    'Priya, Muted',
  ]);
  assert.deepEqual(got.speaking, []);
  assert.deepEqual(got.participants, ['Priya']);
});

test('classifyLabels: ignores labels that merely contain the word', () => {
  assert.deepEqual(classifyLabels(['Speaking notes', 'Start talking points']), {
    participants: [],
    speaking: [],
  });
});

test('watchSpeakers: reports only changes and surfaces an unasked exit', () => {
  const child = fakeChild();
  const seen: SpeakerSnapshot[] = [];
  let failed = '';
  watchSpeakers(
    '/bin/helper',
    { onSnapshot: (s) => seen.push(s), onFailed: (m) => (failed = m) },
    () => child,
  );
  const line = (labels: string[]): Buffer => Buffer.from(`${JSON.stringify({ labels })}\n`);
  child.stdout.emit('data', line(['Dev, Muted']));
  child.stdout.emit('data', line(['Dev, Muted']));
  child.stdout.emit('data', line(['Dev, Muted', 'Dev is speaking']));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]?.speaking, ['Dev']);
  child.stderr.emit('data', Buffer.from('patch-audio: Accessibility is not allowed\n'));
  child.emit('exit', 1, null);
  assert.match(failed, /Accessibility is not allowed/);
});

test('watchSpeakers: a stop is not a failure; bad output is', () => {
  const child = fakeChild();
  let failed = '';
  const stop = watchSpeakers(
    '/bin/helper',
    { onSnapshot: () => undefined, onFailed: (m) => (failed = m) },
    () => child,
  );
  child.stdout.emit('data', Buffer.from('nope\n'));
  assert.match(failed, /unreadable speakers output/);
  failed = '';
  stop();
  assert.equal(failed, '');
});

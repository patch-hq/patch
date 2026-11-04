import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MeetingRecorder } from './meeting-recording';

test('writes one valid WAV per lane with the header length fixed on end', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'rec-')), 'meeting');
  const r = new MeetingRecorder(dir);
  r.append('system', Buffer.alloc(100));
  r.append('system', Buffer.alloc(50));
  r.append('mic-raw', Buffer.alloc(20));
  r.end();
  assert.deepEqual(readdirSync(dir).sort(), ['mic-raw.wav', 'system.wav']);
  const wav = readFileSync(join(dir, 'system.wav'));
  assert.equal(wav.length, 44 + 150);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 150);
  assert.equal(wav.readUInt32LE(4), 36 + 150);
  assert.equal(wav.readUInt32LE(24), 16000);
});

test('drops a half sample and rejects an unknown lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const r = new MeetingRecorder(dir);
  r.append('mic-clean', Buffer.alloc(11));
  r.end();
  assert.equal(readFileSync(join(dir, 'mic-clean.wav')).readUInt32LE(40), 10);
  assert.throws(() => r.append('bogus', Buffer.alloc(2)), /unknown recording lane/);
});

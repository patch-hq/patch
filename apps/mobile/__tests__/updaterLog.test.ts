// lib/updaterLog.ts — the phone's persistent updater log.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('expo-updates', () => ({ updateId: 'u1' }));

import {
  clearUpdaterLog,
  findUpdaterProblems,
  logPromptChange,
  logUpdater,
  readUpdaterLog,
  relaunchesSinceInstall,
  updaterLogText,
} from '../src/lib/updaterLog';
import { store } from '../src/lib/credential';

beforeEach(() => clearUpdaterLog());

describe('updaterLog', () => {
  it('counts exactly one relaunch after one install press', () => {
    logUpdater('launch', 'app started');
    logUpdater('install-requested', 'Restart to update pressed');
    const e = logUpdater('launch', 'app started');
    expect(e.relaunches).toBe(1);
    expect(relaunchesSinceInstall(readUpdaterLog())).toBe(1);
    expect(findUpdaterProblems(readUpdaterLog())).toEqual([]);
  });

  it('flags two launches after one press', () => {
    logUpdater('install-requested', 'x');
    logUpdater('launch', '');
    logUpdater('launch', '');
    expect(findUpdaterProblems(readUpdaterLog())[0]).toMatch(/restarted 2 times/);
  });

  it('flags lost-connection wording on a banner', () => {
    logUpdater('banner', 'Lost connection. Reconnecting…');
    expect(findUpdaterProblems(readUpdaterLog())[0]).toMatch(/Lost connection/);
  });

  it('logs prompt shown once, then cleared, and ignores repeats', () => {
    logPromptChange('apk', 'Install Patch 0.1.5');
    logPromptChange('apk', 'Install Patch 0.1.5');
    logPromptChange('apk', null);
    logPromptChange('apk', null);
    expect(readUpdaterLog().map((e) => e.event)).toEqual([
      'prompt-shown',
      'banner',
      'prompt-cleared',
    ]);
  });

  it('does not log a clear for a prompt that never showed', () => {
    logPromptChange('apk', null);
    expect(readUpdaterLog()).toEqual([]);
  });

  it('bounds the log and recovers loudly from corruption', () => {
    for (let i = 0; i < 320; i++) logUpdater('check', `${i}`);
    expect(readUpdaterLog()).toHaveLength(300);
    store().set('patch.updaterLog.v1', '{broken');
    expect(readUpdaterLog()[0]?.detail).toMatch(/unreadable/);
    expect(updaterLogText()).toMatch(/relaunches=0/);
  });
});

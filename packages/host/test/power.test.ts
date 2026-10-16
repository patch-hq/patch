import { describe, it, expect } from 'vitest';
import { parsePmsetBatt, readPowerLinux, createPowerWatcher } from '../src/power.js';

describe('parsePmsetBatt', () => {
  it('reads battery power and charge', () => {
    const out = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t1%; discharging; 0:02 remaining present: true\n`;
    expect(parsePmsetBatt(out)).toEqual({ onBattery: true, percent: 1 });
  });
  it('reads AC power', () => {
    const out = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t83%; charging; 1:10 remaining present: true\n`;
    expect(parsePmsetBatt(out)).toEqual({ onBattery: false, percent: 83 });
  });
  it('is undefined for a machine with no battery', () => {
    expect(parsePmsetBatt(`Now drawing from 'AC Power'\n`)).toBeUndefined();
  });
  it('throws on output it does not understand', () => {
    expect(() => parsePmsetBatt('garbage -InternalBattery-0 nonsense')).toThrow(/pmset/);
  });
});

describe('readPowerLinux', () => {
  it('reads capacity and status from sysfs', () => {
    const files: Record<string, string> = {
      '/p/BAT0/type': 'Battery\n',
      '/p/BAT0/capacity': '15\n',
      '/p/BAT0/status': 'Discharging\n',
    };
    const fs = {
      list: () => ['BAT0', 'AC'],
      read: (f: string) => {
        if (!(f in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return files[f]!;
      },
    };
    expect(readPowerLinux('/p', fs)).toEqual({ onBattery: true, percent: 15 });
  });
  it('is undefined with no battery', () => {
    expect(readPowerLinux('/p', { list: () => ['AC'], read: () => 'Mains\n' })).toBeUndefined();
  });
});

describe('createPowerWatcher', () => {
  it('calls onChange only when the state changes', async () => {
    const seq = [
      { onBattery: false, percent: 90 },
      { onBattery: false, percent: 90 },
      { onBattery: true, percent: 89 },
    ];
    let i = 0;
    const changes: unknown[] = [];
    const w = createPowerWatcher({
      read: async () => seq[i++],
      onChange: () => changes.push(w.current()),
      onError: (e) => {
        throw e;
      },
      intervalMs: 1_000_000,
    });
    await w.poll();
    await w.poll();
    await w.poll();
    expect(changes).toEqual([seq[0], seq[2]]);
  });
});

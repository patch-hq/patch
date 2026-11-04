import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLaunchPath, launchPathFile } from '../src/launchPath.js';

const OLD = '/Users/t/.patch/versions/1/patch-host';
const NEW = '/Users/t/.patch/runtime/Patch Host.app/Contents/MacOS/patch-host';

describe('checkLaunchPath', () => {
  it('records the first start without reporting a change', () => {
    const home = mkdtempSync(join(tmpdir(), 'launch-path-'));
    expect(checkLaunchPath(home, OLD)).toBeUndefined();
    expect(JSON.parse(readFileSync(launchPathFile(home), 'utf8'))).toEqual({ path: OLD });
  });

  it('is quiet when the path is unchanged', () => {
    const home = mkdtempSync(join(tmpdir(), 'launch-path-'));
    checkLaunchPath(home, OLD);
    expect(checkLaunchPath(home, OLD)).toBeUndefined();
  });

  it('reports a move once, then records the new path', () => {
    const home = mkdtempSync(join(tmpdir(), 'launch-path-'));
    checkLaunchPath(home, OLD);
    expect(checkLaunchPath(home, NEW)).toEqual({ previous: OLD, current: NEW });
    expect(checkLaunchPath(home, NEW)).toBeUndefined();
  });

  it('throws on a corrupt record rather than ignoring it', () => {
    const home = mkdtempSync(join(tmpdir(), 'launch-path-'));
    writeFileSync(launchPathFile(home), '{}');
    expect(() => checkLaunchPath(home, OLD)).toThrow(/missing "path"/);
  });
});

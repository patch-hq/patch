import { describe, expect, it } from 'vitest';
import { prefixKeepingCommandFirst } from '../src/leadCommand.js';
import { WAKE_PREFIX } from '../src/wake.js';

describe('prefixKeepingCommandFirst', () => {
  it('leaves plain text prefixed as before', () => {
    expect(prefixKeepingCommandFirst('[wake] ', 'check the PRs')).toBe('[wake] check the PRs');
  });
  it('returns the text untouched with no prefix', () => {
    expect(prefixKeepingCommandFirst('', '/cadence-pr-monitor go')).toBe('/cadence-pr-monitor go');
  });
  it('keeps a leading slash command first and moves the prefix into its args', () => {
    expect(prefixKeepingCommandFirst('[wake] ', '/cadence-pr-monitor\n\nrun it')).toBe(
      '/cadence-pr-monitor [wake] run it',
    );
  });
  it('keeps a bare command first', () => {
    expect(prefixKeepingCommandFirst(`${WAKE_PREFIX} `, '/loop')).toBe('/loop [wake] ');
  });
  it('keeps a multi-line reminder block behind the command', () => {
    const out = prefixKeepingCommandFirst('<system-reminder>x</system-reminder>\n', '/skill do it');
    expect(out.startsWith('/skill ')).toBe(true);
    expect(out).toContain('<system-reminder>x</system-reminder>\ndo it');
  });
  it('does not treat an absolute path as a command', () => {
    expect(prefixKeepingCommandFirst('[wake] ', '/tmp/x is full')).toBe(
      '[wake] /tmp/x is full'.replace('/tmp/x', '/tmp/x'),
    );
  });
});

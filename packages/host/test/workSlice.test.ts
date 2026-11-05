import { describe, expect, it } from 'vitest';
import { inWorkSlice } from '../src/workSlice.js';

describe('inWorkSlice', () => {
  it('leaves the command alone when no slice is configured', () => {
    expect(inWorkSlice('/bin/claude', ['--flag'], {})).toEqual({
      command: '/bin/claude',
      args: ['--flag'],
    });
  });

  it('treats an empty setting as not configured', () => {
    expect(inWorkSlice('/bin/claude', [], { PATCH_WORK_SLICE: '' }).command).toBe('/bin/claude');
  });

  it('runs the command in a transient scope in the configured slice', () => {
    expect(
      inWorkSlice('/bin/claude', ['--flag', '--', 'x y'], { PATCH_WORK_SLICE: 'patch-work.slice' }),
    ).toEqual({
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--slice=patch-work.slice',
        '--',
        '/bin/claude',
        '--flag',
        '--',
        'x y',
      ],
    });
  });
});

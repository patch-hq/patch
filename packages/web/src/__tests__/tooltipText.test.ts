import { describe, it, expect } from 'vitest';
import { fitTooltipText, TOOLTIP_MAX_CHARS } from '../lib/tooltipText.js';

describe('fitTooltipText', () => {
  it('leaves short copy alone', () => {
    expect(fitTooltipText('Archive')).toBe('Archive');
  });
  it('keeps the last two segments of a long path', () => {
    expect(fitTooltipText('/home/claude-dev/projects/portfolio/projects/patch/packages')).toBe(
      '…/patch/packages',
    );
  });
  it('never exceeds the limit', () => {
    expect(
      fitTooltipText('/' + 'a'.repeat(100) + '/' + 'b'.repeat(100)).length,
    ).toBeLessThanOrEqual(TOOLTIP_MAX_CHARS);
    expect(fitTooltipText('word '.repeat(50)).length).toBeLessThanOrEqual(TOOLTIP_MAX_CHARS);
  });
});

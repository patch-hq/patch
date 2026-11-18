import { describe, it, expect } from 'vitest';
import { fenceBoxDrawing } from '../src/lib/boxDrawing';

describe('fenceBoxDrawing', () => {
  it('leaves ordinary text alone', () => {
    expect(fenceBoxDrawing('a | b\n---|---\n1 | 2')).toBe('a | b\n---|---\n1 | 2');
  });
  it('fences a run of box-drawing lines', () => {
    const t = 'PRs:\n┌──┬──┐\n│ a│ b│\n└──┴──┘\nDone';
    expect(fenceBoxDrawing(t)).toBe('PRs:\n```\n┌──┬──┐\n│ a│ b│\n└──┴──┘\n```\nDone');
  });
  it('closes a run that ends the message', () => {
    expect(fenceBoxDrawing('┌─┐\n└─┘')).toBe('```\n┌─┐\n└─┘\n```');
  });
  it('does not double-fence an existing fence', () => {
    const t = '```\n┌─┐\n└─┘\n```';
    expect(fenceBoxDrawing(t)).toBe(t);
  });
});

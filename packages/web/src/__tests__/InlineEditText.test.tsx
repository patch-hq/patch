// InlineEditText — click-to-edit text. Enter commits, but not the Enter that picks an IME candidate.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InlineEditText } from '../components/InlineEditText.js';

afterEach(cleanup);

function open(onCommit: (s: string) => void) {
  render(
    <InlineEditText
      value="old"
      onCommit={onCommit}
      className="x"
      editLabel="Edit goal"
      testId="t"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
  const input = screen.getByRole('textbox', { name: 'Edit goal' });
  fireEvent.change(input, { target: { value: 'にほん' } });
  return input;
}

describe('InlineEditText', () => {
  it('commits on Enter', () => {
    const onCommit = vi.fn();
    fireEvent.keyDown(open(onCommit), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('にほん');
  });

  it('does not commit on the Enter that confirms an IME composition', () => {
    const onCommit = vi.fn();
    fireEvent.keyDown(open(onCommit), { key: 'Enter', isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

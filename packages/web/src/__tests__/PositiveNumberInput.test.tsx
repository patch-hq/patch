// A settings number field that can be cleared and retyped (it used to snap back
// to the stored value on every keystroke that was not already a valid number).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PositiveNumberInput } from '../routes/settings/PositiveNumberInput.js';

afterEach(cleanup);

function setup(over: { integer?: boolean } = {}) {
  const onCommit = vi.fn();
  render(
    <PositiveNumberInput
      value={30}
      onCommit={onCommit}
      ariaLabel="Interval"
      testid="n"
      {...over}
    />,
  );
  return { input: screen.getByTestId('n') as HTMLInputElement, onCommit };
}

describe('PositiveNumberInput', () => {
  it('can be cleared and retyped without committing the empty value', () => {
    const { input, onCommit } = setup();
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '45' } });
    expect(input.value).toBe('45');
    expect(onCommit).toHaveBeenCalledWith(45);
  });

  it('never commits zero, a negative or (when integer) a fraction, and shows the stored value again on blur', () => {
    const { input, onCommit } = setup({ integer: true });
    for (const bad of ['0', '-3', '2.5']) fireEvent.change(input, { target: { value: bad } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('30');
  });
});

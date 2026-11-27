import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BatchIntervalSlider, intervalLabel } from '../routes/settings/BatchIntervalSlider.js';

afterEach(() => vi.useRealTimers());

describe('intervalLabel', () => {
  it('names minutes, hours and a day', () => {
    expect(intervalLabel(5)).toBe('5 min');
    expect(intervalLabel(30)).toBe('30 min');
    expect(intervalLabel(120)).toBe('2 h');
    expect(intervalLabel(1440)).toBe('a day');
  });
});

describe('BatchIntervalSlider', () => {
  it('starts at 5 minutes: there is no Instant stop', () => {
    render(<BatchIntervalSlider value={5} onCommit={() => {}} testid="d" />);
    expect((screen.getByTestId('d') as HTMLInputElement).value).toBe('0');
    expect(screen.getByTestId('d-label').textContent).toBe('5 min');
  });

  it('writes once when the slider settles, not once per step it passes', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<BatchIntervalSlider value={30} onCommit={onCommit} testid="d" />);
    const input = screen.getByTestId('d');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.change(input, { target: { value: '7' } });
    expect(screen.getByTestId('d-label').textContent).toBe('a day');
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1440);
  });

  it('a stored value that is not a step is still shown as it is', () => {
    render(<BatchIntervalSlider value={45} onCommit={() => {}} testid="d" />);
    expect(screen.getByTestId('d-label').textContent).toBe('45 min');
  });
});

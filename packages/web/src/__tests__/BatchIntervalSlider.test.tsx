import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DeliverySlider, deliveryLabel } from '../routes/settings/DeliverySlider.js';

afterEach(() => vi.useRealTimers());

describe('deliveryLabel', () => {
  it('names the instant end and the batched steps', () => {
    expect(deliveryLabel(0)).toBe('Instant');
    expect(deliveryLabel(30)).toBe('Digest every 30 min');
    expect(deliveryLabel(120)).toBe('Digest every 2 h');
    expect(deliveryLabel(1440)).toBe('Digest every day');
  });
});

describe('DeliverySlider', () => {
  it('shows the stored value, Instant at the left end', () => {
    render(<DeliverySlider value={0} onCommit={() => {}} testid="d" />);
    expect((screen.getByTestId('d') as HTMLInputElement).value).toBe('0');
    expect(screen.getByTestId('d-label').textContent).toBe('Instant');
  });

  it('writes once when the slider settles, not once per step it passes', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<DeliverySlider value={30} onCommit={onCommit} testid="d" />);
    const input = screen.getByTestId('d');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByTestId('d-label').textContent).toBe('Instant');
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it('a stored value that is not a step is still shown as it is', () => {
    render(<DeliverySlider value={45} onCommit={() => {}} testid="d" />);
    expect(screen.getByTestId('d-label').textContent).toBe('Digest every 45 min');
  });
});

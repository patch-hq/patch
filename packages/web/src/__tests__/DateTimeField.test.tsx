import { useState, type JSX } from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DateTimeField } from '../components/DateTimeField.js';

function Harness({ initial = '' }: { initial?: string }): JSX.Element {
  const [v, setV] = useState(initial);
  return (
    <>
      <DateTimeField label="Starts" value={v} onChange={setV} testId="dt" />
      <output data-testid="out">{v}</output>
    </>
  );
}

describe('DateTimeField', () => {
  it('renders no native datetime-local input', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it('shows a custom calendar popover and picks a day', () => {
    render(<Harness initial="2027-05-01T16:30" />);
    expect(screen.queryByTestId('dt-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('dt-open'));
    expect(screen.getByTestId('dt-month').textContent).toContain('May 2027');
    fireEvent.click(screen.getByTestId('dt-day-2027-05-14'));
    expect(screen.getByTestId('out').textContent).toBe('2027-05-14T16:30');
  });

  it('navigates months', () => {
    render(<Harness initial="2027-05-01T16:30" />);
    fireEvent.click(screen.getByTestId('dt-open'));
    fireEvent.click(screen.getByTestId('dt-next'));
    expect(screen.getByTestId('dt-month').textContent).toContain('June 2027');
    fireEvent.click(screen.getByTestId('dt-prev'));
    fireEvent.click(screen.getByTestId('dt-prev'));
    expect(screen.getByTestId('dt-month').textContent).toContain('April 2027');
  });

  it('changes the time and defaults it to 09:00 when picking a day on an empty field', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('dt-open'));
    fireEvent.click(screen.getAllByRole('button', { name: /^\d+$/ })[9]!);
    expect(screen.getByTestId('out').textContent).toMatch(/T09:00$/);
    // 09:00 is AM: pick 5 (05:00), flip to PM (17:00), then the minutes step is up.
    fireEvent.click(screen.getByTestId('dt-time-h-5'));
    expect(screen.getByTestId('out').textContent).toMatch(/T05:00$/);
    fireEvent.click(screen.getByTestId('dt-time-pm'));
    expect(screen.getByTestId('out').textContent).toMatch(/T17:00$/);
    fireEvent.click(screen.getByTestId('dt-time-m-45'));
    expect(screen.getByTestId('out').textContent).toMatch(/T17:45$/);
  });

  it('accepts typed values (T or space separated) and clears', () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId('dt'), { target: { value: '2027-05-01T16:00' } });
    expect(screen.getByTestId('out').textContent).toBe('2027-05-01T16:00');
    fireEvent.change(screen.getByTestId('dt'), { target: { value: '2027-06-02 08:15' } });
    expect(screen.getByTestId('out').textContent).toBe('2027-06-02T08:15');
    fireEvent.click(screen.getByTestId('dt-open'));
    fireEvent.click(screen.getByTestId('dt-clear'));
    expect(screen.getByTestId('out').textContent).toBe('');
  });

  it('closes on Escape', () => {
    render(<Harness initial="2027-05-01T16:30" />);
    fireEvent.click(screen.getByTestId('dt-open'));
    fireEvent.keyDown(screen.getByTestId('dt-popover'), { key: 'Escape' });
    expect(screen.queryByTestId('dt-popover')).toBeNull();
  });
});

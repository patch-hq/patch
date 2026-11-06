import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WindowedRows } from '../components/WindowedRows.js';

const items = Array.from({ length: 2000 }, (_, i) => `row-${i}`);

describe('WindowedRows', () => {
  it('draws a small window of a 2,000-row list, not all of it', () => {
    render(
      <div data-scroll-host>
        <WindowedRows
          items={items}
          itemKey={(k) => k}
          renderItem={(k) => <span data-testid="r">{k}</span>}
        />
      </div>,
    );
    const drawn = screen.getAllByTestId('r').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(60);
    expect(screen.getByText('row-0')).toBeInTheDocument();
  });

  it('fails loudly with no scroll host', () => {
    expect(() =>
      render(<WindowedRows items={['a']} itemKey={(k) => k} renderItem={(k) => <i>{k}</i>} />),
    ).toThrow(/data-scroll-host/);
  });
});

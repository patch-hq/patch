// spec/14 § Main chat panel — Status list: every row under the chat header is one
// grid anatomy (icon | label | content | meta | action); a folded group's leading
// count is a pill button with a chevron that opens and closes it.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusPill, StatusRow } from '../components/StatusRow.js';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('StatusRow', () => {
  it('draws icon, label, content, meta and action in that order', () => {
    render(
      <StatusRow
        icon={<i data-testid="i" />}
        label="Agent"
        meta="2m"
        action={<button type="button">x</button>}
        testId="row"
      >
        Reviewing
      </StatusRow>,
    );
    const kids = Array.from(screen.getByTestId('row').children).map((c) => c.className);
    expect(kids).toEqual([
      'status-row-icon',
      'status-row-label',
      'status-row-content',
      'status-row-meta',
      'status-row-action',
    ]);
    expect(screen.getByTestId('row').textContent).toContain('Agent');
    expect(screen.getByTestId('row').textContent).toContain('Reviewing');
  });

  it('a nested row leaves icon and label empty', () => {
    render(
      <StatusRow nested testId="row">
        child
      </StatusRow>,
    );
    const row = screen.getByTestId('row');
    expect(row.className).toContain('status-row-nested');
    expect(row.querySelector('.status-row-icon')?.textContent).toBe('');
    expect(row.querySelector('.status-row-label')?.textContent).toBe('');
  });

  it('marks quiet meta so a phone can hide it', () => {
    render(
      <StatusRow meta="12:04" quietMeta testId="row">
        x
      </StatusRow>,
    );
    expect(screen.getByTestId('row').querySelector('.status-row-meta')?.className).toContain(
      'status-row-meta-quiet',
    );
  });
});

describe('StatusPill', () => {
  it('is a button that reports open state and toggles', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <StatusPill open={false} onToggle={onToggle} label="Toggle agents" testId="pill">
        3 running
      </StatusPill>,
    );
    const pill = screen.getByTestId('pill');
    expect(pill.tagName).toBe('BUTTON');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(pill);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <StatusPill open onToggle={onToggle} label="Toggle agents" testId="pill">
        3 running
      </StatusPill>,
    );
    expect(screen.getByTestId('pill').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('status list stylesheet', () => {
  it('uses the specified grid, one divider and the phone rule', () => {
    expect(css).toMatch(
      /\.status-row\s*{[^}]*grid-template-columns:\s*16px 72px minmax\(0, 1fr\) auto 20px/,
    );
    expect(css).toMatch(/\.status-row\s*{[^}]*min-height:\s*32px/);
    expect(css).toMatch(/\.status-list\s*{[^}]*border-bottom:\s*1px solid var\(--line\)/);
    expect(css).toMatch(
      /@media \(max-width: 600px\)\s*{\s*\.status-row\s*{[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\)/,
    );
  });
});

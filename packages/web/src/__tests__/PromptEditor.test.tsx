import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { PromptEditor, findMatches } from '../components/PromptEditor.js';

function Harness({ initial }: { initial: string }): JSX.Element {
  const [v, setV] = useState(initial);
  return <PromptEditor value={v} onChange={setV} testid="p" />;
}

describe('findMatches', () => {
  it('is case-insensitive, non-overlapping, and empty for an empty query', () => {
    expect(findMatches('Foo foo FOO', 'foo')).toEqual([0, 4, 8]);
    expect(findMatches('aaaa', 'aa')).toEqual([0, 2]);
    expect(findMatches('abc', '')).toEqual([]);
  });
});

describe('PromptEditor', () => {
  it('edits through the textarea', () => {
    render(<Harness initial="" />);
    fireEvent.change(screen.getByTestId('p'), { target: { value: 'hello' } });
    expect((screen.getByTestId('p') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('Preview renders markdown and keeps the text; Write returns to the textarea', () => {
    render(<Harness initial={'# Title\n\n- one\n- two'} />);
    fireEvent.click(screen.getByTestId('p-preview-tab'));
    const prev = screen.getByTestId('p-preview');
    expect(prev.querySelector('h1')?.textContent).toBe('Title');
    expect(prev.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByTestId('p')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('p-write'));
    expect(screen.getByTestId('p')).toBeVisible();
    expect((screen.getByTestId('p') as HTMLTextAreaElement).value).toContain('# Title');
  });

  it('Find counts matches, steps with Enter, wraps, and selects the match', () => {
    render(<Harness initial="cat dog cat bird Cat" />);
    fireEvent.click(screen.getByTestId('p-find-toggle'));
    const input = screen.getByTestId('p-find-input');
    fireEvent.change(input, { target: { value: 'cat' } });
    expect(screen.getByTestId('p-find-count').textContent).toBe('1 of 3');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('p-find-count').textContent).toBe('2 of 3');
    const area = screen.getByTestId('p') as HTMLTextAreaElement;
    expect([area.selectionStart, area.selectionEnd]).toEqual([8, 11]);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('p-find-count').textContent).toBe('1 of 3');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('p-find-count').textContent).toBe('3 of 3');
  });

  it('says so when nothing matches, and Escape closes the bar', () => {
    render(<Harness initial="abc" />);
    fireEvent.click(screen.getByTestId('p-find-toggle'));
    const input = screen.getByTestId('p-find-input');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByTestId('p-find-count').textContent).toBe('No matches');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('p-find')).toBeNull();
  });

  it('Ctrl+F in the textarea opens Find', () => {
    render(<Harness initial="abc" />);
    fireEvent.keyDown(screen.getByTestId('p'), { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('p-find')).toBeTruthy();
  });
});

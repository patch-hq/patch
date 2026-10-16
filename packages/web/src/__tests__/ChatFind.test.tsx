// ChatFind — the find bar over a chat's transcript (spec/14 § Find in chat).

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { ChatFind } from '../components/ChatFind.js';

// jsdom has neither the CSS Custom Highlight API nor range geometry.
beforeEach(() => {
  (globalThis as { CSS?: unknown }).CSS = {
    highlights: { set: () => undefined, delete: () => undefined },
  };
  (globalThis as { Highlight?: unknown }).Highlight = class {};
  (Range.prototype as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    top: 0,
    height: 0,
  });
});
afterEach(cleanup);

function setup(paragraphs: string[]) {
  const stream = document.createElement('div');
  stream.innerHTML = paragraphs.map((p) => `<p>${p}</p>`).join('');
  document.body.appendChild(stream);
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement | null }).current = stream;
  const view = render(<ChatFind streamRef={ref} contentVersion={1} />);
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
  });
  return { stream, ref, view };
}

describe('ChatFind', () => {
  it('stays on the current match when the transcript grows under an unchanged query', () => {
    const { stream, ref, view } = setup(['a cat', 'another cat', 'the third cat']);
    const input = screen.getByTestId('chat-find-input');
    fireEvent.change(input, { target: { value: 'cat' } });
    expect(screen.getByTestId('chat-find-count').textContent).toBe('1/3');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('chat-find-count').textContent).toBe('3/3');

    // A reply streams in: the transcript changes, the query does not.
    stream.insertAdjacentHTML('beforeend', '<p>no match here</p>');
    view.rerender(<ChatFind streamRef={ref} contentVersion={2} />);
    expect(screen.getByTestId('chat-find-count').textContent).toBe('3/3');
    stream.remove();
  });

  it('goes back to the first match when the query changes', () => {
    const { stream } = setup(['a cat', 'another cat', 'a cow']);
    const input = screen.getByTestId('chat-find-input');
    fireEvent.change(input, { target: { value: 'cat' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('chat-find-count').textContent).toBe('2/2');
    fireEvent.change(input, { target: { value: 'c' } });
    expect(screen.getByTestId('chat-find-count').textContent).toBe('1/3');
    stream.remove();
  });
});

// spec/14 § Composer — quotes: leading `> ` blocks of the draft are cards
// stacked above the input; the textarea holds only what the user types.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';

function renderComposer(initialValue: string, onSend = vi.fn()): HTMLTextAreaElement {
  render(
    <Composer
      chatId="c1"
      hostId="d1"
      folder="/proj"
      initialValue={initialValue}
      onSend={onSend}
      onStartVoiceNote={() => {}}
    />,
  );
  return screen.getByTestId('composer-input') as HTMLTextAreaElement;
}

describe('Composer — quote cards', () => {
  afterEach(cleanup);

  it('draws each leading quote as a card and keeps them out of the textarea', () => {
    const input = renderComposer('> one\n\n> two\n> lines\n\nmy question');
    const cards = screen.getAllByTestId('composer-quote');
    expect(cards.map((c) => c.textContent)).toEqual(['one', 'two\nlines']);
    expect(input.value).toBe('my question');
  });

  it('shows no quote area without quotes', () => {
    renderComposer('just text');
    expect(screen.queryByTestId('composer-quotes')).toBeNull();
  });

  it('removes one quote and leaves the rest', () => {
    const input = renderComposer('> one\n\n> two\n\nask');
    fireEvent.click(screen.getAllByTestId('composer-quote-remove')[0] as HTMLElement);
    expect(screen.getAllByTestId('composer-quote').map((c) => c.textContent)).toEqual(['two']);
    expect(input.value).toBe('ask');
  });

  it('sends the quotes together with the typed text', () => {
    const onSend = vi.fn();
    const input = renderComposer('> one\n\n', onSend);
    fireEvent.change(input, { target: { value: 'why?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('> one\n\nwhy?');
  });
});

describe('Composer — reply to one quote, then another', () => {
  afterEach(cleanup);

  it('draws quotes and the replies under them, with the last reply in the textarea', () => {
    const input = renderComposer('> one\n\nabout one\n\n> two\n\nabout two');
    expect(screen.getAllByTestId('composer-quote').map((c) => c.textContent)).toEqual([
      'one',
      'two',
    ]);
    expect((screen.getByTestId('composer-reply') as HTMLTextAreaElement).value).toBe('about one');
    expect(input.value).toBe('about two');
  });

  it('edits an earlier reply in place and sends the whole thread', () => {
    const onSend = vi.fn();
    const input = renderComposer('> one\n\nabout one\n\n> two\n\nabout two', onSend);
    fireEvent.change(screen.getByTestId('composer-reply'), { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('> one\n\nchanged\n\n> two\n\nabout two');
  });

  it('removing a quote takes its reply with it', () => {
    const input = renderComposer('> one\n\nabout one\n\n> two\n\nabout two');
    fireEvent.click(screen.getAllByTestId('composer-quote-remove')[0] as HTMLElement);
    expect(screen.getAllByTestId('composer-quote').map((c) => c.textContent)).toEqual(['two']);
    expect(screen.queryByTestId('composer-reply')).toBeNull();
    expect(input.value).toBe('about two');
  });
});

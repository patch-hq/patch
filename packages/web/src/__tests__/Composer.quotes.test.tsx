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

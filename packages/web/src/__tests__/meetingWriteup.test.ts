// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { itemHtml, writeupBodyHtml, writeupFromBody, writeupText } from '../lib/meetingWriteup.js';

const w = {
  title: 'Rollout call',
  sections: [
    {
      heading: 'Where we landed',
      items: [{ text: 'Stay positive', mine: true }, { text: 'Weka funds <the> bus' }],
    },
  ],
};

const body = (html: string): HTMLElement => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
};

describe('meeting write-up body', () => {
  it('underlines fixed names with the original, escaping everything else', () => {
    const html = itemHtml('WECA funds <b>', [{ from: 'Weka', to: 'WECA' }]);
    expect(html).toBe('<span class="fixed" title="was: Weka">WECA</span> funds &lt;b&gt;');
    expect(itemHtml('WECAs are fine', [{ from: 'x', to: 'WECA' }])).toBe('WECAs are fine');
  });

  it('round-trips untouched, keeping who wrote each line', () => {
    expect(writeupFromBody(w.title, body(writeupBodyHtml(w, [])))).toEqual(w);
  });

  it('an edited or new bullet becomes mine, an emptied one is dropped', () => {
    const el = body(writeupBodyHtml(w, []));
    const li = el.querySelectorAll('li');
    li[1]!.textContent = 'Weka funds the bus by March';
    li[0]!.textContent = '';
    const extra = document.createElement('li');
    extra.textContent = 'Ask about budget';
    el.querySelector('ul')!.appendChild(extra);
    expect(writeupFromBody('T', el).sections[0]!.items).toEqual([
      { text: 'Weka funds the bus by March', mine: true },
      { text: 'Ask about budget', mine: true },
    ]);
  });

  it('reads a section Tom added with a heading', () => {
    const el = body(writeupBodyHtml(w, []) + '<h2>Next</h2><ul><li>Call Sam</li></ul>');
    expect(writeupFromBody('T', el).sections[1]).toEqual({
      heading: 'Next',
      items: [{ text: 'Call Sam', mine: true }],
    });
  });

  it('copies as plain text', () => {
    expect(writeupText(w, '20 Oct · 5 min')).toBe(
      'Rollout call\n20 Oct · 5 min\n\nWhere we landed\n- Stay positive\n- Weka funds <the> bus',
    );
  });
});

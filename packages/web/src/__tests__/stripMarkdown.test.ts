import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../lib/stripMarkdown';

describe('stripMarkdown', () => {
  it('flattens emphasis, headings and links', () => {
    expect(stripMarkdown('# Title\n**bold** and *it* [link](http://x.y)')).toBe(
      'Title bold and it link',
    );
  });

  it('drops a link url that has brackets of its own', () => {
    expect(stripMarkdown('[link](http://x.com/a_(b))')).toBe('link');
    expect(stripMarkdown('see [w](https://en.wikipedia.org/wiki/Foo_(bar)) here')).toBe(
      'see w here',
    );
  });

  it('keeps underscores inside identifiers and urls', () => {
    expect(stripMarkdown('see my_file_name.txt and snake_case_var')).toBe(
      'see my_file_name.txt and snake_case_var',
    );
    expect(stripMarkdown('https://x.com/a_b_c')).toBe('https://x.com/a_b_c');
  });

  it('still strips underscore emphasis around whole words', () => {
    expect(stripMarkdown('an _italic_ and __bold__ word')).toBe('an italic and bold word');
  });

  it('keeps #, > and ~ that are text rather than markup', () => {
    expect(stripMarkdown('Port it to C# and F#')).toBe('Port it to C# and F#');
    expect(stripMarkdown('saved to ~/projects/app')).toBe('saved to ~/projects/app');
    expect(stripMarkdown('fix #12 and #13')).toBe('fix #12 and #13');
    expect(stripMarkdown('latency a > b now')).toBe('latency a > b now');
  });

  it('still strips strikethrough', () => {
    expect(stripMarkdown('~~gone~~ text')).toBe('gone text');
  });

  it('keeps === and mid-line dashes, but still drops rule and table-delimiter lines', () => {
    expect(stripMarkdown('assert a === b failed')).toBe('assert a === b failed');
    expect(stripMarkdown('wait --- what')).toBe('wait --- what');
    expect(stripMarkdown('above\n\n---\n\nbelow')).toBe('above below');
    expect(stripMarkdown('| a | b |\n| --- | :---: |\n| 1 | 2 |')).toBe('a b 1 2');
  });
});

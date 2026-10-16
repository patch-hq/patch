// lib/markdownIt.ts — run against the REAL markdown-it the markdown library
// ships (the component tests stub the library out, so they cannot see this).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { configureMarkdownIt } from '../src/lib/markdownIt';

type MarkdownItCtor = (opts: { typographer: boolean }) => {
  renderInline(src: string): string;
  disable(rules: string | string[]): unknown;
};

const libRequire = createRequire(
  createRequire(import.meta.url).resolve('react-native-markdown-display/package.json'),
);
const MarkdownIt = libRequire('markdown-it') as MarkdownItCtor;

describe('configureMarkdownIt', () => {
  it('leaves what the agent wrote alone: no © for (c), no dash for --, no ± for +-', () => {
    const md = configureMarkdownIt(MarkdownIt({ typographer: true }));
    expect(md.renderInline('Pick (c) or (r), foo--bar, a +- b, wait...')).toBe(
      'Pick (c) or (r), foo--bar, a +- b, wait...',
    );
  });

  it('keeps the smart quotes the typographer option is there for', () => {
    const md = configureMarkdownIt(MarkdownIt({ typographer: true }));
    expect(md.renderInline('"quoted"')).toBe('“quoted”');
  });

  it('the bare typographer, unconfigured, is what rewrote the text', () => {
    expect(MarkdownIt({ typographer: true }).renderInline('Pick (c)')).toBe('Pick ©');
  });
});

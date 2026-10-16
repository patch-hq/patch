// G2-d1: internal [[…]] control markers must never survive into rendered text.

import { describe, it, expect } from 'vitest';
import { stripControlTokens } from '../lib/controlTokens.js';

describe('stripControlTokens (G2-d1)', () => {
  it('removes a [[permission]] marker and tidies whitespace', () => {
    expect(stripControlTokens('now [[permission]] please')).toBe('now please');
  });

  it('removes a [[edit]] marker mid-sentence', () => {
    expect(stripControlTokens('please [[edit]] the file')).toBe('please the file');
  });

  it('removes the [[edit]] / [[permission]] / [[tool]] / [[bash-permission]] markers', () => {
    for (const t of ['[[edit]]', '[[permission]]', '[[tool]]', '[[bash-permission]]']) {
      expect(stripControlTokens(t)).toBe('');
    }
  });

  it('strips an unknown future [[marker]] too (no regression surface)', () => {
    expect(stripControlTokens('a [[somethingnew]] b')).toBe('a b');
  });

  it('leaves ordinary text (and ordinary brackets) untouched', () => {
    expect(stripControlTokens('see arr[0] and obj[key]')).toBe('see arr[0] and obj[key]');
    expect(stripControlTokens('just a normal message')).toBe('just a normal message');
  });

  it('tidies punctuation adjacency after a removal', () => {
    expect(stripControlTokens('do it [[edit]], now')).toBe('do it, now');
  });

  it('leaves text that has [[ but no control token exactly as written', () => {
    const code = 'if [[ -f x ]]; then\n    echo  hi\nfi';
    expect(stripControlTokens(code)).toBe(code);
  });

  it('leaves [[…]] inside code alone — a TOML array table is content', () => {
    const fenced = 'Add this:\n\n```toml\n[[bin]]\nname = "x"\n```';
    expect(stripControlTokens(fenced)).toBe(fenced);
    expect(stripControlTokens('use `[[redirects]]` here')).toBe('use `[[redirects]]` here');
  });

  it('keeps the indentation of the rest of the message when a marker is removed', () => {
    expect(stripControlTokens('[[edit]] fix this:\n\n    if x:\n        return  1')).toBe(
      'fix this:\n\n    if x:\n        return  1',
    );
    expect(stripControlTokens('[[tool]]\n  indented')).toBe('  indented');
  });
});

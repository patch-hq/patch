// ChatMarkdown.tsx — blockquotes in the transcript. Left to the library's
// default a quote is a #F5F5F5 box: in dark mode that is pale grey text
// (inherited ink) on near-white (Todoist: "blockquotes unreadable in dark
// mode"). The renderer must be handed a quote fill from the theme instead.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderRN } from './testUtils/render';
import { ChatMarkdown } from '../src/components/ChatMarkdown';
import { darkColors, lightColors, type ThemeColors } from '../src/lib/theme';
import { __lastRenderer } from './stubs/markdown-display';
import { __setColorScheme } from './stubs/react-native';

afterEach(() => {
  __setColorScheme('light');
});

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not an opaque #rrggbb colour: ${hex}`);
  const lin = (i: number): number => {
    const s = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

let n = 0;
function quoteStyle(scheme: 'light' | 'dark', colors: ThemeColors): Record<string, unknown> {
  __setColorScheme(scheme);
  n += 1;
  renderRN(<ChatMarkdown content={`> quoted ${n}`} color={colors.ink} />);
  const style = __lastRenderer().style['blockquote'];
  if (!style) throw new Error('ChatMarkdown passes no blockquote style (library default applies)');
  return style;
}

describe('ChatMarkdown — blockquote', () => {
  for (const [scheme, colors] of [
    ['light', lightColors],
    ['dark', darkColors],
  ] as const) {
    it(`${scheme}: quote text is readable on the quote fill, and the fill sits on the theme surface`, () => {
      const s = quoteStyle(scheme, colors);
      const bg = s['backgroundColor'] as string;
      const fg = s['color'] as string;
      expect(bg).toBe(colors.paperRaised);
      expect(fg).toBe(colors.ink);
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      expect(s['borderColor']).toBe(colors.divider);
    });
  }
});

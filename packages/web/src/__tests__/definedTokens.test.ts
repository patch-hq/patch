// spec/14 § Theming — every `var(--token)` must name a token that is actually
// defined, and a token that is defined must not be shadowed by a fallback.
//
// Neither was true. Fourteen names were used and never defined (`--bg`,
// `--bg-1`, `--bg-2`, `--rule`, `--err`, `--ink-1`, `--paper`, `--faded`,
// `--font-mono`, `--bg-hover`, `--bg-subtle`, ...), in two different shapes:
//
//   1. No fallback. An undefined custom property with nothing to fall back on
//      makes its WHOLE declaration invalid at computed-value time, so it paints
//      nothing — silently:
//        .terminal-tab.active { background: var(--bg) }   → the segmented
//                                 control's active pill was invisible
//        .msg-edit-save       { color: var(--bg) }        → inherited --ink on
//                                 the green fill, 3.7:1
//        .terminal-toggle     { border: 1px solid var(--rule) } → no border
//        .model-option:hover  { background: var(--bg-hover, var(--bg-subtle)) }
//                                                         → no hover feedback
//
//   2. With a fallback. These painted, but the fallback is what you were really
//      looking at, so the token was decoration — and several fallbacks were
//      stale literals the palette had long since moved off
//      (`var(--danger, #c0392b)` when --danger is #b4462f, `var(--running,
//      #3a9)` when --running is #4f7a3e). A hardcoded colour behind a token is
//      exactly what spec/14 § Theming forbids: it cannot follow the theme.
//
// Nothing caught any of them — a stylesheet is happy to reference a token that
// does not exist. This is the gate, the same shape as minFontSize.test.ts.
//
// Source-scanned rather than measured in a browser deliberately: it has to cover
// EVERY rule, including ones no route currently renders.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(process.cwd(), 'src/index.css');
const css = readFileSync(CSS_PATH, 'utf8');

/**
 * The only tokens allowed a fallback: ones a rule can legitimately be rendered
 * WITHOUT, where the fallback is a real default rather than cover for a missing
 * token. Each must also carry the same reason as a comment in `index.css`.
 */
const MAY_FALL_BACK: Record<string, string> = {
  '--measure-slack': 'defined on .chat-stream, and .content.md also renders outside that scope',
  '--panel-inset':
    'set on <html> by AppShell only while the desktop web panel is open; 0px otherwise',
  '--wave-level': 'written per element by Waveform.tsx; the bars need a resting value',
  '--wave-envelope': 'written per element by Waveform.tsx; the bars need a resting value',
};

/** Every `--x:` declaration, and the selector block it sits in. */
function declarations(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const stack: string[] = [];
  for (const raw of css.split('\n')) {
    const line = raw.trim();
    const decl = /^(--[a-zA-Z0-9-]+)\s*:/.exec(line);
    if (decl !== null) {
      const name = decl[1] as string;
      if (!out.has(name)) out.set(name, new Set());
      (out.get(name) as Set<string>).add(stack[stack.length - 1] ?? '<top>');
    }
    if (line.endsWith('{')) stack.push(line.slice(0, -1).trim());
    else if (line.startsWith('}')) stack.pop();
  }
  return out;
}

/** Every `var(...)`, paren-matched so a nested fallback is one reference. */
function references(): { name: string; hasFallback: boolean; line: number; text: string }[] {
  const out: { name: string; hasFallback: boolean; line: number; text: string }[] = [];
  css.split('\n').forEach((text, i) => {
    let at = 0;
    for (;;) {
      at = text.indexOf('var(', at);
      if (at === -1) break;
      let depth = 0;
      let end = -1;
      for (let j = at + 3; j < text.length; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end === -1) break;
      const inner = text.slice(at + 4, end);
      const m = /^\s*(--[a-zA-Z0-9-]+)\s*(,)?/.exec(inner);
      if (m !== null) {
        out.push({
          name: m[1] as string,
          hasFallback: m[2] !== undefined,
          line: i + 1,
          text: text.trim(),
        });
      }
      at += 4;
    }
  });
  return out;
}

/**
 * RATCHET. The stylesheet already breaks both rules below in places; fixing
 * every rule is its own piece of work. Until then the counts per token are
 * frozen here: a NEW violation fails, and so does a fixed one that has not been
 * taken off this list, so the numbers only ever go down. Never raise an entry.
 */
const UNDEFINED_BASELINE: Record<string, number> = {
  '--ink-1': 15,
  '--text-base': 1,
  '--hover': 1,
  '--font-mono': 3,
  '--border': 1,
  '--paper': 6,
  '--bg-1': 2,
  '--bg-hover': 1,
  '--bg-subtle': 1,
  '--bg-2': 1,
  '--space-sm': 1,
  '--radius-md': 1,
};
const SHADOWED_BASELINE: Record<string, number> = {
  '--accent-tint': 3,
  '--accent-soft': 18,
  '--danger': 18,
  '--ink-1': 15,
  '--line': 1,
  '--text-base': 1,
  '--hover': 1,
  '--radius-pill': 6,
  '--ink-2': 1,
  '--accent': 5,
  '--voice-tint': 2,
  '--voice': 3,
  '--accent-strong': 3,
  '--font-mono': 3,
  '--border': 1,
  '--text-muted': 1,
  '--running': 2,
  '--leaf': 5,
  '--waiting': 3,
  '--paper': 6,
  '--bg-1': 2,
  '--bg-hover': 1,
  '--bg-soft': 1,
  '--bg-2': 1,
  '--space-sm': 1,
  '--radius-md': 1,
};

function countByName(rs: { name: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rs) out[r.name] = (out[r.name] ?? 0) + 1;
  return out;
}

/** Violations beyond (or short of) the frozen counts, named so the fix is obvious. */
function againstBaseline(
  found: { name: string; line: number; text: string }[],
  baseline: Record<string, number>,
): string[] {
  const counts = countByName(found);
  const out: string[] = [];
  for (const name of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const have = counts[name] ?? 0;
    const allowed = baseline[name] ?? 0;
    if (have > allowed) {
      const lines = found
        .filter((r) => r.name === name)
        .map((r) => `index.css:${r.line} ${r.text}`);
      out.push(`${name}: ${have} uses, baseline ${allowed} — ${lines.join(' | ')}`);
    } else if (have < allowed) {
      out.push(`${name}: now ${have}, baseline still ${allowed} — lower the baseline`);
    }
  }
  return out;
}

describe('spec/14 § Theming — every token referenced is a token that exists', () => {
  const declared = declarations();

  it('no var() names an undefined custom property', () => {
    const missing = references().filter(
      (r) => !declared.has(r.name) && MAY_FALL_BACK[r.name] === undefined,
    );
    // Named in the failure so the fix is obvious without opening the file.
    expect(againstBaseline(missing, UNDEFINED_BASELINE)).toEqual([]);
  });

  it('no var() hides a defined token behind a fallback', () => {
    const shadowed = references().filter(
      (r) => r.hasFallback && MAY_FALL_BACK[r.name] === undefined,
    );
    expect(againstBaseline(shadowed, SHADOWED_BASELINE)).toEqual([]);
  });

  it('every token allowed a fallback is scoped or runtime-set, and says why', () => {
    // Guards the allow-list itself: a stale entry must be removed rather than
    // left granting a licence to a name that is now an ordinary :root token.
    for (const [name, reason] of Object.entries(MAY_FALL_BACK)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
      expect(css, `${name} is allow-listed but no longer used`).toContain(`var(${name},`);
      const blocks = declared.get(name) ?? new Set<string>();
      const atRoot = Array.from(blocks).some((b) => b.startsWith(':root'));
      expect(atRoot, `${name} is a :root token, so it needs no fallback`).toBe(false);
    }
  });

  it('the tokens the fix reached for are real', () => {
    // The replacements are only correct if they name live tokens; if one is ever
    // renamed, this says so rather than quietly reintroducing the blank paint.
    for (const t of [
      '--on-accent',
      '--bg-elevated',
      '--bg-panel',
      '--bg-soft',
      '--accent-tint',
      '--line',
      '--danger',
      '--ink-2',
      '--ink-3',
    ]) {
      expect(declared.has(t), `${t} must be defined`).toBe(true);
    }
  });
});

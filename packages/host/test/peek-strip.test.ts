import { describe, it, expect } from 'vitest';
import { stripBinaryPayloads } from '../src/peek.js';

describe('stripBinaryPayloads', () => {
  const b64 = 'A'.repeat(500_000);

  it('replaces a base64 image block nested in a tool result', () => {
    const ev = {
      type: 'tool_result',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      ],
    };
    const out = stripBinaryPayloads(ev);
    expect(JSON.stringify(out).length).toBeLessThan(500);
    expect(JSON.stringify(out)).toContain('image/png omitted, 500000');
    expect(JSON.stringify(ev)).toContain(b64);
  });

  it('truncates other oversized strings but leaves short ones', () => {
    const out = stripBinaryPayloads({ a: 'x'.repeat(20_000), b: 'short' });
    expect(out.a.length).toBeLessThan(8_100);
    expect(out.a).toContain('truncated 12000 chars');
    expect(out.b).toBe('short');
  });
});

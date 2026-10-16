// lib/relayTransport.ts — the multipart header a shared file travels under.

import { describe, it, expect } from 'vitest';
import { formDisposition } from '../src/lib/relayTransport';

describe('formDisposition', () => {
  it('names a plain field and a plain file', () => {
    expect(formDisposition({ fieldName: 'note' })).toBe(
      'Content-Disposition: form-data; name="note"',
    );
    expect(formDisposition({ fieldName: 'file', uri: 'file:///a', name: 'a.jpg' })).toBe(
      'Content-Disposition: form-data; name="file"; filename="a.jpg"',
    );
  });

  it('keeps a quote or a line break in a filename from ending the header early', () => {
    const line = formDisposition({ fieldName: 'file', uri: 'file:///a', name: 'a"b\r\nX: y.jpg' });
    expect(line).toBe(
      'Content-Disposition: form-data; name="file"; filename="a%22b%0D%0AX: y.jpg"',
    );
    expect(line).not.toMatch(/[\r\n]/);
  });
});

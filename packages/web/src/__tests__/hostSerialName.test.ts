import { describe, expect, it } from 'vitest';
import { looksLikeSerial } from '../routes/settings/HostsPage.js';

describe('looksLikeSerial', () => {
  it('flags machine serials', () => {
    expect(looksLikeSerial('WC-M-K0X7P0RV6C')).toBe(true);
  });
  it('leaves chosen names alone', () => {
    expect(looksLikeSerial('Toms MacBook')).toBe(false);
    expect(looksLikeSerial('hetzner')).toBe(false);
    expect(looksLikeSerial('MACBOOK')).toBe(false);
  });
});

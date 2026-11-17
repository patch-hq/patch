import { describe, expect, it } from 'vitest';
import { anthropicAuthHeaders } from '../src/claude-usage.js';

describe('anthropicAuthHeaders', () => {
  it('sends an API key as x-api-key with no bearer or beta', () => {
    expect(anthropicAuthHeaders('sk-ant-api03-abc')).toEqual({ 'x-api-key': 'sk-ant-api03-abc' });
  });
  it('sends a sign-in token as a bearer with the OAuth beta', () => {
    expect(anthropicAuthHeaders('sk-ant-oat01-abc')).toEqual({
      authorization: 'Bearer sk-ant-oat01-abc',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { retryOnNetworkFailure, ApiError } from '../src/api/rest';

describe('retryOnNetworkFailure', () => {
  it('retries a transport failure then succeeds', async () => {
    const run = vi.fn().mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValue('ok');
    await expect(retryOnNetworkFailure(run, [0, 0])).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('gives up after the delays are spent', async () => {
    const run = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
    await expect(retryOnNetworkFailure(run, [0, 0])).rejects.toThrow('Network request failed');
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('does not retry a server answer', async () => {
    const run = vi.fn().mockRejectedValue(new ApiError(500, 'internal', null));
    await expect(retryOnNetworkFailure(run, [0, 0])).rejects.toThrow('internal');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// The SDK's `rate_limit_event` carries `resetsAt` in unix SECONDS (it is the
// `anthropic-ratelimit-unified-reset` header, parsed). Everything in patch is
// ms-epoch, and limit errors already convert (`toEpochMs`); the in-turn window
// did not, so a session window showed "resets Thu 01 Jan 1970".

import { describe, it, expect } from 'vitest';
import { translateSdkMessage } from '../src/sdkBackend.js';

const event = (resetsAt: number) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt },
});

describe('rate_limit_event resetsAt', () => {
  it('turns unix seconds into ms-epoch', () => {
    const [env] = translateSdkMessage(event(1_800_000_000));
    expect(env?.rateLimit?.window.resetsAt).toBe(1_800_000_000_000);
  });

  it('leaves a value already in ms alone', () => {
    const [env] = translateSdkMessage(event(1_800_000_000_000));
    expect(env?.rateLimit?.window.resetsAt).toBe(1_800_000_000_000);
  });

  it('states no reset when the event gave none', () => {
    const [env] = translateSdkMessage({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day' },
    });
    expect(env?.rateLimit?.window).not.toHaveProperty('resetsAt');
  });
});

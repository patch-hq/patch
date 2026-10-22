import { expect, it } from 'vitest';
import { decode, encode } from '../src/codec.js';

it('transports the refusal of an empty edited turn to surfaces', () => {
  const event = {
    type: 'chat.error' as const,
    chatId: 'c1',
    error: {
      code: 'fork_empty_message' as const,
      message: 'an edited turn needs text or an attachment',
    },
    seq: 0,
  };
  expect(decode(encode(event))).toEqual(event);
});

import { describe, it, expect } from 'vitest';
import {
  formatChatSend,
  parseChatSend,
  parseAgentReturn,
  sendToCall,
  isGroupableToolCall,
} from '../src/index.js';

describe('chat send tag', () => {
  it('round-trips the sender and a multi-line message', () => {
    const text = formatChatSend('chat-42', 'Release notes', 'line one\n\nline two');
    expect(text).toBe('[from Release notes; chat chat-42] line one\n\nline two');
    expect(parseChatSend(text)).toEqual({
      chatId: 'chat-42',
      title: 'Release notes',
      message: 'line one\n\nline two',
    });
  });

  it('carries no title for an unnamed chat', () => {
    const text = formatChatSend('c1', null, 'hi');
    expect(text).toBe('[from chat c1] hi');
    expect(parseChatSend(text)).toEqual({ chatId: 'c1', title: null, message: 'hi' });
  });

  it('flattens a title that would break the tag', () => {
    const text = formatChatSend('c1', 'Two\nlines [draft]', 'hi');
    expect(parseChatSend(text)).toEqual({ chatId: 'c1', title: 'Two lines [draft', message: 'hi' });
  });

  it('leaves ordinary text and agent returns alone', () => {
    expect(parseChatSend('hello')).toBeNull();
    expect(parseChatSend('[from the user] hello')).toBeNull();
    expect(parseChatSend('[from Folk; agent abc] reply')).toBeNull();
    expect(parseAgentReturn(formatChatSend('c1', 'Folk', 'x'))).toBeNull();
  });
});

describe('sendToCall', () => {
  it('reads the target and message of a patch_send_to call', () => {
    expect(sendToCall('mcp__patch__patch_send_to', { chatId: 'c9', message: 'go' })).toEqual({
      chatId: 'c9',
      message: 'go',
    });
    expect(sendToCall('patch_send_to', { chatId: 'c9', message: 'go' })).not.toBeNull();
  });

  it('refuses other tools and malformed args', () => {
    expect(sendToCall('Bash', { chatId: 'c9', message: 'go' })).toBeNull();
    expect(sendToCall('patch_send_to', { chatId: 'c9' })).toBeNull();
    expect(sendToCall('patch_send_to', { message: 'go' })).toBeNull();
  });

  it('keeps a send out of collapsed tool runs', () => {
    expect(isGroupableToolCall('mcp__patch__patch_send_to', { chatId: 'c', message: 'm' })).toBe(
      false,
    );
    expect(isGroupableToolCall('mcp__patch__patch_send_to', {})).toBe(true);
  });
});

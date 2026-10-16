// lib/chatFileWrite.ts — the socket write and its read-back confirmation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: sendSpy }) }));

import { confirmWritten, writeChatFile } from '../src/lib/chatFileWrite';

beforeEach(() => sendSpy.mockReset());

describe('writeChatFile', () => {
  it('sends file.write with the exact content', () => {
    writeChatFile('c1', 'docs/a.md', '# a \n\n');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'file.write',
      chatId: 'c1',
      path: 'docs/a.md',
      content: '# a \n\n',
    });
  });
  it('lets a disconnected socket throw', () => {
    sendSpy.mockImplementationOnce(() => {
      throw new Error('PatchWs: not connected');
    });
    expect(() => writeChatFile('c1', 'a.md', 'x')).toThrow('not connected');
  });
});

describe('confirmWritten', () => {
  it('is true at once when the file already holds the content', async () => {
    const read = vi.fn().mockResolvedValue('new');
    expect(await confirmWritten(read, 'new', 3, 0)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('polls until the write lands', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('old')
      .mockResolvedValue('new');
    expect(await confirmWritten(read, 'new', 5, 0)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('is false when it never does', async () => {
    const read = vi.fn().mockResolvedValue('old');
    expect(await confirmWritten(read, 'new', 3, 0)).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('lets a failed read throw', async () => {
    await expect(confirmWritten(() => Promise.reject(new Error('504')), 'x', 3, 0)).rejects.toThrow(
      '504',
    );
  });
});

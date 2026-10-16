import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addToTodoList } from '../lib/addToTodo.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';

vi.mock('../lib/imageResize.js', () => ({ downscaleImageFile: async (f: File) => f }));

describe('addToTodoList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChatStore.setState({
      chats: { c1: { chatId: 'c1', todos: [{ text: 'old', status: 'pending' }] } as never },
    });
  });

  it('uploads files, appends a pending item carrying the refs and writes the whole list', async () => {
    const up = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      ok: true,
      ref: { id: 'a1', name: 'shot.png', mimeType: 'image/png', kind: 'image', url: '/x' },
    } as never);
    const set = vi.spyOn(api, 'setTodos').mockResolvedValue(undefined as never);
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    await addToTodoList('c1', 'fix this', [{ file, kind: 'image' } as never]);
    expect(up).toHaveBeenCalledTimes(1);
    const ref = { id: 'a1', name: 'shot.png', mimeType: 'image/png', kind: 'image' };
    const expected = [
      { text: 'old', status: 'pending' },
      { text: 'fix this', status: 'pending', attachments: [ref] },
    ];
    expect(set).toHaveBeenCalledWith('c1', expected);
    expect(useChatStore.getState().chats['c1']!.todos).toEqual(expected);
  });

  it('reverts the list and throws when the write fails', async () => {
    vi.spyOn(api, 'setTodos').mockRejectedValue(new Error('nope'));
    await expect(addToTodoList('c1', 'x', [])).rejects.toThrow('nope');
    expect(useChatStore.getState().chats['c1']!.todos).toEqual([
      { text: 'old', status: 'pending' },
    ]);
  });

  it('throws on upload failure without touching the list', async () => {
    vi.spyOn(api, 'uploadAttachment').mockRejectedValue(new Error('upload'));
    const set = vi.spyOn(api, 'setTodos');
    await expect(
      addToTodoList('c1', 'x', [{ file: new File(['x'], 'a.txt'), kind: 'file' } as never]),
    ).rejects.toThrow('upload');
    expect(set).not.toHaveBeenCalled();
  });
});

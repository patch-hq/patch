// "Add to todo list" (composer send menu): turn the composer's whole input —
// text and files — into one item on the chat's task list. The files are
// uploaded now, the same way a send uploads them, so the item carries refs and
// the host can attach them when the list reaches it (spec/02 § Task list).
// NO FALLBACK: any upload or write failure throws; the caller surfaces it and
// keeps the input.

import type { AttachmentRef, TodoItem } from '@patch/wire';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { downscaleImageFile } from './imageResize.js';
import type { OutgoingFile } from './sendQueue.js';

export async function addToTodoList(
  chatId: string,
  text: string,
  files: OutgoingFile[],
): Promise<void> {
  const refs: AttachmentRef[] = [];
  for (const a of files) {
    const downscaled = a.kind === 'image' ? await downscaleImageFile(a.file) : a.file;
    const model = downscaled === a.file ? undefined : downscaled;
    const { ref } = await api.uploadAttachment(chatId, a.file, model);
    refs.push({ id: ref.id, name: ref.name, mimeType: ref.mimeType, kind: ref.kind });
  }
  // A files-only input still needs text: the item's text is what the list shows.
  const itemText = text !== '' ? text : refs.map((r) => r.name).join(', ');
  const item: TodoItem = {
    text: itemText,
    status: 'pending',
    ...(refs.length > 0 ? { attachments: refs } : {}),
  };
  const store = useChatStore.getState();
  const prev = store.chats[chatId]?.todos ?? [];
  const next = [...prev, item];
  store.setTodos(chatId, next);
  try {
    await api.setTodos(chatId, next);
  } catch (err) {
    useChatStore.getState().setTodos(chatId, prev);
    throw err;
  }
}

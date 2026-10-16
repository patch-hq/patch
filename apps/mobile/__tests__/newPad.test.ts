// Pure logic behind the New Pad screen (spec/14 § Pads — Starting a Pad).

import { describe, it, expect } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import {
  PATCH_APP,
  buildCreateBody,
  canCreate,
  libraryKey,
  newPadHref,
  padApps,
  padChatOptions,
} from '../src/lib/newPad';
import type { ChatRow } from '../src/stores/types';

const row = (chatId: string, over: Partial<ChatRow> = {}): ChatRow =>
  ({
    chatId,
    name: chatId,
    folder: '~/p',
    status: 'active',
    lastUpdated: 1,
    ...over,
  }) as ChatRow;

describe('padApps', () => {
  it('is Patch first, then the library apps, without repeating Patch', () => {
    expect(
      padApps({
        apps: [
          { app: 'Yonder', screens: [] },
          { app: 'Patch', screens: [] },
        ],
      }),
    ).toEqual([PATCH_APP, 'Yonder']);
  });
  it('is just Patch before the library has loaded', () => {
    expect(padApps(null)).toEqual(['Patch']);
  });
});

describe('canCreate', () => {
  it('needs a non-blank name, a chat and no create in flight', () => {
    expect(canCreate({ name: 'x', chatId: 'c', busy: false })).toBe(true);
    expect(canCreate({ name: '  ', chatId: 'c', busy: false })).toBe(false);
    expect(canCreate({ name: 'x', chatId: '', busy: false })).toBe(false);
    expect(canCreate({ name: 'x', chatId: 'c', busy: true })).toBe(false);
  });
});

describe('buildCreateBody', () => {
  it('a blank pad is name, device and chat only', () => {
    expect(
      buildCreateBody({ name: ' Idea ', app: '', device: 'desktop', chatId: 'c1', selected: [] }),
    ).toEqual({ name: 'Idea', device: 'desktop', chatId: 'c1' });
  });
  it('an app pad carries the app and the chosen library screens as from', () => {
    expect(
      buildCreateBody({
        name: 'Idea',
        app: 'Patch',
        device: 'phone',
        chatId: 'c1',
        selected: [libraryKey('p1', 's1'), libraryKey('p2', 's9')],
      }),
    ).toEqual({
      name: 'Idea',
      app: 'Patch',
      device: 'phone',
      chatId: 'c1',
      from: [
        { padId: 'p1', screenId: 's1' },
        { padId: 'p2', screenId: 's9' },
      ],
    });
  });
});

describe('padChatOptions', () => {
  it('drops archived and special threads and sorts newest first', () => {
    const chats = {
      a: row('a', { lastUpdated: 1, name: 'Old' }),
      b: row('b', { lastUpdated: 9, name: 'New' }),
      c: row('c', { status: 'archived', lastUpdated: 20 }),
      [SPECIAL_THREAD_IDS.manager]: row(SPECIAL_THREAD_IDS.manager, { lastUpdated: 30 }),
    };
    expect(padChatOptions(chats)).toEqual([
      { id: 'b', label: 'New' },
      { id: 'a', label: 'Old' },
    ]);
  });
});

describe('newPadHref', () => {
  it('opens the screen with no params, or preselecting a chat and Patch', () => {
    expect(newPadHref()).toBe('/pads/new');
    expect(newPadHref({ chatId: 'c1', app: 'Patch' })).toEqual({
      pathname: '/pads/new',
      params: { chatId: 'c1', app: 'Patch' },
    });
  });
});

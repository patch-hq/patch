import { describe, it, expect, vi } from 'vitest';
import type { PadView } from '../src/api/rest';
import {
  groupPads,
  openArtifactTarget,
  padBadge,
  padIdFromArtifactUrl,
  padRoute,
} from '../src/lib/pads';

const pad = (over: Partial<PadView>): PadView => ({
  id: 'p1',
  name: 'Home',
  app: 'Patch',
  chatId: 'c1',
  device: 'phone',
  createdAt: 1,
  updatedAt: 2,
  pending: 0,
  working: false,
  screens: [],
  screensError: null,
  frameUrl: '/api/padx/p1/sig/',
  ...over,
});

describe('pads helpers', () => {
  it('recognises a Pad card url and nothing else', () => {
    expect(padIdFromArtifactUrl('/pads/abc')).toBe('abc');
    expect(padIdFromArtifactUrl('/pads/a%20b')).toBe('a b');
    expect(padIdFromArtifactUrl('/api/chats/c1/artifact/a1')).toBeNull();
    expect(padIdFromArtifactUrl('/pads/abc/extra')).toBeNull();
    expect(padRoute('a b')).toBe('/pads/a%20b');
  });

  it('badge: Working beats a count; singular/plural; none when quiet', () => {
    expect(padBadge({ working: true, pending: 3 })).toBe('Working');
    expect(padBadge({ working: false, pending: 1 })).toBe('1 change');
    expect(padBadge({ working: false, pending: 2 })).toBe('2 changes');
    expect(padBadge({ working: false, pending: 0 })).toBeNull();
  });

  it('groups by app with No app last and filters by name, app and chat', () => {
    const pads = [
      pad({ id: 'a', app: null, name: 'Blank' }),
      pad({ id: 'b', app: 'Patch', name: 'Settings' }),
      pad({ id: 'c', app: 'Dog Log', name: 'Walks', chatId: 'c9' }),
    ];
    const name = (id: string) => (id === 'c9' ? 'Dog chat' : 'Main');
    expect(groupPads(pads, '', name).map(([k]) => k)).toEqual(['Patch', 'Dog Log', 'No app']);
    expect(groupPads(pads, 'dog chat', name).map(([k]) => k)).toEqual(['Dog Log']);
    expect(groupPads(pads, ' SETTINGS ', name)[0]![1].map((p) => p.id)).toEqual(['b']);
    expect(groupPads(pads, 'zzz', name)).toEqual([]);
  });

  it('openArtifactTarget routes Pad cards to the Pad and others to the viewer', () => {
    const pushRoute = vi.fn();
    const viewer = vi.fn();
    const abs = (p: string) => `https://s${p}`;
    openArtifactTarget('/pads/p1', 'Pad', { pushRoute, viewer }, abs);
    expect(pushRoute).toHaveBeenCalledWith('/pads/p1');
    expect(viewer).not.toHaveBeenCalled();
    openArtifactTarget('/api/x', 'Doc', { pushRoute, viewer }, abs);
    expect(viewer).toHaveBeenCalledWith('https://s/api/x', 'Doc');
  });
});

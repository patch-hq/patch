// Composer — run a job with `!` (spec/15 § Composer). Typing `!` opens a list
// of jobs (api.listJobs); tapping one fires it (api.runJob) and strips the
// token from the draft. No chat turn is sent.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  findHost,
  byType,
  byTestId,
  renderRN as renderRNRaw,
  update,
  actAsync,
} from './testUtils/render';
import { __clearAllMmkv } from './stubs/mmkv';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';

const { listJobsSpy, runJobSpy } = vi.hoisted(() => ({ listJobsSpy: vi.fn(), runJobSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
    listJobs: listJobsSpy,
    runJob: runJobSpy,
  },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

const renderers: ReactTestRenderer[] = [];
function renderRN(el: React.ReactElement): ReactTestRenderer {
  const r = renderRNRaw(el);
  renderers.push(r);
  return r;
}

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      name: 'Chat',
      folder: 'work',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
    },
  ]);
  useUiStore.setState({ errors: [] });
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  listJobsSpy.mockReset();
  runJobSpy.mockReset();
  listJobsSpy.mockResolvedValue({
    jobs: [
      { id: 'j1', name: 'Daily timesheet' },
      { id: 'j2', name: 'Backup' },
    ],
  });
  runJobSpy.mockResolvedValue({ status: 'sent', fireId: 'f' });
});

afterEach(() => {
  submitSpy.mockRestore();
  while (renderers.length > 0) renderers.pop()?.unmount();
});

describe('Composer — run a job with !', () => {
  it('a draft without `!` never reads jobs', () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    findHost(r.root, byType('TextInput')).props['onChangeText']('hello');
    update(r, <Composer chatId="c1" folder="work" />);
    expect(listJobsSpy).not.toHaveBeenCalled();
    expect(() => findHost(r.root, byTestId('job-menu'))).toThrow();
  });

  it('lists jobs, filters by the query, and tapping one runs it and clears the token', async () => {
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('!back');
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {});
    expect(findHost(r.root, byTestId('job-option-j2'))).toBeTruthy();
    expect(() => findHost(r.root, byTestId('job-option-j1'))).toThrow();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-option-j2')).props['onPress']();
    });
    expect(runJobSpy).toHaveBeenCalledWith('j2');
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('surfaces a failed run', async () => {
    runJobSpy.mockRejectedValue(new Error('nope'));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('!');
    });
    update(r, <Composer chatId="c1" folder="work" />);
    await actAsync(async () => {});
    await actAsync(async () => {
      findHost(r.root, byTestId('job-option-j1')).props['onPress']();
    });
    expect(useUiStore.getState().errors.some((e) => JSON.stringify(e).includes('nope'))).toBe(true);
  });

  it('surfaces a failed job read', async () => {
    listJobsSpy.mockRejectedValue(new Error('down'));
    const r = renderRN(<Composer chatId="c1" folder="work" />);
    await actAsync(async () => {
      findHost(r.root, byType('TextInput')).props['onChangeText']('!');
    });
    await actAsync(async () => {});
    expect(useUiStore.getState().errors.some((e) => JSON.stringify(e).includes('down'))).toBe(true);
  });
});

// Settings → Hooks on the phone (spec/20-hooks.md, spec/15 § Settings tab —
// Hooks): list with enable switches, an editor opened by row or by Add, and
// Save / Delete, all through the same REST calls web's Hooks page uses.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Hook } from '@patch/wire/hooks';
import { HooksPage } from '../src/components/settings/HooksSection';
import { SETTINGS_PAGES, settingsPage } from '../src/components/settings/pages';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
  hasText,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { useUiStore } from '../src/stores/uiStore';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { __resetRouterMock } from './stubs/expo-router';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';
import { blankDraft, canSave, draftFromHook, draftToBody, toggleIn } from '../src/lib/hooksEditor';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  api: {
    listHooks: vi.fn(),
    createHook: vi.fn(),
    patchHook: vi.fn(),
    deleteHook: vi.fn(),
    enableHook: vi.fn(),
    disableHook: vi.fn(),
    folders: vi.fn(),
    models: vi.fn(),
    settings: vi.fn(),
  },
}));

const scriptHook: Hook = {
  id: 'h1',
  name: 'Tone',
  enabled: true,
  when: 'user_message',
  kind: 'script',
  script: { command: 'check.sh' },
  gate: { hosts: ['home'], folders: ['/work'], chatIds: null, specialThreads: false, filter: null },
  timeoutMs: 15000,
} as unknown as Hook;
const promptHook: Hook = {
  ...scriptHook,
  id: 'h2',
  name: 'Polite',
  enabled: false,
  kind: 'prompt',
  script: undefined,
  prompt: { instructions: 'be nice', model: 'm1' },
  gate: {},
} as unknown as Hook;

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
const get = (r: R, id: string) => findHost(r.root, byTestId(id));
async function mount(): Promise<R> {
  const r = renderRN(<HooksPage />);
  mounted.push(r);
  await flush();
  return r;
}
const press = async (r: R, id: string) => {
  await actAsync(() => {
    get(r, id).props['onPress']();
  });
  await flush();
};
const type = async (r: R, id: string, text: string) => {
  await actAsync(() => {
    get(r, id).props['onChangeText'](text);
  });
};

beforeEach(() => {
  __resetRouterMock();
  __clearLastAlert();
  useUiStore.setState({ errors: [] });
  resetHosts();
  reportHost('home', { hostName: 'laptop', runsManager: true });
  vi.mocked(api.listHooks)
    .mockReset()
    .mockResolvedValue({ hooks: [scriptHook, promptHook] });
  vi.mocked(api.createHook).mockReset().mockResolvedValue(scriptHook);
  vi.mocked(api.patchHook).mockReset().mockResolvedValue(scriptHook);
  vi.mocked(api.deleteHook).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.enableHook).mockReset().mockResolvedValue(scriptHook);
  vi.mocked(api.disableHook).mockReset().mockResolvedValue(scriptHook);
  vi.mocked(api.folders)
    .mockReset()
    .mockResolvedValue({ hosts: [{ hostId: 'home', roots: ['/work'], recent: ['/other'] }] });
  vi.mocked(api.models)
    .mockReset()
    .mockResolvedValue({ models: [{ id: 'm1', label: 'Model 1' }] });
});
afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted
    }
  }
});

describe('Settings → Hooks page', () => {
  it('is a page of its own after Voice', () => {
    const ids = SETTINGS_PAGES.map((p) => p.id);
    expect(ids.indexOf('hooks')).toBe(ids.indexOf('voice') + 1);
    expect(settingsPage('hooks')?.title).toBe('Hooks');
  });

  it('lists each hook with its kind and enable switch', async () => {
    const r = await mount();
    expect(hasText(get(r, 'hook-h1'), 'Tone')).toBe(true);
    expect(hasText(get(r, 'hook-h1'), 'user_message · script')).toBe(true);
    expect(get(r, 'hook-h1-enabled').props['value']).toBe(true);
    expect(get(r, 'hook-h2-enabled').props['value']).toBe(false);
  });

  it('toggling the switch calls enable / disable and re-reads', async () => {
    const r = await mount();
    await actAsync(() => {
      get(r, 'hook-h1-enabled').props['onValueChange'](false);
    });
    await flush();
    expect(api.disableHook).toHaveBeenCalledWith('h1');
    await actAsync(() => {
      get(r, 'hook-h2-enabled').props['onValueChange'](true);
    });
    await flush();
    expect(api.enableHook).toHaveBeenCalledWith('h2');
    expect(api.listHooks).toHaveBeenCalledTimes(3);
  });

  it('says so when there are no hooks, and when the read fails (with Retry)', async () => {
    vi.mocked(api.listHooks).mockResolvedValueOnce({ hooks: [] });
    const r = await mount();
    expect(textOf(get(r, 'hooks-empty'))).toBe('No hooks configured');

    vi.mocked(api.listHooks).mockRejectedValueOnce(new Error('boom'));
    const r2 = await mount();
    expect(textOf(get(r2, 'hooks-error'))).toContain('Could not read hooks: boom');
    const retry = findHost(r2.root, (i) => i.props?.accessibilityLabel === 'Retry');
    await actAsync(() => retry.props['onPress']());
    await flush();
    expect(queryHost(r2.root, byTestId('hooks-error'))).toBeNull();
  });

  it('Add opens a blank editor; Save is dead until the script hook is complete, then creates', async () => {
    const r = await mount();
    await press(r, 'hook-add');
    expect(queryHost(r.root, byTestId('hook-add'))).toBeNull();
    expect(get(r, 'hook-editor-save').props['disabled']).toBe(true);
    await type(r, 'hook-editor-name', '  Mine ');
    await type(r, 'hook-editor-command', 'run.sh');
    await type(r, 'hook-editor-filter', ' payload.x ');
    await type(r, 'hook-editor-timeout', '2000');
    await press(r, 'hook-editor-hosts-home');
    await press(r, 'hook-editor-folders-/other');
    await actAsync(() => {
      get(r, 'hook-editor-special-threads').props['onValueChange'](true);
    });
    await actAsync(() => {
      get(r, 'hook-editor-enabled').props['onValueChange'](false);
    });
    expect(get(r, 'hook-editor-save').props['disabled']).toBe(false);
    await press(r, 'hook-editor-save');
    expect(api.createHook).toHaveBeenCalledWith({
      name: 'Mine',
      when: 'user_message',
      kind: 'script',
      script: { command: 'run.sh' },
      gate: {
        hosts: ['home'],
        folders: ['/other'],
        chatIds: null,
        specialThreads: true,
        filter: 'payload.x',
      },
      timeoutMs: 2000,
      enabled: false,
    });
    expect(queryHost(r.root, byTestId('hook-editor'))).toBeNull();
  });

  it('a prompt hook needs instructions and a model; the model comes from the catalogue', async () => {
    const r = await mount();
    await press(r, 'hook-add');
    await type(r, 'hook-editor-name', 'P');
    await press(r, 'hook-editor-kind-prompt');
    await type(r, 'hook-editor-instructions', 'judge it');
    expect(get(r, 'hook-editor-save').props['disabled']).toBe(true);
    await actAsync(() => {
      get(r, 'hook-editor-model').props['onPress']();
    });
    await flush();
    await press(r, 'hook-editor-model-option-m1');
    expect(get(r, 'hook-editor-save').props['disabled']).toBe(false);
    await press(r, 'hook-editor-save');
    expect(api.createHook).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'prompt',
        prompt: { instructions: 'judge it', model: 'm1' },
      }),
    );
  });

  it('a row opens its editor filled in; Save patches that hook; Cancel closes', async () => {
    const r = await mount();
    await press(r, 'hook-h1');
    expect(get(r, 'hook-editor-name').props['value']).toBe('Tone');
    expect(get(r, 'hook-editor-command').props['value']).toBe('check.sh');
    await type(r, 'hook-editor-name', 'Tone2');
    await press(r, 'hook-editor-save');
    expect(api.patchHook).toHaveBeenCalledWith('h1', expect.objectContaining({ name: 'Tone2' }));

    await press(r, 'hook-h1');
    await press(r, 'hook-editor-cancel');
    expect(queryHost(r.root, byTestId('hook-editor'))).toBeNull();
    expect(api.patchHook).toHaveBeenCalledTimes(1);
  });

  it('a failed save is reported and leaves the editor open', async () => {
    vi.mocked(api.patchHook).mockRejectedValueOnce(new Error('name taken'));
    const r = await mount();
    await press(r, 'hook-h1');
    await press(r, 'hook-editor-save');
    expect(useUiStore.getState().errors.some((e) => e.message.includes('name taken'))).toBe(true);
    expect(get(r, 'hook-editor')).toBeTruthy();
  });

  it('Delete is confirmed first, then removes the hook', async () => {
    const r = await mount();
    await press(r, 'hook-h1');
    await press(r, 'hook-editor-delete');
    expect(api.deleteHook).not.toHaveBeenCalled();
    const alert = __getLastAlert()!;
    expect(alert.title).toBe('Delete Tone');
    alert.buttons!.find((b) => b.style === 'cancel')!.onPress?.();
    expect(api.deleteHook).not.toHaveBeenCalled();
    await actAsync(() => alert.buttons!.find((b) => b.style === 'destructive')!.onPress!());
    await flush();
    expect(api.deleteHook).toHaveBeenCalledWith('h1');
    expect(queryHost(r.root, byTestId('hook-editor'))).toBeNull();
  });

  it('a failed folder read is said in the editor', async () => {
    vi.mocked(api.folders).mockRejectedValueOnce(new Error('no folders'));
    const r = await mount();
    await press(r, 'hook-add');
    expect(textOf(get(r, 'hook-editor-folders-error'))).toContain('no folders');
  });
});

describe('hooksEditor', () => {
  it('round-trips a hook through a draft', () => {
    const body = draftToBody(draftFromHook(promptHook));
    expect(body).toMatchObject({
      kind: 'prompt',
      prompt: { instructions: 'be nice', model: 'm1' },
    });
    expect(draftFromHook(scriptHook).hosts).toEqual(['home']);
  });
  it('blank drafts cannot be saved; a blank timeout is omitted', () => {
    expect(canSave(blankDraft())).toBe(false);
    expect('timeoutMs' in draftToBody({ ...blankDraft(), name: 'x', command: 'c' })).toBe(false);
  });
  it('toggleIn adds and removes', () => {
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleIn(['a', 'b'], 'a')).toEqual(['b']);
  });
});

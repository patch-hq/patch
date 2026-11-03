// Editing a Patch tool's prompt from the mobile Tools page (spec/06 § Tool
// prompts): Edit opens the text the model reads, Save/Reset write the shared
// setting.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolsList } from '../src/components/ToolsList';
import { api } from '../src/api/rest';
import { useSettingsStore } from '../src/stores/settingsStore';
import { renderRN, findHost, queryHost, byTestId, actAsync, flush } from './testUtils/render';
import {
  reportHost,
  resetHosts,
  seedSettings,
  settingsFixture,
} from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: () => ({ send: vi.fn() }) }));
vi.mock('../src/api/rest', () => ({
  api: { settings: vi.fn(), setPreferences: vi.fn() },
}));

const get = (r: ReturnType<typeof renderRN>, id: string) => findHost(r.root, byTestId(id));
const query = (r: ReturnType<typeof renderRN>, id: string) => queryHost(r.root, byTestId(id));

beforeEach(() => {
  useSettingsStore.getState()._reset();
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  resetHosts();
  reportHost('d1', { toolPromptDefaults: { patch_peek: 'Built-in peek text.' } });
  seedSettings();
});

describe('ToolsList — editing a Patch tool prompt', () => {
  it('opens the built-in text, saves an edit as a shared setting and marks it edited', async () => {
    const r = renderRN(<ToolsList chatId="c1" />);
    await actAsync(() => get(r, 'tool-prompt-edit-patch_peek').props.onPress());
    expect(get(r, 'tool-prompt-input-patch_peek').props.value).toBe('Built-in peek text.');
    await actAsync(() => get(r, 'tool-prompt-input-patch_peek').props.onChangeText('My peek.'));
    await actAsync(async () => {
      get(r, 'tool-prompt-save-patch_peek').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      toolPromptOverrides: { patch_peek: 'My peek.' },
    });
    expect(query(r, 'tool-prompt-edited-patch_peek')).not.toBeNull();
  });

  it('Reset removes an existing edit', async () => {
    seedSettings({
      preferences: {
        ...settingsFixture().preferences,
        toolPromptOverrides: { patch_peek: 'Old edit.' },
      },
    });
    const r = renderRN(<ToolsList chatId="c1" />);
    await actAsync(() => get(r, 'tool-prompt-edit-patch_peek').props.onPress());
    expect(get(r, 'tool-prompt-input-patch_peek').props.value).toBe('Old edit.');
    await actAsync(async () => {
      get(r, 'tool-prompt-reset-patch_peek').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ toolPromptOverrides: {} });
    expect(query(r, 'tool-prompt-edited-patch_peek')).toBeNull();
  });

  it('offers no editor on a built-in tool, nor for a tool no host has reported', () => {
    const r = renderRN(<ToolsList chatId="c1" />);
    expect(query(r, 'tool-prompt-edit-Bash')).toBeNull();
    expect(query(r, 'tool-prompt-edit-patch_history')).toBeNull();
  });
});

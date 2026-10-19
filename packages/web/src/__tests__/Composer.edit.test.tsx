// spec/04 § Branching — the edit box is the composer in edit mode,
// so it has the composer's rich editing (skill menu and chips, quotes, paste).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Composer } from '../components/Composer.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportAccount } from './presenceHelpers.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { api } from '../api/rest.js';

function seedChat(folder = '/proj', model?: string): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      ...(model ? { model } : {}),
      permissionMode: 'bypassPermissions' as const,
      name: 'deploy',
      folder,
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
}

describe('Composer — edit mode', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useVoiceStore.getState().endNote();
    useUiStore.getState().clearToasts();
    useChatStore.getState()._reset();
    localStorage.clear();
    vi.spyOn(api, 'skills').mockResolvedValue({
      skills: ['plant', 'context'],
      paths: { plant: '/proj/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
      frontmatter: { plant: { description: 'Sow what is in season.' } },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderEditor(initial = 'first words', allowEmpty = false) {
    seedChat('/proj');
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        chatId="c1"
        hostId="d1"
        folder="/proj"
        initialValue={initial}
        onSend={onSend}
        edit={{ onSave, onCancel, allowEmpty }}
      />,
    );
    return {
      onSave,
      onCancel,
      onSend,
      input: screen.getByTestId('msg-edit-input') as HTMLTextAreaElement,
    };
  }

  it('starts with the message text, focused', () => {
    const { input } = renderEditor();
    expect(input.value).toBe('first words');
    expect(document.activeElement).toBe(input);
  });

  it('offers the skill menu and completes to a chip', async () => {
    const { input } = renderEditor('');
    fireEvent.change(input, { target: { value: 'run /pl' } });
    fireEvent.mouseDown(await screen.findByTestId('composer-skill-option-plant'));
    await waitFor(() => expect(input.value).toBe('run /plant '));
    expect(await screen.findByTestId('composer-chip')).toBeInTheDocument();
  });

  it('saves the trimmed text on ⌘↵, Ctrl↵ and the Save button, never sending', () => {
    const { input, onSave, onSend } = renderEditor();
    fireEvent.change(input, { target: { value: '  reworded  ' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.click(screen.getByTestId('msg-edit-save'));
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(onSave).toHaveBeenLastCalledWith('reworded');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps bare Enter and Shift+Enter as newlines', () => {
    const { input, onSave } = renderEditor();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('cancels on Esc and on the Cancel button', () => {
    const { input, onCancel } = renderEditor();
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('msg-edit-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('will not save empty text unless allowed', () => {
    const { input, onSave } = renderEditor('x');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByTestId('msg-edit-save')).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('passes empty text through when allowed (a queued message remove)', () => {
    const { input, onSave } = renderEditor('x', true);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('leaves out the controls that belong to a new turn', () => {
    renderEditor();
    for (const id of [
      'attach-btn',
      'sketch-btn',
      'call-btn',
      'meeting-btn',
      'permission-mode',
      'send-btn',
      'stop-btn',
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.getByTestId('voice-note-btn')).toBeInTheDocument();
  });

  it('pastes a long text inline rather than as an attachment', () => {
    const { input } = renderEditor();
    const long = 'x'.repeat(20000);
    fireEvent.paste(input, {
      clipboardData: { items: [], getData: () => long },
    });
    expect(screen.queryByTestId('composer-attachment')).toBeNull();
    expect(input.value).toBe('first words');
  });

  it('refuses a pasted image out loud', () => {
    const { input } = renderEditor();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        getData: () => '',
      },
    });
    expect(screen.queryByTestId('composer-attachment')).toBeNull();
    expect(useUiStore.getState().errors.at(-1)?.message).toMatch(/editing a message/);
  });

  it('does not write into the chat draft', () => {
    const { input } = renderEditor();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'edited' } });
    expect(localStorage.length).toBe(0);
  });
});

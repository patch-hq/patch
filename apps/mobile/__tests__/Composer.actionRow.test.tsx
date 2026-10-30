// The composer action row the user settled on (spec/15 § Composer):
//   [camera][image][file][mic] … [model pill][padlock][Send | Stop]
// Pins:
//   - the order, with the flexible spacer between the mic and the model pill
//   - the model pill reads a compact friendly name and changes the model with
//     the same `chat.model_request` web's header sends; it applies to the next
//     message, and a host that never confirms is reported, not waited on
//   - Stop REPLACES Send while a turn runs and the composer is empty, and sends
//     the same `chat.stop_request` web's stop button does
//   - typing while a turn runs brings Send back, and that send goes through the
//     normal delivery path (the host queues it behind the running turn)
//   - on a 360dp phone the pill is the only control that shrinks

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { seedDictation } from './testUtils/settingsFixtures';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  renderRN,
  update,
  findHost,
  queryHost,
  findAllHost,
  byLabel,
  byTestId,
  byType,
  textOf,
  actSync,
  actAsync,
  flush,
  flushMicrotasks,
} from './testUtils/render';
import type { DictationHandle, DictationOutcome } from '../src/lib/dictation';
import * as dictationModule from '../src/lib/dictation';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';
import { compactModelLabel } from '../src/lib/modelLabel';
import { lightColors } from '../src/lib/theme';

const { modelsSpy } = vi.hoisted(() => ({ modelsSpy: vi.fn() }));
// Message hooks have their own tests (Composer.hooks.test.tsx); here the check passes.
vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: async () => ({ decision: 'pass' as const, results: [] }),
}));

vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
    models: modelsSpy,
  },
}));

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

import { useComposerDraftStore } from '../src/lib/composerDraft';
import {
  Composer,
  MODEL_CONFIRM_TIMEOUT_MS,
  PENDING_SEND_TIMEOUT_MS,
} from '../src/components/Composer';

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The upload path these tests drive is the phone's Whisper engine.
  seedDictation('whisper');
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  vi.clearAllMocks();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  modelsSpy.mockResolvedValue({
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    ],
  });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
  vi.useRealTimers();
});

function seed(
  overrides: { activity?: 'idle' | 'running' | 'awaiting-permission'; model?: string | null } = {},
): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      name: 'Chat',
      folder: '/home/tom/work',
      activity: overrides.activity ?? 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
      model: overrides.model === undefined ? 'claude-opus-5-5' : overrides.model,
    },
  ]);
}

/** Host controls on the action row, named by label or testID, in order. */
function rowOrder(root: ReactTestInstance): string[] {
  const row = findHost(root, byTestId('composer-actions-row'));
  const wanted = new Set([
    'Take photo',
    'Attach photo or image',
    'Attach any file',
    'Sketch',
    'Clear dictation',
    'composer-actions-spacer',
    'composer-model-pill',
    'permission-mode-padlock',
    'composer-effort',
    'chat-account',
    'composer-stop',
    'Send message',
  ]);
  return row
    .findAll((i) => typeof i.type === 'string')
    .map((i) => {
      const id = i.props['testID'] as string | undefined;
      const label = i.props['accessibilityLabel'] as string | undefined;
      if (id !== undefined && wanted.has(id)) return id;
      if (label !== undefined && wanted.has(label)) return label;
      return null;
    })
    .filter((x): x is string => x !== null);
}

function dictationFactory(): typeof dictationModule.startDictation {
  return vi.fn(
    (_chatId: string, _onPartial: (t: string) => void, _onError: (m: string) => void) => {
      const finish = vi.fn(async (_send: boolean) => ({ kind: 'no-audio' }) as DictationOutcome);
      return { finish } satisfies DictationHandle;
    },
  ) as unknown as typeof dictationModule.startDictation;
}

describe('Composer action row — order', () => {
  it('a dictation in flight swaps the + for Clear, at the far end of the field from the mic', async () => {
    seed();
    const factory = dictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    const inputRow = findHost(r.root, byTestId('composer-input-row'));
    const inRow = (label: string): number =>
      inputRow.findAll((i) => typeof i.type === 'string' && i.props['accessibilityLabel'] === label)
        .length;
    expect(inRow('Clear dictation')).toBe(1);
    expect(inRow('Add to message')).toBe(0);
    expect(inRow('Dictate into message')).toBe(1);
  });

  it('Clear goes and the + comes back once the dictation is cleared', async () => {
    seed();
    const factory = dictationFactory();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    await actAsync(() => {
      findHost(r.root, byLabel('Clear dictation')).props['onPress']();
    });
    expect(queryHost(r.root, byLabel('Clear dictation'))).toBeNull();
    expect(findHost(r.root, byLabel('Add to message'))).toBeTruthy();
  });

  it('reads settings … send on one line: approval, model, effort, then send', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(rowOrder(r.root)).toEqual([
      'permission-mode-padlock',
      'composer-model-pill',
      'composer-effort',
      'chat-account',
      'composer-actions-spacer',
      'Send message',
    ]);
  });

  it('has no text on the action row but the model name — the mode, effort and account are icons', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    for (const id of ['permission-mode-padlock', 'composer-effort', 'chat-account']) {
      expect(textOf(findHost(r.root, byTestId(id)))).toBe('');
    }
  });

  it('draws one icon system: shield, gauge circle and user circle, 20px at stroke 1.75 in the quiet ink', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const icon = (id: string): ReactTestInstance =>
      findHost(r.root, byTestId(id)).findAll((i) => i.type === ('Icon' as unknown as string))[0]!;
    for (const [id, name] of [
      ['permission-mode-padlock', 'ShieldCheck'],
      ['composer-effort', 'CircleGauge'],
      ['chat-account', 'CircleUserRound'],
    ] as const) {
      expect(icon(id).props).toMatchObject({
        name,
        size: 20,
        strokeWidth: 1.75,
        color: lightColors.ink3,
      });
    }
  });

  it('the + offers camera, photo, file and sketch', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const menu = r.root.findAll(
      (i) =>
        typeof i.type !== 'string' &&
        Array.isArray(i.props['items']) &&
        (i.props['items'] as { testID?: string }[]).some((it) => it.testID === 'add-menu-camera'),
    )[0]!;
    expect((menu.props['items'] as { label: string }[]).map((i) => i.label)).toEqual([
      'Take photo',
      'Photo or image',
      'Any file',
      'Sketch',
    ]);
  });

  it('effort: a pick sends chat.effort_request', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    actSync(() => findHost(r.root, byTestId('composer-effort')).props['onPress']());
    actSync(() => findHost(r.root, byTestId('effort-option-high')).props['onPress']());
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.effort_request',
      chatId: 'c1',
      effort: 'high',
    });
  });

  it('effort is not offered on a chat with no Claude model', () => {
    seed({ model: null });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-effort'))).toBeNull();
  });

  it('with a turn running and nothing typed, Stop takes Send’s place at the end', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(rowOrder(r.root).slice(-2)).toEqual(['composer-actions-spacer', 'composer-stop']);
  });

  it('keeps the model pill and padlock on an existing chat the roster has not named yet', () => {
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-model-pill'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('permission-mode-padlock'))).not.toBeNull();
  });

  it('keeps the model pill when the host reports no model (never a guess)', () => {
    seed({ model: null });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-model-pill'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('permission-mode-padlock'))).not.toBeNull();
  });

  it('shows the same settings row on a new chat (a send target) — everything but the context ring', () => {
    const r = renderRN(
      <Composer
        chatId="c1"
        folder="/home/tom/work"
        sendTarget={async () => null}
        setup={{
          hostId: 'd1',
          model: 'claude-opus-5-5',
          onModel: vi.fn(),
          mode: 'default',
          onMode: vi.fn(),
          effort: null,
          onEffort: vi.fn(),
          accountId: null,
          onAccount: vi.fn(),
        }}
      />,
    );
    expect(rowOrder(r.root)).toEqual([
      'permission-mode-padlock',
      'composer-model-pill',
      'composer-effort',
      'chat-account',
      'composer-actions-spacer',
      'Send message',
    ]);
    expect(queryHost(r.root, byTestId('context-ring'))).toBeNull();
  });
});

describe('Composer action row — fits a 360dp phone', () => {
  it('nothing shrinks — the model name is never truncated — and the row fits 360dp', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const pillStyle = findHost(r.root, byTestId('composer-model-pill')).props['style'] as Record<
      string,
      number
    >;
    expect(pillStyle['flexShrink'] ?? 0).toBe(0);
    expect(pillStyle['maxWidth']).toBeUndefined();
    const send = findHost(r.root, byLabel('Send message')).props['style'] as Record<string, number>;
    expect(send['flexShrink'] ?? 0).toBe(0);
    // Budget: 10px padding each side, three 36px icon buttons, the ring at its
    // widest (20px + gap + "100%"), the send circle, and a ~100px model pill.
    const fixed = 2 * 10 + 3 * 36 + 60 + send['width']! + 7 * 2 + 4 + 100;
    expect(360 - fixed).toBeGreaterThanOrEqual(0);
  });
});

describe('Composer account menu', () => {
  function connect(): void {
    useSettingsStore.setState({
      data: {
        preferences: {},
        shared: {
          version: 1,
          secrets: {
            claude: [
              { id: 'c0', label: 'Work', connected: true },
              { id: 'c1', label: 'Home', connected: true },
            ],
            codex: [],
            providerKeys: [],
          },
          hosts: [],
        },
      } as never,
    });
  }

  it('is always on the row, and in a chat ticks the account in force', async () => {
    seed();
    connect();
    useChatStore.setState({
      chats: {
        c1: { ...useChatStore.getState().chats['c1']!, account: { id: 'c1', label: 'Home' } },
      },
    });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(findHost(r.root, byTestId('chat-account')).props['accessibilityLabel']).toBe(
      'Account: Home',
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-account')).props['onPress']();
      await flush();
    });
    const tick = (id: string): unknown =>
      findHost(r.root, byTestId(id)).props['accessibilityState'].selected;
    expect(tick('account-option-c1')).toBe(true);
    expect(tick('account-option-c0')).toBe(false);
  });

  it('switching an account mid-chat sends chat.account_request; By strategy sends null', async () => {
    seed();
    connect();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-account')).props['onPress']();
      await flush();
    });
    actSync(() => findHost(r.root, byTestId('account-option-c0')).props['onPress']());
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.account_request',
      chatId: 'c1',
      preferredAccountId: 'c0',
    });
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-account')).props['onPress']();
      await flush();
    });
    actSync(() => findHost(r.root, byTestId('account-option-strategy')).props['onPress']());
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.account_request',
      chatId: 'c1',
      preferredAccountId: null,
    });
  });
});

describe('Composer model pill', () => {
  it('reads a compact friendly name, not the raw id', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(textOf(findHost(r.root, byTestId('composer-model-pill')))).toContain('Opus 5.5');
    expect(textOf(findHost(r.root, byTestId('composer-model-pill')))).not.toContain('claude-');
  });

  it('does not ask the host for its catalogue until the pill is opened', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(flush);
    expect(modelsSpy).not.toHaveBeenCalled();
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    expect(modelsSpy).toHaveBeenCalledWith('d1');
  });

  it('choosing a model sends chat.model_request — the same frame web sends', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() => findHost(r.root, byTestId('model-menu-all')).props['onPress']());
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-sonnet-5')).props['onPress'](),
    );
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-sonnet-5',
    });
    // Pending until the host confirms: the pill reads the pick, dimmed.
    const pill = findHost(r.root, byTestId('composer-model-pill'));
    expect(textOf(pill)).toContain('Sonnet 5');
    expect(pill.props['accessibilityState']).toMatchObject({ busy: true });
  });

  it('says the change applies to the next message', async () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() => findHost(r.root, byTestId('model-menu-all')).props['onPress']());
    expect(textOf(findHost(r.root, byTestId('model-picker-note')))).toMatch(
      /next message — this turn keeps its model/,
    );
  });

  it('re-picking the model already in force sends nothing', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() => findHost(r.root, byTestId('model-menu-all')).props['onPress']());
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-opus-5-5')).props['onPress'](),
    );
    expect(wsMock.send).not.toHaveBeenCalled();
  });

  it('the host confirming (chat.state carrying the model) settles the pill', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await flush();
    });
    actSync(() => findHost(r.root, byTestId('model-menu-all')).props['onPress']());
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-sonnet-5')).props['onPress'](),
    );
    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, model: 'claude-sonnet-5' } },
      });
    });
    update(r, <Composer chatId="c1" folder="/home/tom/work" />);
    const pill = findHost(r.root, byTestId('composer-model-pill'));
    expect(pill.props['accessibilityState']).toMatchObject({ busy: false });
    expect(textOf(pill)).toContain('Sonnet 5');
  });

  it('a host that never confirms is reported and the pill goes back (NO FALLBACK)', async () => {
    vi.useFakeTimers();
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await actAsync(async () => {
      findHost(r.root, byTestId('composer-model-pill')).props['onPress']();
      await vi.advanceTimersByTimeAsync(0);
    });
    actSync(() => findHost(r.root, byTestId('model-menu-all')).props['onPress']());
    actSync(() =>
      findHost(r.root, byTestId('new-chat-model-option-claude-sonnet-5')).props['onPress'](),
    );
    actSync(() => {
      vi.advanceTimersByTime(MODEL_CONFIRM_TIMEOUT_MS + 1);
    });
    expect(textOf(findHost(r.root, byTestId('composer-model-pill')))).toContain('Opus 5.5');
    expect(
      useUiStore.getState().errors.some((e) => /did not switch the model/.test(e.message)),
    ).toBe(true);
  });
});

describe('Composer — Stop replaces Send while a turn runs', () => {
  it('idle: Send shows, Stop does not', () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byLabel('Send message'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
  });

  it('running with an empty composer: Stop (a square) instead of Send', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const stop = findHost(r.root, byTestId('composer-stop'));
    expect(stop.props['accessibilityLabel']).toBe('Stop turn');
    expect(stop.findAll((i) => i.type === ('Icon' as unknown as string))[0]!.props['name']).toBe(
      'Square',
    );
    expect(
      queryHost(r.root, (i) => String(i.props['accessibilityLabel'] ?? '').startsWith('Send')),
    ).toBeNull();
  });

  it('awaiting a permission mid-turn still offers Stop', () => {
    seed({ activity: 'awaiting-permission' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
  });

  it('parked only on an AskUserQuestion offers no Stop', () => {
    seed({ activity: 'awaiting-permission' });
    useChatStore.setState((st) => ({
      chats: {
        ...st.chats,
        c1: {
          ...st.chats['c1']!,
          pendingPermissions: [
            { requestId: 'q1', tool: 'AskUserQuestion', description: '', args: {} },
          ],
        },
      },
    }));
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
  });

  it('tapping Stop sends chat.stop_request — the frame web’s stop button sends', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    findHost(r.root, byTestId('composer-stop')).props['onPress']();
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'chat.stop_request', chatId: 'c1' });
  });

  it('typing while running brings Send back, and it queues the message', async () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('and then do this'));
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    const send = findHost(r.root, byLabel('Send message (queued after the current turn)'));
    actSync(() => send.props['onPress']());
    await flushMicrotasks();
    // The ordinary delivery path: the host queues a chat.input behind the
    // running turn, exactly as a web send mid-turn is queued.
    expect(submitSpy).toHaveBeenCalledWith(
      'c1',
      'and then do this',
      expect.any(String),
      undefined,
      expect.any(Function),
      expect.anything(),
      // An ordinary send is not a retry, so it carries no retryOfSeq.
      undefined,
    );
    expect(wsMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.stop_request' }),
    );
    // Composer cleared by the send → back to Stop while the turn still runs.
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
  });

  it('whitespace alone does not count as typed text — still Stop', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('   '));
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
  });

  it('when the turn finishes, Stop goes back to Send', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, activity: 'idle' } },
      });
    });
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    expect(queryHost(r.root, byLabel('Send message'))).not.toBeNull();
  });

  it('with the link down Stop is visibly unavailable rather than a dead tap', () => {
    seed({ activity: 'running' });
    usePresenceStore.setState({ connection: 'offline' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const stop = findHost(r.root, byTestId('composer-stop'));
    expect(stop.props['accessibilityLabel']).toMatch(/^Stop unavailable — /);
  });
});

// A plain send (no attachment) clears the draft synchronously, but the host
// confirming the turn as `running` — what lets Stop take over — arrives a
// moment later over the socket. Without holding the busy styling across that
// gap, empty draft + not-yet-running reads identically to nothing-to-send:
// the send button flashes dead grey right when a turn is about to start
// (Todoist 6hf2JM6695c7rhJ6).
describe('Composer — Send stays active across the send→running gap', () => {
  /** The send Pressable, whichever of its labels it is currently wearing. */
  function sendButton(r: ReturnType<typeof renderRN>) {
    return findHost(
      r.root,
      (i) =>
        i.type === 'Pressable' &&
        /^(Send message|Sending)/.test(String(i.props['accessibilityLabel'] ?? '')),
    );
  }

  it('keeps the active colour and a spinner until the host confirms running, then Stop takes over', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('hello'));
    actSync(() => sendButton(r).props['onPress']());
    await flushMicrotasks();

    // The draft is gone and the host has not said the turn is running yet —
    // Stop is already offered, so the send can be cancelled while it is in
    // flight (Todoist 6hhjmc4fghR3qVw6), and it sends chat.stop_request.
    const stop = findHost(r.root, byTestId('composer-stop'));
    expect(queryHost(r.root, byLabel('Send message'))).toBeNull();
    expect(findAllHost(r.root, byType('ActivityIndicator'))).toHaveLength(0);
    actSync(() => stop.props['onPress']());
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'chat.stop_request', chatId: 'c1' });
    // Stopping ends the pending gap: Send is back, dead grey (empty draft).
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    expect(sendButton(r).props['style'].backgroundColor).toBe(lightColors.divider);
  });

  it('Stop takes over from the pending send once the host confirms running', async () => {
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('hello'));
    actSync(() => sendButton(r).props['onPress']());
    await flushMicrotasks();
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();

    // The host's chat.state lands — Stop takes over, exactly as it does for
    // any other running-and-empty composer.
    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, activity: 'running' } },
      });
    });
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
    expect(queryHost(r.root, byLabel('Send message'))).toBeNull();
  });

  it('settles instead of spinning forever if running never comes back (e.g. queued offline)', async () => {
    vi.useFakeTimers();
    seed();
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('hello'));
    actSync(() => sendButton(r).props['onPress']());
    await flushMicrotasks();
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();

    actSync(() => vi.advanceTimersByTime(PENDING_SEND_TIMEOUT_MS + 1));

    const settled = sendButton(r);
    expect(queryHost(r.root, byTestId('composer-stop'))).toBeNull();
    expect(settled.props['style'].backgroundColor).toBe(lightColors.divider);
  });

  it('a queued send mid-turn (already running) goes straight to Stop, no gap', async () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const input = findHost(r.root, (i) => i.type === ('TextInput' as unknown as string));
    actSync(() => input.props['onChangeText']('and then this'));
    const send = findHost(r.root, byLabel('Send message (queued after the current turn)'));
    actSync(() => send.props['onPress']());
    await flushMicrotasks();
    // Already running at send time, so no busy gap to bridge — Stop is back
    // immediately, not a lingering busy Send.
    expect(queryHost(r.root, byTestId('composer-stop'))).not.toBeNull();
    expect(findAllHost(r.root, byType('ActivityIndicator'))).toHaveLength(0);
  });

  // Send/Stop paint a filled circle, so at the shared 36px touch target they
  // read heavier than the outline-only icons beside them (Todoist
  // 6hf2JM6695c7rhJ6 — "looks big even if it isn't"). The drawn circle is
  // smaller; hit slop makes up the difference so the touch target still
  // matches every other action-row control.
  it('paints Send/Stop smaller than the shared touch target, with hit slop making up the difference', () => {
    seed({ activity: 'running' });
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    const stop = findHost(r.root, byTestId('composer-stop'));
    const stopWidth = stop.props['style'].width as number;
    const stopHitSlop = stop.props['hitSlop'] as number;
    expect(stopWidth).toBeLessThan(36);
    expect(stopWidth).toBe(stop.props['style'].height);
    expect(stopHitSlop).toBe((36 - stopWidth) / 2);

    actSync(() => {
      const row = useChatStore.getState().chats['c1']!;
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c1: { ...row, activity: 'idle' } },
      });
    });
    const send = findHost(r.root, byLabel('Send message'));
    expect(send.props['style'].width).toBe(stopWidth);
    expect(send.props['hitSlop']).toBe(stopHitSlop);
  });
});

describe('compactModelLabel', () => {
  it.each([
    ['claude-opus-5-5', undefined, 'Opus 5.5'],
    ['claude-opus-5-5', 'Claude Opus 5.5', 'Opus 5.5'],
    ['claude-sonnet-5', undefined, 'Sonnet 5'],
    ['claude-haiku-4-5-20251001', undefined, 'Haiku 4.5'],
    ['openai/gpt-6', undefined, 'openai/gpt-6'],
    ['claude-opus-5-5', 'Opus Preview', 'Opus Preview'],
  ])('%s (catalogue %s) → %s', (id, label, want) => {
    expect(compactModelLabel(id, label)).toBe(want);
  });
});

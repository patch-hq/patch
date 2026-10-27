// Composer dictation — keyboard away, listening state visible (spec/07 §
// Dictation into the composer, spec/15 § Composer). Starting a dictation puts
// the soft keyboard away (there is nothing to type while talking); dictation is
// shown INSIDE the input as an italic mic + the words heard so far, which stay
// while the clip is transcribed and give way when the words land. Nothing is
// added above the input, and the input grows to fit the words.
//
// Drives the Composer against a fake dictation session (`dictationFactory`),
// exactly as Composer.voice.test.tsx does.

import React from 'react';
import { Keyboard, Platform, __setWindowDimensions } from 'react-native';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actAsync,
  byLabel,
  byTestId,
  byType,
  findHost,
  queryHost,
  renderRN,
  textOf,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { settingsFixture } from './testUtils/settingsFixtures';
import { __clearAllMmkv } from './stubs/mmkv';
import type { DictationHandle, DictationOutcome } from '../src/lib/dictation';
import type * as dictationModule from '../src/lib/dictation';

vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

const T0 = new Date('2026-09-24T10:00:00Z').getTime();

function makeFactory(): {
  factory: typeof dictationModule.startDictation;
  finish: ReturnType<typeof vi.fn>;
  partial: (text: string) => void;
} {
  const finish = vi.fn(async (_send: boolean) => ({ kind: 'no-audio' }) as DictationOutcome);
  let onPartial: (text: string) => void = () => undefined;
  const factory = vi.fn((_chat: string, cb: (text: string) => void): DictationHandle => {
    onPartial = cb;
    return { finish };
  }) as unknown as typeof dictationModule.startDictation;
  return { factory, finish, partial: (t) => onPartial(t) };
}

let dismissSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useSettingsStore.setState({ data: settingsFixture(), error: null });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  dismissSpy = vi.spyOn(Keyboard, 'dismiss');
});

afterEach(() => {
  dismissSpy.mockRestore();
  vi.useRealTimers();
});

const mic = (r: ReturnType<typeof renderRN>): Record<string, () => void> =>
  findHost(r.root, byLabel('Dictate into message')).props as Record<string, () => void>;

describe('Composer — the dictation engine follows the account setting', () => {
  function withDictation(dictation: {
    backend: 'local' | 'deepgram';
    phone: boolean;
    tidy: boolean;
  }): void {
    const data = settingsFixture();
    data.preferences = {
      ...data.preferences,
      voiceConfig: { ...data.preferences.voiceConfig, dictation },
    };
    useSettingsStore.setState({ data, error: null });
  }
  afterEach(() => {
    Platform.OS = 'test';
  });

  it('on Android with the phone recogniser on, the phone dictates with tidy-up as set', async () => {
    Platform.OS = 'android';
    withDictation({ backend: 'local', phone: true, tidy: true });
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    expect(factory).toHaveBeenCalledWith(
      'c1',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      { engine: 'phone', tidy: true },
    );
  });

  it('Deepgram streams, and the phone switch means nothing off Android', async () => {
    withDictation({ backend: 'deepgram', phone: true, tidy: false });
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    expect(factory).toHaveBeenCalledWith(
      'c1',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      { engine: 'stream', tidy: false },
    );
  });
});

describe('Composer — starting a dictation puts the keyboard away', () => {
  it('a tap-started dictation dismisses the keyboard', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    expect(dismissSpy).not.toHaveBeenCalled();
    await actAsync(() => mic(r)['onPress']!());
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('a hold-started dictation dismisses the keyboard', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onLongPress']!());
    await actAsync(() => findHost(r.root, byTestId('mic-menu-keep-dictating')).props.onPress());
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('the input stays editable — tapping it can bring the keyboard back', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    expect(findHost(r.root, byType('TextInput')).props['editable']).toBe(true);
  });
});

describe('Composer — dictation shown inside the input', () => {
  it('is absent at rest', () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    expect(queryHost(r.root, byTestId('dictation-preview'))).toBeNull();
  });

  it('adds no status line above the input; the field mic pulses and the words show in italic', async () => {
    const { factory, partial } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    expect(queryHost(r.root, byTestId('dictation-status'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('dictation-live-words')))).toBe('');
    expect(findHost(r.root, byTestId('mic-listening-ring'))).toBeTruthy();
    await actAsync(() => partial('buy oat'));
    const live = findHost(r.root, byTestId('dictation-live-words'));
    expect(textOf(live)).toBe('buy oat');
    expect((live.props['style'] as { fontStyle: string }).fontStyle).toBe('italic');
  });

  it('lets the field grow to near half the screen while dictating, back to the typing cap after', async () => {
    __setWindowDimensions({ height: 800 });
    const { factory, finish } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    const maxH = (): number =>
      (findHost(r.root, byType('TextInput')).props['style'] as { maxHeight: number }).maxHeight;
    expect(maxH()).toBe(200);
    await actAsync(() => mic(r)['onPress']!());
    expect(maxH()).toBe(360);
    finish.mockResolvedValueOnce({ kind: 'text', text: 'words' });
    await actAsync(() => mic(r)['onPress']!());
    expect(maxH()).toBe(200);
    __setWindowDimensions({ height: 800 });
  });

  it('keeps the words on screen while transcribing, then lands them', async () => {
    const { factory, finish, partial } = makeFactory();
    let resolve!: (o: DictationOutcome) => void;
    finish.mockReturnValueOnce(
      new Promise<DictationOutcome>((res) => {
        resolve = res;
      }),
    );
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    await actAsync(() => partial('buy oat milk'));
    await actAsync(() => {
      mic(r)['onPress']!();
    });
    expect(textOf(findHost(r.root, byTestId('dictation-live-words')))).toBe('buy oat milk');

    await actAsync(() => resolve({ kind: 'text', text: 'buy oat milk' }));
    expect(queryHost(r.root, byTestId('dictation-preview'))).toBeNull();
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('buy oat milk');
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('grows the input to the height of the dictated words', async () => {
    const { factory, partial } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    await actAsync(() => partial('a long run of words that wraps over several lines'));
    const preview = findHost(r.root, byTestId('dictation-preview'));
    let node = preview.parent;
    while (node && typeof node.props['onLayout'] !== 'function') node = node.parent;
    await actAsync(() => node!.props['onLayout']({ nativeEvent: { layout: { height: 120 } } }));
    const style = findHost(r.root, byType('TextInput')).props['style'] as { minHeight: number };
    expect(style.minHeight).toBe(120);
  });

  it('goes the moment the dictation is cleared', async () => {
    const { factory } = makeFactory();
    const r = renderRN(<Composer chatId="c1" dictationFactory={factory} />);
    await actAsync(() => mic(r)['onPress']!());
    await actAsync(() => findHost(r.root, byLabel('Clear dictation')).props['onPress']());
    expect(queryHost(r.root, byTestId('dictation-preview'))).toBeNull();
  });
});

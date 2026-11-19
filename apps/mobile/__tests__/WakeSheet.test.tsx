import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { WakeSheet } from '../src/components/WakeSheet';
import { api } from '../src/api/rest';

vi.mock('../src/api/rest', () => ({ api: { setLoop: vi.fn(async () => undefined) } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));

const byId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === id)[0]!;

describe('WakeSheet', () => {
  beforeEach(() => vi.mocked(api.setLoop).mockClear());

  it('arms a loop', async () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<WakeSheet chatId="c1" onClose={() => {}} />);
    });
    act(() => byId(r, 'wake-sheet-message').props.onChangeText('check build'));
    act(() => byId(r, 'wake-sheet-every').props.onChangeText('5m'));
    await act(async () => byId(r, 'wake-sheet-save').props.onPress());
    expect(api.setLoop).toHaveBeenCalledWith('c1', { message: 'check build', every: '5m' });
  });

  it('arms a one-shot wake at a typed time', async () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<WakeSheet chatId="c1" onClose={() => {}} />);
    });
    act(() => byId(r, 'wake-sheet-kind-at').props.onPress());
    act(() => byId(r, 'wake-sheet-message').props.onChangeText('nudge'));
    act(() => byId(r, 'wake-sheet-at').props.onChangeText('2099-01-02 09:30'));
    await act(async () => byId(r, 'wake-sheet-save').props.onPress());
    const body = vi.mocked(api.setLoop).mock.calls[0]![1] as { at: string };
    expect(new Date(body.at).getFullYear()).toBe(2099);
  });
});

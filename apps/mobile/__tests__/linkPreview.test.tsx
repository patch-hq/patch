// Link summaries on the phone (spec/14 § Message links): the Summarise button
// beside a message link, the card it expands, and the per-url session cache.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  hasText,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { LinkPreview } from '../src/components/LinkPreview';
import { __resetLinkPreviewCache, getLinkSummary } from '../src/lib/linkPreview';
import { setRoute } from '../src/config';
import { __clearAllMmkv, TEST_SERVER_URL } from './stubs/mmkv';
import { __getLinkingOpenedUrls, __resetLinkingOpenedUrls } from './stubs/react-native';

vi.mock('../src/api/rest', () => ({ api: { linkSummary: vi.fn() } }));

const URL_ = 'https://example.com/a';
const mounted: ReturnType<typeof renderRN>[] = [];
const mount = async (el: React.ReactElement) => {
  const r = renderRN(el);
  mounted.push(r);
  await flush();
  return r;
};
const open = async (r: ReturnType<typeof renderRN>) => {
  await actAsync(() => findHost(r.root, byTestId('link-summary-toggle')).props['onPress']());
  await flush();
};

beforeEach(() => {
  __clearAllMmkv();
  __resetLinkPreviewCache();
  __resetLinkingOpenedUrls();
  setRoute({ kind: 'direct', url: TEST_SERVER_URL });
  vi.mocked(api.linkSummary).mockReset();
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

describe('LinkPreview', () => {
  it('renders nothing for a non-http link', async () => {
    for (const u of ['mailto:a@b.c', '/pads/p1', 'tel:123']) {
      const r = await mount(<LinkPreview url={u} color="#000" />);
      expect(r.toJSON()).toBeNull();
    }
  });

  it('shows the Summarise and open-in-browser buttons, card closed, nothing fetched', async () => {
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    expect(queryHost(r.root, byTestId('link-summary-card'))).toBeNull();
    await actAsync(() => findHost(r.root, byTestId('link-preview-external')).props['onPress']());
    expect(__getLinkingOpenedUrls()).toEqual([URL_]);
    expect(api.linkSummary).not.toHaveBeenCalled();
  });

  it('shows Summarising…, then the summary and host', async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(api.linkSummary).mockReturnValue(new Promise((res) => (resolve = res)) as never);
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    expect(api.linkSummary).toHaveBeenCalledWith(URL_);
    const loading = findHost(r.root, byTestId('link-summary-card'));
    expect(hasText(loading, 'Summarising…')).toBe(true);
    await actAsync(() => resolve({ url: URL_, summary: 'A short summary.' }));
    await flush();
    const card = findHost(r.root, byTestId('link-summary-card'));
    expect(hasText(findHost(card, byTestId('link-summary-text')), 'A short summary.')).toBe(true);
    expect(hasText(card, 'Summarising…')).toBe(false);
    expect(hasText(card, new URL(URL_).host)).toBe(true);
  });

  it('shows the error text when the summary fails', async () => {
    vi.mocked(api.linkSummary).mockRejectedValue(new Error('summary_failed'));
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    expect(hasText(findHost(r.root, byTestId('link-summary-error')), 'summary_failed')).toBe(true);
  });

  it('toggling again hides the card; a second mount of the same url does not resummarise', async () => {
    vi.mocked(api.linkSummary).mockResolvedValue({ url: URL_, summary: 'S' });
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    await open(r);
    expect(queryHost(r.root, byTestId('link-summary-card'))).toBeNull();
    const r2 = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r2);
    expect(hasText(findHost(r2.root, byTestId('link-summary-card')), 'S')).toBe(true);
    expect(api.linkSummary).toHaveBeenCalledTimes(1);
  });

  it('a failed summary is not cached, so a later open retries', async () => {
    vi.mocked(api.linkSummary).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(api.linkSummary).mockResolvedValueOnce({ url: URL_, summary: 'OK' });
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    await open(r);
    await open(r);
    expect(hasText(findHost(r.root, byTestId('link-summary-card')), 'OK')).toBe(true);
    expect(api.linkSummary).toHaveBeenCalledTimes(2);
  });
});

describe('getLinkSummary', () => {
  it('summarises again once the prompt has changed', async () => {
    vi.mocked(api.linkSummary).mockResolvedValue({ url: URL_, summary: 'S' });
    await getLinkSummary(URL_, 'one');
    await getLinkSummary(URL_, 'one');
    await getLinkSummary(URL_, 'two');
    expect(api.linkSummary).toHaveBeenCalledTimes(2);
  });
});

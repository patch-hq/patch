// Rich link previews on the phone (spec/14 § Message links): the toggle beside
// a message link, the card it expands, the per-url session cache, and the
// authenticated image request.

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
import { __resetLinkPreviewCache, previewImageSource } from '../src/lib/linkPreview';
import { setRoute } from '../src/config';
import { saveCredential } from '../src/lib/credential';
import { __clearAllMmkv, TEST_SERVER_URL } from './stubs/mmkv';
import { __getLinkingOpenedUrls, __resetLinkingOpenedUrls } from './stubs/react-native';

vi.mock('../src/api/rest', () => ({ api: { linkPreview: vi.fn() } }));

const URL_ = 'https://example.com/a';
const mounted: ReturnType<typeof renderRN>[] = [];
const mount = async (el: React.ReactElement) => {
  const r = renderRN(el);
  mounted.push(r);
  await flush();
  return r;
};
const open = async (r: ReturnType<typeof renderRN>) => {
  await actAsync(() => findHost(r.root, byTestId('link-preview-toggle')).props['onPress']());
  await flush();
};

beforeEach(() => {
  __clearAllMmkv();
  __resetLinkPreviewCache();
  __resetLinkingOpenedUrls();
  setRoute({ kind: 'direct', url: TEST_SERVER_URL });
  vi.mocked(api.linkPreview).mockReset();
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

  it('shows the toggle and open-in-browser, card closed', async () => {
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    expect(queryHost(r.root, byTestId('link-preview-card'))).toBeNull();
    await actAsync(() => findHost(r.root, byTestId('link-preview-external')).props['onPress']());
    expect(__getLinkingOpenedUrls()).toEqual([URL_]);
    expect(api.linkPreview).not.toHaveBeenCalled();
  });

  it('loading, then title, description and an authenticated image', async () => {
    saveCredential('jwt-1');
    let resolve!: (v: unknown) => void;
    vi.mocked(api.linkPreview).mockReturnValue(new Promise((res) => (resolve = res)) as never);
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    expect(hasText(findHost(r.root, byTestId('link-preview-card')), 'Loading preview…')).toBe(true);
    await actAsync(() =>
      resolve({ url: URL_, title: 'Title', description: 'Desc', image: 'https://i/x.png' }),
    );
    await flush();
    const card = findHost(r.root, byTestId('link-preview-card'));
    expect(hasText(card, 'Title')).toBe(true);
    expect(hasText(card, 'Desc')).toBe(true);
    expect(hasText(card, 'Loading preview…')).toBe(false);
    const img = findHost(r.root, byTestId('link-preview-image'));
    expect(img.props['source']).toEqual({
      uri: `${TEST_SERVER_URL}/api/link-preview/image?url=${encodeURIComponent('https://i/x.png')}`,
      headers: { authorization: 'Bearer jwt-1' },
    });
  });

  it("shows the page's own text excerpt and host", async () => {
    vi.mocked(api.linkPreview).mockResolvedValue({
      url: URL_,
      title: 'Title',
      excerpt: 'The opening of the article.',
    });
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    const card = findHost(r.root, byTestId('link-preview-card'));
    expect(
      hasText(findHost(card, byTestId('link-preview-excerpt')), 'The opening of the article.'),
    ).toBe(true);
    expect(hasText(card, new URL(URL_).host)).toBe(true);
  });

  it('shows the error text when the fetch fails', async () => {
    vi.mocked(api.linkPreview).mockRejectedValue(new Error('bad_gateway'));
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    expect(hasText(findHost(r.root, byTestId('link-preview-card')), 'bad_gateway')).toBe(true);
  });

  it('says so when the page has no title, description or image', async () => {
    vi.mocked(api.linkPreview).mockResolvedValue({ url: URL_ });
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    expect(hasText(findHost(r.root, byTestId('link-preview-card')), 'No preview available')).toBe(
      true,
    );
  });

  it('toggling again hides the card; a second mount of the same url does not refetch', async () => {
    vi.mocked(api.linkPreview).mockResolvedValue({ url: URL_, title: 'T' });
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    await open(r);
    expect(queryHost(r.root, byTestId('link-preview-card'))).toBeNull();
    const r2 = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r2);
    expect(hasText(findHost(r2.root, byTestId('link-preview-card')), 'T')).toBe(true);
    expect(api.linkPreview).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch is not cached, so a later open retries', async () => {
    vi.mocked(api.linkPreview).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(api.linkPreview).mockResolvedValueOnce({ url: URL_, title: 'OK' });
    const r = await mount(<LinkPreview url={URL_} color="#000" />);
    await open(r);
    await open(r);
    await open(r);
    expect(hasText(findHost(r.root, byTestId('link-preview-card')), 'OK')).toBe(true);
    expect(api.linkPreview).toHaveBeenCalledTimes(2);
  });
});

describe('previewImageSource', () => {
  it('throws without a credential rather than requesting unauthenticated', () => {
    expect(() => previewImageSource('https://i/x.png')).toThrow(/credential/i);
  });
});

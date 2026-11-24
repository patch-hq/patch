// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PINCH_ZOOM_JS } from '../src/lib/pinchZoom';

describe('PINCH_ZOOM_JS', () => {
  it('replaces a locked viewport with a zoomable one', () => {
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, user-scalable=no">';
    eval(PINCH_ZOOM_JS);
    const c = document.querySelector('meta[name="viewport"]')!.getAttribute('content')!;
    expect(c).toContain('user-scalable=yes');
    expect(c).toContain('maximum-scale=10');
    expect(c).not.toContain('user-scalable=no');
  });
  it('adds a viewport when the page has none', () => {
    document.head.innerHTML = '';
    eval(PINCH_ZOOM_JS);
    expect(document.querySelectorAll('meta[name="viewport"]').length).toBe(1);
  });
});

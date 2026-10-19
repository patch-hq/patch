// Right-click on the full-size image viewer opens the app's own menu
// (todoist 6hpP3pfcH9r4Wfj6 — "patch should be able to right click on an image
// when viewing it big"). Copy image and download are otherwise only reachable
// from the corner buttons; the menu puts them under the pointer.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ImageLightbox } from '../components/ImageLightbox.js';
import * as copyImage from '../lib/copyImage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ImageLightbox right-click menu', () => {
  it('opens the menu instead of the browser menu, and Copy image copies', async () => {
    const copy = vi.spyOn(copyImage, 'copyImageToClipboard').mockResolvedValue();
    const onClose = vi.fn();
    render(<ImageLightbox url="/a.png" alt="pic" onClose={onClose} />);
    const notPrevented = fireEvent.contextMenu(screen.getByAltText('pic'), {
      clientX: 40,
      clientY: 50,
    });
    expect(notPrevented).toBe(false);
    expect(screen.getByTestId('lightbox-menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /copy image/i }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('/a.png'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lightbox-menu')).toBeNull();
  });

  it('offers a download of the original image', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ImageLightbox url="/a.png" alt="pic" downloadName="x.png" onClose={() => {}} />);
    fireEvent.contextMenu(screen.getByAltText('pic'), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /download image/i }));
    expect(click).toHaveBeenCalled();
  });

  it('Esc closes only the menu; a second Esc closes the viewer', () => {
    const onClose = vi.fn();
    render(<ImageLightbox url="/a.png" alt="pic" onClose={onClose} />);
    fireEvent.contextMenu(screen.getByAltText('pic'), { clientX: 40, clientY: 50 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('lightbox-menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

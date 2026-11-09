// todoist 6hrjv5Pmw6V84gv6 — "once zoomed into an image, scrolling it resets
// the zoom". A scroll while zoomed pans the image; it must not change the zoom.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ImageLightbox } from '../components/ImageLightbox.js';

afterEach(cleanup);

const transform = (): string => screen.getByAltText('pic').style.transform;

describe('ImageLightbox wheel', () => {
  it('scrolling while zoomed pans and keeps the zoom', () => {
    render(<ImageLightbox url="/a.png" alt="pic" onClose={vi.fn()} />);
    fireEvent.click(screen.getByAltText('pic'));
    expect(transform()).toContain('scale(2.5)');
    fireEvent.wheel(screen.getByAltText('pic'), { deltaY: 100, deltaX: 20 });
    expect(transform()).toContain('scale(2.5)');
    expect(transform()).toContain('translate(-20px, -100px)');
  });

  it('scrolling a fitted image still zooms it in', () => {
    render(<ImageLightbox url="/a.png" alt="pic" onClose={vi.fn()} />);
    fireEvent.wheel(screen.getByAltText('pic'), { deltaY: -100 });
    expect(transform()).not.toContain('scale(1)');
  });

  it('pinch (ctrl+wheel) changes the zoom while zoomed', () => {
    render(<ImageLightbox url="/a.png" alt="pic" onClose={vi.fn()} />);
    fireEvent.click(screen.getByAltText('pic'));
    fireEvent.wheel(screen.getByAltText('pic'), { deltaY: 50, ctrlKey: true });
    expect(transform()).not.toContain('scale(2.5)');
  });
});

describe('ImageLightbox drag', () => {
  it('dragging a zoomed image pans it and keeps the zoom after release', () => {
    render(<ImageLightbox url="/a.png" alt="pic" onClose={vi.fn()} />);
    const img = screen.getByAltText('pic');
    img.setPointerCapture = vi.fn();
    fireEvent.click(img);
    fireEvent.pointerDown(img, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(img, { clientX: 140, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(img, { pointerId: 1 });
    fireEvent.click(img);
    expect(transform()).toContain('scale(2.5)');
    expect(transform()).toContain('translate(40px, 20px)');
  });

  it('a plain click on a zoomed image still resets it', () => {
    render(<ImageLightbox url="/a.png" alt="pic" onClose={vi.fn()} />);
    const img = screen.getByAltText('pic');
    img.setPointerCapture = vi.fn();
    fireEvent.click(img);
    fireEvent.pointerDown(img, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(img, { pointerId: 1 });
    fireEvent.click(img);
    expect(transform()).toContain('scale(1)');
  });
});

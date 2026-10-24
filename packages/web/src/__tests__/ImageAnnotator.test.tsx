// jsdom has no image decoder or canvas backend, so — same convention as
// imageResize.test.ts — we stub `createImageBitmap` (report a decoded size)
// and the canvas 2d/toBlob surface (capture draw calls, hand back a blob).
// `getBoundingClientRect` is stubbed 1:1 with the canvas's own width/height so
// screen-space pointer coordinates equal canvas-space coordinates, making the
// drawing interactions deterministic without real layout. The real pixel work
// (does a dragged box actually look like a box) is exercised against a browser
// in e2e/screenshot-markup.spec.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImageAnnotator } from '../components/ImageAnnotator.js';

let ctx: {
  clearRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
};
let getContextSpy: ReturnType<typeof vi.spyOn>;
let rectSpy: ReturnType<typeof vi.spyOn>;
let toBlobSpy: ReturnType<typeof vi.spyOn>;
let capturePointerSpy: ReturnType<typeof vi.fn>;

function stubDecode(width: number, height: number): void {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn(async () => ({
    width,
    height,
    close: vi.fn(),
  }));
}

beforeEach(() => {
  ctx = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    fillRect: vi.fn(),
  };
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext' as never)
    .mockReturnValue(ctx as never);
  rectSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLCanvasElement) {
      return {
        left: 0,
        top: 0,
        width: this.width,
        height: this.height,
        right: this.width,
        bottom: this.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
  toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    cb: BlobCallback,
  ) {
    cb(new Blob(['png-bytes'], { type: 'image/png' }));
  });
  // jsdom doesn't implement pointer capture.
  capturePointerSpy = vi.fn();
  Element.prototype.setPointerCapture = capturePointerSpy;
});

afterEach(() => {
  getContextSpy.mockRestore();
  rectSpy.mockRestore();
  toBlobSpy.mockRestore();
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
});

const file = new File(['bytes'], 'photo.png', { type: 'image/png' });

describe('ImageAnnotator', () => {
  it('decodes the file and sizes the canvas to its natural resolution', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = (await screen.findByTestId('annotator-canvas')) as HTMLCanvasElement;
    await waitFor(() => {
      expect(canvas.width).toBe(400);
      expect(canvas.height).toBe(300);
    });
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it('defaults to the box tool and switches on click', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    await screen.findByTestId('annotator-canvas');
    expect(screen.getByLabelText('Box tool').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByLabelText('Arrow tool'));
    expect(screen.getByLabelText('Arrow tool').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Box tool').getAttribute('aria-pressed')).toBe('false');
  });

  it('selecting a color marks it active', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    await screen.findByTestId('annotator-canvas');
    const swatches = screen.getAllByLabelText(/^Color /);
    expect(swatches[0]!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(swatches[2]!);
    expect(swatches[2]!.getAttribute('aria-pressed')).toBe('true');
    expect(swatches[0]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('dragging with the box tool commits a shape and enables undo', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    expect((screen.getByLabelText('Undo last mark') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 60 });
    fireEvent.pointerUp(canvas, { clientX: 80, clientY: 60 });
    expect((screen.getByLabelText('Undo last mark') as HTMLButtonElement).disabled).toBe(false);
    expect(ctx.strokeRect).toHaveBeenCalled();
  });

  it('undo removes the last committed shape', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 60 });
    fireEvent.pointerUp(canvas, { clientX: 80, clientY: 60 });
    const undo = screen.getByLabelText('Undo last mark') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(undo.disabled).toBe(true);
  });

  async function drawBox(canvas: HTMLElement): Promise<void> {
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 60 });
    fireEvent.pointerUp(canvas, { clientX: 80, clientY: 60 });
  }

  it('Cmd+Z and Ctrl+Z undo the last mark', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    const undo = screen.getByLabelText('Undo last mark') as HTMLButtonElement;
    await drawBox(canvas);
    await drawBox(canvas);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(undo.disabled).toBe(false);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(undo.disabled).toBe(true);
  });

  it('Cmd+Shift+Z redoes an undone mark, and a new mark clears redo', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    const undo = screen.getByLabelText('Undo last mark') as HTMLButtonElement;
    const redo = screen.getByLabelText('Redo') as HTMLButtonElement;
    expect(redo.disabled).toBe(true);
    await drawBox(canvas);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(false);
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await drawBox(canvas);
    expect(redo.disabled).toBe(true);
  });

  it('Cmd+Z inside the text input is left to the input', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    await drawBox(canvas);
    fireEvent.click(screen.getByLabelText('Text tool'));
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40 });
    await screen.findByTestId('annotator-text-input');
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect((screen.getByLabelText('Undo last mark') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a click without dragging leaves no empty box or arrow behind', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    for (const tool of ['Box tool', 'Arrow tool']) {
      fireEvent.click(screen.getByLabelText(tool));
      fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
      fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });
    }
    expect((screen.getByLabelText('Undo last mark') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the text tool opens an inline input at the click point; Enter commits it', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    fireEvent.click(screen.getByLabelText('Text tool'));
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40 });
    const input = await screen.findByTestId('annotator-text-input');
    fireEvent.change(input, { target: { value: 'over here' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId('annotator-text-input')).toBeNull();
    expect(ctx.fillText).toHaveBeenCalledWith('over here', 30, 40);
    expect((screen.getByLabelText('Undo last mark') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Escape closes the text input without committing a shape', async () => {
    stubDecode(400, 300);
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('annotator-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBe(400));
    fireEvent.click(screen.getByLabelText('Text tool'));
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40 });
    const input = await screen.findByTestId('annotator-text-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('annotator-text-input')).toBeNull();
    expect((screen.getByLabelText('Undo last mark') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the cancel button calls onCancel', async () => {
    stubDecode(400, 300);
    const onCancel = vi.fn();
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={onCancel} />);
    await screen.findByTestId('annotator-canvas');
    fireEvent.click(screen.getByTestId('annotator-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onCancel when no text input is open', async () => {
    stubDecode(400, 300);
    const onCancel = vi.fn();
    render(<ImageAnnotator file={file} onDone={() => {}} onCancel={onCancel} />);
    await screen.findByTestId('annotator-canvas');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Done exports a flattened PNG named "<base>-annotated.png"', async () => {
    stubDecode(400, 300);
    const onDone = vi.fn();
    render(<ImageAnnotator file={file} onDone={onDone} onCancel={() => {}} />);
    await screen.findByTestId('annotator-canvas');
    fireEvent.click(screen.getByTestId('annotator-done'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const out = onDone.mock.calls[0]![0] as File;
    expect(out.name).toBe('photo-annotated.png');
    expect(out.type).toBe('image/png');
  });

  describe('without a file (blank sketch)', () => {
    it('shows a white page without decoding anything', async () => {
      stubDecode(1, 1);
      render(<ImageAnnotator onDone={() => {}} onCancel={() => {}} />);
      const canvas = (await screen.findByTestId('annotator-canvas')) as HTMLCanvasElement;
      await waitFor(() => expect(canvas.width).toBeGreaterThan(0));
      expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
      expect(ctx.drawImage).not.toHaveBeenCalled();
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    });

    it('draws marks and Done exports a "sketch-*.png"', async () => {
      const onDone = vi.fn();
      render(<ImageAnnotator onDone={onDone} onCancel={() => {}} />);
      const canvas = await screen.findByTestId('annotator-canvas');
      fireEvent.click(screen.getByLabelText('Box tool'));
      fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 60, clientY: 50, pointerId: 1 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      await waitFor(() => expect(ctx.strokeRect).toHaveBeenCalledWith(10, 10, 50, 40));
      fireEvent.click(screen.getByTestId('annotator-done'));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      const out = onDone.mock.calls[0]![0] as File;
      expect(out.name).toMatch(/^sketch-\d+\.png$/);
      expect(out.type).toBe('image/png');
    });
  });
});

// Image annotator lib (spec/15 § Composer — attachments): the page the WebView
// loads, the messages it posts back, and the shape helpers it draws with.

import { describe, it, expect } from 'vitest';
import {
  ANNOTATOR_COLORS,
  ANNOTATOR_SHAPES_SRC,
  annotatedName,
  buildAnnotatorHtml,
  imageDataUri,
  parseAnnotatorMessage,
} from '../src/lib/imageAnnotator';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

interface Shapes {
  lineWidthFor(w: number): number;
  fontSizeFor(w: number): number;
  fitSize(w: number, h: number, mw: number, mh: number): { width: number; height: number };
  toImagePoint(
    x: number,
    y: number,
    r: { left: number; top: number; width: number; height: number },
    cw: number,
    ch: number,
  ): { x: number; y: number };
  startShape(tool: string, p: { x: number; y: number }, color: string): Record<string, unknown>;
  extendShape(s: Record<string, unknown>, p: { x: number; y: number }): Record<string, unknown>;
  arrowHead(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    lw: number,
  ): Array<{ x: number; y: number }>;
  drawShape(ctx: unknown, s: Record<string, unknown>, lw: number, fs: number): void;
}
const shapes = new Function(
  `${ANNOTATOR_SHAPES_SRC}; return { lineWidthFor, fontSizeFor, fitSize, toImagePoint, startShape, extendShape, arrowHead, drawShape };`,
)() as Shapes;

function fakeCtx(): { calls: string[]; ctx: Record<string, unknown> } {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {};
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'closePath', 'fill']) {
    ctx[m] = (...a: unknown[]) => calls.push(`${m}(${a.join(',')})`);
  }
  ctx['strokeRect'] = (...a: unknown[]) => calls.push(`strokeRect(${a.join(',')})`);
  ctx['fillText'] = (...a: unknown[]) => calls.push(`fillText(${a.join(',')})`);
  return { calls, ctx };
}

describe('annotatedName', () => {
  it('swaps the extension for -annotated.png', () => {
    expect(annotatedName('shot.jpg')).toBe('shot-annotated.png');
    expect(annotatedName('a.b.png')).toBe('a.b-annotated.png');
  });
  it('names an extensionless or empty base image', () => {
    expect(annotatedName('shot')).toBe('shot-annotated.png');
    expect(annotatedName('.png')).toBe('image-annotated.png');
  });
});

describe('imageDataUri', () => {
  it('builds a data URI for an image', () => {
    expect(imageDataUri('AAAA', 'image/jpeg')).toBe('data:image/jpeg;base64,AAAA');
  });
  it('refuses a non-image type or non-base64 body', () => {
    expect(() => imageDataUri('AAAA', 'text/html')).toThrow(/not an image/);
    expect(() => imageDataUri('A"></script>', 'image/png')).toThrow(/not an image/);
  });
});

describe('buildAnnotatorHtml', () => {
  const html = buildAnnotatorHtml(PNG);

  it('has every tool, all five colours, undo, done and cancel', () => {
    for (const label of ['Box tool', 'Arrow tool', 'Freehand tool', 'Text tool']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    for (const c of ANNOTATOR_COLORS) expect(html).toContain(`data-color="${c}"`);
    expect(ANNOTATOR_COLORS).toHaveLength(5);
    expect(html).toContain('id="undo"');
    expect(html).toContain('id="done"');
    expect(html).toContain('id="cancel"');
  });

  it('embeds the data URI once, as a JSON string', () => {
    expect(html).toContain(`var IMAGE = ${JSON.stringify(PNG)};`);
  });

  it('posts done with a PNG data URL, and cancel, through ReactNativeWebView', () => {
    expect(html).toContain("canvas.toDataURL('image/png')");
    expect(html).toContain("post({ type: 'cancel' })");
    expect(html).toContain('window.ReactNativeWebView.postMessage');
  });

  it('reports script and image errors rather than swallowing them', () => {
    expect(html).toContain('window.onerror');
    expect(html).toContain('the image could not be decoded');
  });

  it('is a script that parses', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(500);
    expect(() => new Function(script)).not.toThrow();
  });

  it('builds a blank-page sketch when given no source, with a parseable script', () => {
    const blank = buildAnnotatorHtml(null);
    expect(blank).toContain('var IMAGE = null;');
    const script = blank.slice(blank.indexOf('<script>') + 8, blank.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });

  it('refuses a source that is not an image data URI', () => {
    expect(() => buildAnnotatorHtml('https://x/y.png')).toThrow(/not an image data URI/);
    expect(() => buildAnnotatorHtml('data:image/png;base64,AA"</script><script>x')).toThrow();
  });

  it('keeps the page script free of a stray closing script tag', () => {
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe('parseAnnotatorMessage', () => {
  it('parses done with its PNG and size', () => {
    expect(
      parseAnnotatorMessage(JSON.stringify({ type: 'done', png: PNG, width: 4, height: 3 })),
    ).toEqual({
      type: 'done',
      png: PNG,
      width: 4,
      height: 3,
    });
  });
  it('parses cancel and error', () => {
    expect(parseAnnotatorMessage('{"type":"cancel"}')).toEqual({ type: 'cancel' });
    expect(parseAnnotatorMessage('{"type":"error","message":"boom"}')).toEqual({
      type: 'error',
      message: 'boom',
    });
  });
  it.each([
    ['not json', 'nope', /not JSON/],
    ['a bare string', '"cancel"', /not an object/],
    ['null', 'null', /not an object/],
    ['unknown type', '{"type":"wat"}', /unknown message type wat/],
    ['no type', '{}', /unknown message type/],
    ['error without message', '{"type":"error"}', /error message missing/],
    ['done without png', '{"type":"done","width":1,"height":1}', /no PNG/],
    [
      'done with a jpeg',
      JSON.stringify({ type: 'done', png: 'data:image/jpeg;base64,AA', width: 1, height: 1 }),
      /no PNG/,
    ],
    ['done without size', JSON.stringify({ type: 'done', png: PNG }), /no size/],
    [
      'done with zero size',
      JSON.stringify({ type: 'done', png: PNG, width: 0, height: 5 }),
      /no size/,
    ],
  ])('throws on %s', (_n, raw, re) => {
    expect(() => parseAnnotatorMessage(raw)).toThrow(re);
  });
});

describe('page shape helpers (evaluated)', () => {
  it('scales line width and font with the image, with floors', () => {
    expect(shapes.lineWidthFor(100)).toBe(3);
    expect(shapes.lineWidthFor(2600)).toBe(10);
    expect(shapes.fontSizeFor(100)).toBe(18);
    expect(shapes.fontSizeFor(3200)).toBe(100);
  });

  it('fits an image into a box, growing or shrinking', () => {
    expect(shapes.fitSize(100, 50, 200, 200)).toEqual({ width: 200, height: 100 });
    expect(shapes.fitSize(1000, 2000, 100, 100)).toEqual({ width: 50, height: 100 });
  });

  it('maps a touch to image pixels', () => {
    const rect = { left: 10, top: 20, width: 100, height: 50 };
    expect(shapes.toImagePoint(60, 45, rect, 1000, 500)).toEqual({ x: 500, y: 250 });
  });

  it('starts and extends each dragged shape', () => {
    const p0 = { x: 1, y: 2 };
    const p1 = { x: 11, y: 7 };
    expect(shapes.extendShape(shapes.startShape('box', p0, '#f00'), p1)).toEqual({
      kind: 'box',
      x: 1,
      y: 2,
      w: 10,
      h: 5,
      color: '#f00',
    });
    expect(shapes.extendShape(shapes.startShape('arrow', p0, '#f00'), p1)).toEqual({
      kind: 'arrow',
      x1: 1,
      y1: 2,
      x2: 11,
      y2: 7,
      color: '#f00',
    });
    expect(shapes.extendShape(shapes.startShape('pen', p0, '#f00'), p1)).toEqual({
      kind: 'pen',
      points: [p0, p1],
      color: '#f00',
    });
    expect(() => shapes.startShape('text', p0, '#f00')).toThrow(/no drag shape/);
  });

  it('puts the arrow head behind the tip, symmetric about the shaft', () => {
    const [a, b] = shapes.arrowHead(0, 0, 100, 0, 3);
    expect(a!.x).toBeCloseTo(b!.x);
    expect(a!.y).toBeCloseTo(-b!.y);
    expect(a!.x).toBeLessThan(100);
  });

  it('draws a box, an arrow, a pen stroke and text', () => {
    const box = fakeCtx();
    shapes.drawShape(box.ctx, { kind: 'box', x: 1, y: 2, w: 3, h: 4, color: '#f00' }, 3, 18);
    expect(box.calls).toEqual(['strokeRect(1,2,3,4)']);
    expect(box.ctx['strokeStyle']).toBe('#f00');
    expect(box.ctx['lineWidth']).toBe(3);

    const arrow = fakeCtx();
    shapes.drawShape(
      arrow.ctx,
      { kind: 'arrow', x1: 0, y1: 0, x2: 50, y2: 0, color: '#000' },
      3,
      18,
    );
    expect(arrow.calls.filter((c) => c === 'stroke()')).toHaveLength(1);
    expect(arrow.calls).toContain('fill()');

    const pen = fakeCtx();
    shapes.drawShape(
      pen.ctx,
      {
        kind: 'pen',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 0 },
        ],
        color: '#000',
      },
      3,
      18,
    );
    expect(pen.calls).toEqual([
      'beginPath()',
      'moveTo(0,0)',
      'lineTo(1,1)',
      'lineTo(2,0)',
      'stroke()',
    ]);

    const dot = fakeCtx();
    shapes.drawShape(dot.ctx, { kind: 'pen', points: [{ x: 0, y: 0 }], color: '#000' }, 3, 18);
    expect(dot.calls).toEqual([]);

    const text = fakeCtx();
    shapes.drawShape(text.ctx, { kind: 'text', x: 5, y: 6, text: 'hi', color: '#000' }, 3, 20);
    expect(text.calls).toEqual(['fillText(hi,5,6)']);
    expect(text.ctx['font']).toBe('700 20px sans-serif');
  });
});

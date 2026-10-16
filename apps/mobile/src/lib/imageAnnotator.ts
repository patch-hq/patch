// Image annotator (spec/15 § Composer — attachments). The phone twin of
// packages/web/src/components/ImageAnnotator.tsx: box, arrow, freehand and
// text marks over a pending image attachment, flattened to a PNG on Done.
//
// The drawing happens in a WebView page built here as one self-contained HTML
// string, so the phone gets a real <canvas> without a native dependency. Marks
// live in IMAGE-pixel space (not screen space) and share the web's shape model
// and drawing code, so the exported PNG is full resolution however small the
// image is shown. The page talks back through ReactNativeWebView.postMessage;
// `parseAnnotatorMessage` is the one place those messages are decoded, and a
// message that is not one of the three known shapes throws.

/** Preset palette — same five swatches as the web annotator. */
export const ANNOTATOR_COLORS = ['#e0393e', '#f5a623', '#3d8bfd', '#2ecc71', '#111111'] as const;

export type AnnotatorMessage =
  | { type: 'done'; png: string; width: number; height: number }
  | { type: 'cancel' }
  | { type: 'error'; message: string };

const PNG_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const IMAGE_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/i;

/** `<base>-annotated.png`, the name the flattened attachment is given. */
export function annotatedName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'image';
  return `${base}-annotated.png`;
}

/** `sketch-<timestamp>.png`, the name a sketch drawn on a blank page is given. */
export function sketchName(now: number = Date.now()): string {
  return `sketch-${now}.png`;
}

/** The data URI the page loads the source image from. */
export function imageDataUri(base64: string, mimeType: string): string {
  const uri = `data:${mimeType};base64,${base64}`;
  if (!IMAGE_DATA_URI.test(uri)) {
    throw new Error(`annotator: not an image that can be embedded (${mimeType})`);
  }
  return uri;
}

/** Decode one WebView message. Throws on anything the page should never send. */
export function parseAnnotatorMessage(raw: string): AnnotatorMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('annotator: message is not JSON');
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error('annotator: message is not an object');
  }
  const m = data as Record<string, unknown>;
  if (m['type'] === 'cancel') return { type: 'cancel' };
  if (m['type'] === 'error') {
    if (typeof m['message'] !== 'string') throw new Error('annotator: error message missing');
    return { type: 'error', message: m['message'] };
  }
  if (m['type'] === 'done') {
    const { png, width, height } = m;
    if (typeof png !== 'string' || !PNG_DATA_URI.test(png)) {
      throw new Error('annotator: done message carries no PNG');
    }
    if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) {
      throw new Error('annotator: done message carries no size');
    }
    return { type: 'done', png, width, height };
  }
  throw new Error(`annotator: unknown message type ${String(m['type'])}`);
}

/**
 * The shape model and drawing code, as page source. Kept as a string-exported
 * module of pure functions so a unit test can evaluate it without a browser.
 * Mirrors drawShape / drawArrow / lineWidth / fontSize in the web annotator.
 */
export const ANNOTATOR_SHAPES_SRC = `
function lineWidthFor(imageWidth) { return Math.max(3, Math.round(imageWidth / 260)); }
function fontSizeFor(imageWidth) { return Math.max(18, Math.round(imageWidth / 32)); }
function fitSize(w, h, maxW, maxH) {
  var scale = Math.min(maxW / w, maxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}
function toImagePoint(clientX, clientY, rect, canvasW, canvasH) {
  return {
    x: (clientX - rect.left) * (canvasW / rect.width),
    y: (clientY - rect.top) * (canvasH / rect.height)
  };
}
function startShape(tool, p, color) {
  if (tool === 'box') return { kind: 'box', x: p.x, y: p.y, w: 0, h: 0, color: color };
  if (tool === 'arrow') return { kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: color };
  if (tool === 'pen') return { kind: 'pen', points: [p], color: color };
  throw new Error('no drag shape for tool ' + tool);
}
function extendShape(s, p) {
  if (s.kind === 'box') return { kind: 'box', x: s.x, y: s.y, w: p.x - s.x, h: p.y - s.y, color: s.color };
  if (s.kind === 'arrow') return { kind: 'arrow', x1: s.x1, y1: s.y1, x2: p.x, y2: p.y, color: s.color };
  if (s.kind === 'pen') return { kind: 'pen', points: s.points.concat([p]), color: s.color };
  return s;
}
function arrowHead(x1, y1, x2, y2, lineWidth) {
  var angle = Math.atan2(y2 - y1, x2 - x1);
  var headLen = Math.max(10, lineWidth * 4);
  return [
    { x: x2 - headLen * Math.cos(angle - Math.PI / 6), y: y2 - headLen * Math.sin(angle - Math.PI / 6) },
    { x: x2 - headLen * Math.cos(angle + Math.PI / 6), y: y2 - headLen * Math.sin(angle + Math.PI / 6) }
  ];
}
function drawArrow(ctx, x1, y1, x2, y2, lineWidth) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  var h = arrowHead(x1, y1, x2, y2, lineWidth);
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(h[0].x, h[0].y); ctx.lineTo(h[1].x, h[1].y);
  ctx.closePath(); ctx.fill();
}
function drawShape(ctx, s, lineWidth, fontSize) {
  ctx.lineWidth = lineWidth; ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.kind === 'box') { ctx.strokeRect(s.x, s.y, s.w, s.h); }
  else if (s.kind === 'arrow') { drawArrow(ctx, s.x1, s.y1, s.x2, s.y2, lineWidth); }
  else if (s.kind === 'pen') {
    if (s.points.length < 2) return;
    ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
    for (var i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
  } else {
    ctx.font = '700 ' + fontSize + 'px sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText(s.text, s.x, s.y);
  }
}
`;

const PAGE_CSS = `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:#111;color:#fff;font-family:sans-serif;overflow:hidden}
body{display:flex;flex-direction:column}
#bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px;background:#1c1c1c}
#bar .group{display:flex;align-items:center;gap:6px}
button{background:#2b2b2b;color:#fff;border:0;border-radius:8px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;padding:0;font-size:16px}
button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
button.active{background:#fff;color:#111}
button:disabled{opacity:.35}
button.swatch{width:28px;height:28px;border-radius:14px;border:2px solid transparent}
button.swatch.active{border-color:#fff}
button#done{width:auto;padding:0 14px;background:#2ecc71;color:#111;font-weight:700}
#wrap{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
canvas{touch-action:none;background:#000}
#label{position:absolute;display:none;min-width:120px;font:700 18px sans-serif;background:rgba(255,255,255,.9);border:1px solid #888;border-radius:4px;padding:2px 6px}
`;

const ICON = {
  box: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

function pageScript(imageJson: string, colorsJson: string): string {
  return `
${ANNOTATOR_SHAPES_SRC}
var IMAGE = ${imageJson}; // null: sketch on a blank white page
var COLORS = ${colorsJson};
function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
window.onerror = function (msg) { post({ type: 'error', message: String(msg) }); };
var canvas = document.getElementById('canvas');
var ctx = canvas.getContext('2d');
var label = document.getElementById('label');
var undoBtn = document.getElementById('undo');
var img = new Image();
var tool = 'box';
var color = COLORS[0];
var shapes = [];
var draft = null;
var drawing = false;
var textAt = null;
function ready() { return IMAGE === null || img.complete; }
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (IMAGE === null) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  else ctx.drawImage(img, 0, 0);
  var lw = lineWidthFor(canvas.width), fs = fontSizeFor(canvas.width);
  for (var i = 0; i < shapes.length; i++) drawShape(ctx, shapes[i], lw, fs);
  if (draft) drawShape(ctx, draft, lw, fs);
  undoBtn.disabled = shapes.length === 0;
}
function fit() {
  var wrap = document.getElementById('wrap');
  var s = fitSize(canvas.width, canvas.height, wrap.clientWidth * 0.96, wrap.clientHeight * 0.96);
  canvas.style.width = s.width + 'px';
  canvas.style.height = s.height + 'px';
}
function point(e) {
  return toImagePoint(e.clientX, e.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);
}
function setActive(group, attr, value) {
  var els = document.querySelectorAll(group);
  for (var i = 0; i < els.length; i++) els[i].classList.toggle('active', els[i].getAttribute(attr) === value);
}
function commitText() {
  if (textAt && label.value.trim()) {
    shapes.push({ kind: 'text', x: textAt.x, y: textAt.y, text: label.value.trim(), color: color });
  }
  textAt = null; label.style.display = 'none'; label.value = '';
  redraw();
}
img.onload = function () { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; fit(); redraw(); };
img.onerror = function () { post({ type: 'error', message: 'the image could not be decoded' }); };
if (IMAGE === null) { canvas.width = 1200; canvas.height = 1600; fit(); redraw(); }
else img.src = IMAGE;
window.addEventListener('resize', function () { if (ready()) fit(); });
canvas.addEventListener('pointerdown', function (e) {
  if (!ready()) return;
  var p = point(e);
  if (tool === 'text') {
    e.preventDefault();
    commitText();
    var w = document.getElementById('wrap').getBoundingClientRect();
    textAt = p;
    label.style.left = (e.clientX - w.left) + 'px'; label.style.top = (e.clientY - w.top) + 'px';
    label.style.color = color; label.style.display = 'block';
    setTimeout(function () { label.focus(); }, 0);
    return;
  }
  drawing = true;
  canvas.setPointerCapture(e.pointerId);
  draft = startShape(tool, p, color);
  redraw();
});
canvas.addEventListener('pointermove', function (e) {
  if (!drawing) return;
  draft = extendShape(draft, point(e));
  redraw();
});
function endDraw() {
  if (!drawing) return;
  drawing = false;
  shapes.push(draft); draft = null;
  redraw();
}
canvas.addEventListener('pointerup', endDraw);
canvas.addEventListener('pointercancel', endDraw);
label.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); commitText(); }
});
label.addEventListener('blur', commitText);
var toolBtns = document.querySelectorAll('[data-tool]');
for (var t = 0; t < toolBtns.length; t++) toolBtns[t].addEventListener('click', function (e) {
  commitText(); tool = e.currentTarget.getAttribute('data-tool'); setActive('[data-tool]', 'data-tool', tool);
});
var colorBtns = document.querySelectorAll('[data-color]');
for (var c = 0; c < colorBtns.length; c++) colorBtns[c].addEventListener('click', function (e) {
  color = e.currentTarget.getAttribute('data-color'); setActive('[data-color]', 'data-color', color);
});
undoBtn.addEventListener('click', function () { commitText(); shapes.pop(); redraw(); });
document.getElementById('done').addEventListener('click', function () {
  commitText();
  post({ type: 'done', png: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height });
});
document.getElementById('cancel').addEventListener('click', function () { post({ type: 'cancel' }); });
setActive('[data-tool]', 'data-tool', tool); setActive('[data-color]', 'data-color', color);
`;
}

/**
 * The full annotator page for `dataUri` (an `imageDataUri`), or a blank white
 * page to sketch on when `dataUri` is null. The URI is
 * embedded as a JSON string with `<` and the JS line separators escaped, so it
 * can never close the script block however it was built.
 */
export function buildAnnotatorHtml(dataUri: string | null): string {
  if (dataUri !== null && !IMAGE_DATA_URI.test(dataUri))
    throw new Error('annotator: source is not an image data URI');
  const safe = (v: unknown): string =>
    JSON.stringify(v)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  const tools: Array<[string, string, keyof typeof ICON]> = [
    ['box', 'Box tool', 'box'],
    ['arrow', 'Arrow tool', 'arrow'],
    ['pen', 'Freehand tool', 'pen'],
    ['text', 'Text tool', 'text'],
  ];
  const toolButtons = tools
    .map(
      ([id, label, icon]) =>
        `<button data-tool="${id}" aria-label="${label}">${ICON[icon]}</button>`,
    )
    .join('');
  const swatches = ANNOTATOR_COLORS.map(
    (c) =>
      `<button class="swatch" data-color="${c}" aria-label="Color ${c}" style="background:${c}"></button>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>${PAGE_CSS}</style></head><body><div id="bar"><div class="group">${toolButtons}</div><div class="group">${swatches}</div><div class="group"><button id="undo" aria-label="Undo last mark" disabled>${ICON.undo}</button><button id="done" aria-label="Done">Done</button><button id="cancel" aria-label="Cancel annotation">${ICON.close}</button></div></div><div id="wrap"><canvas id="canvas"></canvas><input id="label" type="text" autocomplete="off"></div><script>${pageScript(safe(dataUri), safe([...ANNOTATOR_COLORS]))}</script></body></html>`;
}

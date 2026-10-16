import { describe, expect, it } from 'vitest';
import { createUtteranceSegmenter, frameRms } from '../src/utterance-segmenter.js';

const FRAME = 640; // 40 ms at 16 kHz
const speech = (): Int16Array => new Int16Array(FRAME).fill(6000);
const quiet = (): Int16Array => new Int16Array(FRAME);
const MS = 40;

function feed(
  seg: ReturnType<typeof createUtteranceSegmenter>,
  frame: () => Int16Array,
  ms: number,
) {
  const out: Int16Array[] = [];
  for (let t = 0; t < ms; t += MS) {
    const r = seg.push(frame());
    if (r) out.push(r);
  }
  return out;
}

describe('utterance segmenter', () => {
  it('measures rms', () => {
    expect(frameRms(quiet())).toBe(0);
    expect(frameRms(speech())).toBeGreaterThan(0.1);
    expect(frameRms(new Int16Array(0))).toBe(0);
  });

  it('emits one utterance after the silence window, not before', () => {
    const seg = createUtteranceSegmenter();
    expect(feed(seg, speech, 1000)).toHaveLength(0);
    expect(seg.speaking).toBe(true);
    expect(feed(seg, quiet, 2800)).toHaveLength(0);
    const out = feed(seg, quiet, 400);
    expect(out).toHaveLength(1);
    expect(seg.speaking).toBe(false);
    expect(out[0]!.length).toBeGreaterThanOrEqual(1000 * 16);
  });

  it('a pause shorter than the window keeps one utterance', () => {
    const seg = createUtteranceSegmenter();
    feed(seg, speech, 500);
    feed(seg, quiet, 2000);
    feed(seg, speech, 500);
    const out = feed(seg, quiet, 3200);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeGreaterThan(3000 * 16);
  });

  it('segments consecutive utterances separately', () => {
    const seg = createUtteranceSegmenter();
    const a = [...feed(seg, speech, 600), ...feed(seg, quiet, 3200)];
    const b = [...feed(seg, speech, 600), ...feed(seg, quiet, 3200)];
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('never emits on silence alone', () => {
    const seg = createUtteranceSegmenter();
    expect(feed(seg, quiet, 20000)).toHaveLength(0);
  });

  it('drops a blip shorter than the minimum speech', () => {
    const seg = createUtteranceSegmenter();
    feed(seg, speech, 80);
    expect(feed(seg, quiet, 3400)).toHaveLength(0);
    expect(seg.speaking).toBe(false);
  });

  it('keeps a pre-roll before the first loud frame', () => {
    const seg = createUtteranceSegmenter();
    feed(seg, quiet, 2000);
    feed(seg, speech, 400);
    const out = feed(seg, quiet, 3200);
    expect(out[0]!.length).toBeGreaterThan((400 + 3000) * 16 + 200 * 16);
  });

  it('flushes an utterance that runs past the maximum', () => {
    const seg = createUtteranceSegmenter({ maxUtteranceMs: 2000 });
    expect(feed(seg, speech, 2400)).toHaveLength(1);
  });

  it('honours a custom silence window', () => {
    const seg = createUtteranceSegmenter({ silenceMs: 1000 });
    feed(seg, speech, 500);
    expect(feed(seg, quiet, 1200)).toHaveLength(1);
  });
});

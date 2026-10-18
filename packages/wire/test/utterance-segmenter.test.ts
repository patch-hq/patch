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

  describe('end-of-turn pauses', () => {
    function withPauses() {
      const pauses: { pcm: Int16Array; seq: number }[] = [];
      const seg = createUtteranceSegmenter({
        silenceMs: 10_000,
        pauseMs: 600,
        onPause: (pcm, seq) => pauses.push({ pcm, seq }),
      });
      return { seg, pauses };
    }

    it('reports a short pause once, with the utterance so far, and keeps listening', () => {
      const { seg, pauses } = withPauses();
      feed(seg, speech, 1000);
      expect(feed(seg, quiet, 560)).toHaveLength(0);
      expect(pauses).toHaveLength(0);
      feed(seg, quiet, 40);
      expect(pauses).toHaveLength(1);
      expect(pauses[0]!.pcm.length).toBeGreaterThanOrEqual(1000 * 16);
      feed(seg, quiet, 2000);
      expect(pauses).toHaveLength(1);
      expect(seg.speaking).toBe(true);
    });

    it('cut ends the utterance at that pause', () => {
      const { seg, pauses } = withPauses();
      feed(seg, speech, 1000);
      feed(seg, quiet, 600);
      const out = seg.cut(pauses[0]!.seq);
      expect(out!.length).toBeGreaterThanOrEqual(1600 * 16);
      expect(seg.speaking).toBe(false);
      expect(seg.cut(pauses[0]!.seq)).toBeNull();
    });

    it('a cut that arrives after speech resumed does nothing, and the next pause is reported', () => {
      const { seg, pauses } = withPauses();
      feed(seg, speech, 1000);
      feed(seg, quiet, 600);
      feed(seg, speech, 400);
      expect(seg.cut(pauses[0]!.seq)).toBeNull();
      expect(seg.speaking).toBe(true);
      feed(seg, quiet, 600);
      expect(pauses).toHaveLength(2);
      expect(pauses[1]!.pcm.length).toBeGreaterThan(pauses[0]!.pcm.length);
      expect(seg.cut(pauses[1]!.seq)).not.toBeNull();
    });

    it('a blip too short to be speech is never reported as a pause', () => {
      const { seg, pauses } = withPauses();
      feed(seg, speech, 120);
      feed(seg, quiet, 1000);
      expect(pauses).toHaveLength(0);
    });

    it('the long silence still ends an utterance nobody cut', () => {
      const { seg } = withPauses();
      feed(seg, speech, 1000);
      expect(feed(seg, quiet, 10_000)).toHaveLength(1);
    });
  });
});

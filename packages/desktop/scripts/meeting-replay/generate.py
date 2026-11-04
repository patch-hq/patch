"""Render a meeting script (JSON) into the two tracks the desktop app captures.

Writes <out>/mic.wav (the local speaker, plus the call leaking from the laptop
speakers) and <out>/system.wav (everyone else, as the call audio tap hears it),
both 16 kHz mono PCM16, plus <out>/truth.json with who said what and when.

Needs Kokoro (pip install kokoro soundfile). Run with the Python that has it:
    python generate.py standup.json /tmp/standup [--leak 0.25] [--headphones]
"""
import json, sys, argparse
import numpy as np
import soundfile as sf
from kokoro import KPipeline

SR_IN, SR = 24000, 16000

def resample(a):
    n = int(len(a) * SR / SR_IN)
    return np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('script'); ap.add_argument('out')
    ap.add_argument('--leak', type=float, default=0.25, help='call audio level reaching the mic')
    ap.add_argument('--headphones', action='store_true', help='no leak at all')
    ap.add_argument('--gap', type=float, default=0.6, help='seconds between turns')
    a = ap.parse_args()
    spec = json.load(open(a.script))
    pipes = {}
    def pipe(voice):
        lang = voice[0]
        if lang not in pipes: pipes[lang] = KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M')
        return pipes[lang]
    pieces, truth, t = [], [], 0.5
    for who, text in spec['lines']:
        voice = spec['voices'][who]
        audio = np.concatenate([np.asarray(x[2]) for x in pipe(voice)(text, voice=voice)])
        audio = resample(audio)
        pieces.append((who, t, audio))
        truth.append({'speaker': who, 'text': text, 'start': round(t, 2), 'end': round(t + len(audio) / SR, 2)})
        t += len(audio) / SR + a.gap
    total = int((t + 1.0) * SR)
    mic, system = np.zeros(total, np.float32), np.zeros(total, np.float32)
    for who, start, audio in pieces:
        i = int(start * SR)
        (mic if who == spec['local'] else system)[i:i + len(audio)] += audio * 0.8
    if not a.headphones:
        # The laptop speakers play the call; the mic hears it ~40 ms later, quieter and duller.
        delay = int(0.04 * SR)
        leak = np.convolve(system, np.ones(8) / 8, mode='same') * a.leak
        mic[delay:] += leak[:-delay]
    rng = np.random.default_rng(1)
    mic += rng.normal(0, 0.002, total).astype(np.float32)
    import os; os.makedirs(a.out, exist_ok=True)
    sf.write(f'{a.out}/mic.wav', np.clip(mic, -1, 1), SR, subtype='PCM_16')
    sf.write(f'{a.out}/system.wav', np.clip(system, -1, 1), SR, subtype='PCM_16')
    json.dump({'local': spec['local'], 'lines': truth}, open(f'{a.out}/truth.json', 'w'), indent=1)
    print(f'{a.out}: {t:.1f}s, {len(truth)} turns')

main()

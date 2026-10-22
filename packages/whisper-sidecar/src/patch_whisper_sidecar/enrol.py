"""Save the owner's voice print: `python -m patch_whisper_sidecar.enrol me.wav`.

Needs a 16 kHz mono 16-bit WAV of the owner speaking alone (5s+), plus
DIARISE_MODEL_PATH and VOICEPRINT_PATH.
"""

from __future__ import annotations

import os
import sys
import wave

import numpy as np

from .diarise import SAMPLE_RATE, Diariser, resolve_model, sherpa_embedder


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise RuntimeError("voice print WAV must be 16 kHz mono 16-bit")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        raise SystemExit("usage: python -m patch_whisper_sidecar.enrol me.wav")
    out = os.environ.get("VOICEPRINT_PATH")
    d = Diariser(sherpa_embedder(resolve_model(os.environ.get("DIARISE_MODEL_PATH"))), out)
    seconds = d.enrol(read_wav(argv[1]))
    print(f"voice print saved to {out} from {seconds:.1f}s of audio")


if __name__ == "__main__":
    main(sys.argv)

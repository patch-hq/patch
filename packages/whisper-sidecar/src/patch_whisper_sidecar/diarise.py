"""Online speaker diarisation for meeting audio.

Whisper gives timestamped segments; a sherpa-onnx speaker-embedding model turns
each segment into a voice vector; this tracker clusters those vectors across the
whole meeting so "voice 2" in one clip is the same person in the next.
"""

from __future__ import annotations

import os
from collections import OrderedDict
from typing import Callable, Protocol

import numpy as np

SAMPLE_RATE = 16_000
# Cosine similarity at or above which a segment is the same person as a known voice.
MATCH_THRESHOLD = 0.5
# Segments shorter than this carry too little voice to start or move a cluster.
MIN_ENROL_SECONDS = 1.0
# Segments shorter than this are too short to embed at all; they take the previous voice.
MIN_EMBED_SECONDS = 0.4
MAX_VOICES = 12
MAX_SESSIONS = 8


class Embedder(Protocol):
    def __call__(self, pcm: np.ndarray) -> np.ndarray: ...


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n == 0.0:
        raise RuntimeError("speaker embedding has zero norm")
    return v / n


class SpeakerTracker:
    """Assigns stable 1-based voice numbers to segments of one meeting."""

    def __init__(self, threshold: float = MATCH_THRESHOLD) -> None:
        self._threshold = threshold
        self._sums: list[np.ndarray] = []
        self._counts: list[int] = []
        self._last: int | None = None

    def _centroid(self, i: int) -> np.ndarray:
        return _unit(self._sums[i])

    def assign(self, emb: np.ndarray | None, seconds: float) -> int:
        """Voice number for a segment. `emb` is None when it was too short to embed."""
        if emb is None:
            if self._last is None:
                raise RuntimeError("first segment of a meeting is too short to identify")
            return self._last
        e = _unit(emb)
        best, best_sim = -1, -1.0
        for i in range(len(self._sums)):
            sim = float(np.dot(e, self._centroid(i)))
            if sim > best_sim:
                best, best_sim = i, sim
        enrol = seconds >= MIN_ENROL_SECONDS
        if best >= 0 and (best_sim >= self._threshold or not enrol or len(self._sums) >= MAX_VOICES):
            if enrol:
                self._sums[best] = self._sums[best] + e
                self._counts[best] += 1
            self._last = best + 1
            return best + 1
        self._sums.append(e.copy())
        self._counts.append(1)
        self._last = len(self._sums)
        return self._last

    @property
    def voices(self) -> int:
        return len(self._sums)


class Diariser:
    """Per-meeting trackers around one shared embedding model."""

    def __init__(self, embed: Embedder) -> None:
        self._embed = embed
        self._sessions: "OrderedDict[str, SpeakerTracker]" = OrderedDict()

    def label(self, session: str, pcm: np.ndarray, segments: list[tuple[float, float]]) -> list[int]:
        """Voice number for each (start, end) second span of `pcm` (int16, 16 kHz)."""
        tracker = self._sessions.get(session)
        if tracker is None:
            tracker = self._sessions[session] = SpeakerTracker()
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)
        self._sessions.move_to_end(session)
        out: list[int] = []
        for start, end in segments:
            a = max(0, int(start * SAMPLE_RATE))
            b = min(len(pcm), int(end * SAMPLE_RATE))
            seconds = (b - a) / SAMPLE_RATE
            emb = None
            if seconds >= MIN_EMBED_SECONDS:
                emb = self._embed(pcm[a:b])
            out.append(tracker.assign(emb, seconds))
        return out


def resolve_model(path: str | None) -> str:
    if not path:
        raise RuntimeError(
            "DIARISE_MODEL_PATH is not set. Speaker separation needs a sherpa-onnx "
            "speaker-embedding model on disk (NO SILENT FALLBACK)."
        )
    if not os.path.isfile(path):
        raise RuntimeError(f"DIARISE_MODEL_PATH is not a file: {path} (NO SILENT FALLBACK).")
    return path


def sherpa_embedder(model_path: str) -> Embedder:
    import sherpa_onnx

    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model_path, num_threads=2)
    if not cfg.validate():
        raise RuntimeError(f"invalid speaker embedding model: {model_path}")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def embed(pcm: np.ndarray) -> np.ndarray:
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=pcm.astype(np.float32) / 32768.0)
        stream.input_finished()
        if not extractor.is_ready(stream):
            raise RuntimeError("speaker embedding: segment too short for the model")
        return np.asarray(extractor.compute(stream), dtype=np.float32)

    return embed

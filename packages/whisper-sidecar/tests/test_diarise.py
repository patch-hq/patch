import asyncio
import json

import numpy as np
import websockets

from patch_whisper_sidecar.diarise import Diariser, SpeakerTracker
from patch_whisper_sidecar.sidecar import WhisperSidecar

SR = 16_000


def voice(i: int) -> np.ndarray:
    v = np.zeros(8, dtype=np.float32)
    v[i] = 1.0
    return v + 0.02


def test_same_voice_keeps_number_and_new_voice_gets_next():
    t = SpeakerTracker()
    assert t.assign(voice(0), 3) == 1
    assert t.assign(voice(1), 3) == 2
    assert t.assign(voice(0), 3) == 1
    assert t.voices == 2


def test_short_segment_never_starts_a_voice_but_takes_nearest():
    t = SpeakerTracker()
    t.assign(voice(0), 3)
    assert t.assign(voice(5), 0.6) == 1
    assert t.voices == 1


def test_unembeddable_segment_takes_previous_voice():
    t = SpeakerTracker()
    t.assign(voice(0), 3)
    t.assign(voice(1), 3)
    assert t.assign(None, 0.2) == 2


def test_first_segment_too_short_is_loud():
    try:
        SpeakerTracker().assign(None, 0.1)
    except RuntimeError:
        return
    raise AssertionError("expected RuntimeError")


def test_voices_persist_across_clips_per_session_and_sessions_are_isolated():
    # Each second of audio carries a constant "voice id" in its samples.
    def embed(pcm: np.ndarray) -> np.ndarray:
        return voice(int(pcm[0]))

    d = Diariser(embed)
    clip = np.concatenate([np.full(SR * 2, 0, "<i2"), np.full(SR * 2, 1, "<i2")])
    assert d.label("a", clip, [(0, 2), (2, 4)]) == [1, 2]
    swapped = np.concatenate([np.full(SR * 2, 1, "<i2"), np.full(SR * 2, 0, "<i2")])
    assert d.label("a", swapped, [(0, 2), (2, 4)]) == [2, 1]
    assert d.label("b", swapped, [(0, 2), (2, 4)]) == [1, 2]


def test_websocket_returns_voiced_segments(tmp_path):
    (tmp_path / "model.bin").write_bytes(b"x")
    d = Diariser(lambda pcm: voice(int(pcm[0])))
    s = WhisperSidecar(str(tmp_path), diariser=d)
    s._engine.transcribe_segments = lambda pcm: [(0.0, 2.0, "hello"), (2.0, 4.0, "hi there")]
    pcm = np.concatenate([np.full(SR * 2, 0, "<i2"), np.full(SR * 2, 1, "<i2")])

    async def run():
        async with websockets.serve(s._handle, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"requestId": "r1", "diarise": "m1"}))
                await ws.send(pcm.tobytes())
                return json.loads(await ws.recv())

    msg = asyncio.run(run())
    assert msg["requestId"] == "r1"
    assert [(x["text"], x["voice"]) for x in msg["segments"]] == [("hello", 1), ("hi there", 2)]
    assert msg["text"] == "hello hi there"


def test_diarise_without_model_is_an_error_not_a_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("DIARISE_MODEL_PATH", raising=False)
    (tmp_path / "model.bin").write_bytes(b"x")
    s = WhisperSidecar(str(tmp_path))
    s._engine.transcribe_segments = lambda pcm: [(0.0, 2.0, "hello")]

    async def run():
        async with websockets.serve(s._handle, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"requestId": "r1", "diarise": "m1"}))
                await ws.send(np.zeros(SR, "<i2").tobytes())
                return json.loads(await ws.recv())

    msg = asyncio.run(run())
    assert "DIARISE_MODEL_PATH" in msg["error"]


def test_real_model_embeds_when_configured():
    # Needs the ~27 MB model from scripts/fetch-models.sh; runs wherever
    # DIARISE_MODEL_PATH is set (CI fetches it) and says so when it is not.
    import os

    import pytest

    path = os.environ.get("DIARISE_MODEL_PATH")
    if not path:
        pytest.skip("DIARISE_MODEL_PATH not set")
    from patch_whisper_sidecar.diarise import resolve_model, sherpa_embedder

    embed = sherpa_embedder(resolve_model(path))
    t = np.arange(SR * 2) / SR
    low = (np.sin(2 * np.pi * 110 * t) * 8000).astype("<i2")
    emb = embed(low)
    assert emb.shape == (256,)
    assert np.isfinite(emb).all()

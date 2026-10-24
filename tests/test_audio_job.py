# SPDX-License-Identifier: Apache-2.0
"""vmlx_engine.audio.job: the one-shot local audio runner the Audio tab calls."""

import json
import sys
import types

import numpy as np
import pytest

from vmlx_engine.audio import job


@pytest.fixture(autouse=True)
def _cached_hub(monkeypatch, tmp_path):
    """Every repo counts as cached, so no test reaches the network."""
    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = lambda repo, local_files_only=False: str(tmp_path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)


class _FakeTTS:
    def __init__(self, model_name):
        self.model_name = model_name

    def load(self):
        pass

    calls = []

    def generate(self, text, voice="af_heart", speed=1.0, lang_code="a", **kwargs):
        from vmlx_engine.audio.tts import AudioOutput

        _FakeTTS.calls.append(kwargs)

        return AudioOutput(audio=np.zeros(2400, dtype=np.float32), sample_rate=24000, duration=0.1)

    def to_bytes(self, audio, format="wav"):
        return b"RIFFfake"


def _events(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def test_tts_writes_the_file_and_reports_done(tmp_path, monkeypatch, capsys):
    fake = types.ModuleType("vmlx_engine.audio.tts")
    from vmlx_engine.audio import tts as real

    fake.TTSEngine = _FakeTTS
    fake.AudioOutput = real.AudioOutput
    monkeypatch.setitem(sys.modules, "vmlx_engine.audio.tts", fake)
    text = tmp_path / "in.txt"
    text.write_text("Hello from MLX Harness", encoding="utf-8")
    out = tmp_path / "sub" / "out.wav"
    code = job.main(["tts", "--model", "mlx-community/Kokoro-82M-bf16", "--input", str(text), "--output", str(out)])
    assert code == 0
    assert out.read_bytes() == b"RIFFfake"
    events = _events(capsys)
    assert [e["event"] for e in events] == ["loading", "generating", "done"]
    assert events[-1]["path"] == str(out)
    assert events[-1]["duration"] == 0.1


def test_empty_text_and_bad_speed_fail_cleanly(tmp_path, capsys):
    text = tmp_path / "in.txt"
    text.write_text("   ", encoding="utf-8")
    assert job.main(["tts", "--model", "m", "--input", str(text), "--output", str(tmp_path / "o.wav")]) == 1
    assert _events(capsys)[-1]["event"] == "error"
    assert job.main(["tts", "--model", "m", "--speed", "9", "--input", str(text), "--output", str(tmp_path / "o.wav")]) == 2


def test_missing_arguments_exit_2():
    assert job.main(["tts"]) == 2


def _fake_music(monkeypatch, calls):
    gen = types.ModuleType("mlx_audio.music.generate")
    utils = types.ModuleType("mlx_audio.music.utils")

    def generate_music(caption, lyrics, model, duration=None, steps=30, seed=0, output_path="music.wav", verbose=True):
        calls.append({"caption": caption, "lyrics": lyrics, "model": model, "duration": duration, "steps": steps, "seed": seed})
        from pathlib import Path

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"RIFFsong")
        return Path(output_path)

    gen.generate_music = generate_music
    utils.load_model = lambda repo: f"loaded:{repo}"
    for name in ("mlx_audio", "mlx_audio.music"):
        monkeypatch.setitem(sys.modules, name, sys.modules.get(name) or types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "mlx_audio.music.generate", gen)
    monkeypatch.setitem(sys.modules, "mlx_audio.music.utils", utils)


def test_music_passes_caption_lyrics_and_length(tmp_path, monkeypatch, capsys):
    calls = []
    _fake_music(monkeypatch, calls)
    caption = tmp_path / "c.txt"
    caption.write_text("warm lo-fi, Rhodes, brushed drums", encoding="utf-8")
    lyrics = tmp_path / "l.txt"
    lyrics.write_text("[instrumental]", encoding="utf-8")
    out = tmp_path / "song.wav"
    code = job.main(["music", "--model", "mlx-community/MiniMax-Music3-4bit", "--caption-file", str(caption),
                     "--lyrics-file", str(lyrics), "--duration", "30", "--output", str(out)])
    assert code == 0
    assert out.read_bytes() == b"RIFFsong"
    assert calls == [{"caption": "warm lo-fi, Rhodes, brushed drums", "lyrics": "[instrumental]",
                      "model": "loaded:mlx-community/MiniMax-Music3-4bit", "duration": 30.0, "steps": 30, "seed": 0}]
    assert [e["event"] for e in _events(capsys)] == ["loading", "generating", "done"]


def test_music_refuses_empty_lyrics_and_bad_length(tmp_path, monkeypatch, capsys):
    _fake_music(monkeypatch, [])
    caption = tmp_path / "c.txt"
    caption.write_text("pop", encoding="utf-8")
    lyrics = tmp_path / "l.txt"
    lyrics.write_text("  ", encoding="utf-8")
    args = ["music", "--model", "m", "--caption-file", str(caption), "--lyrics-file", str(lyrics), "--output", str(tmp_path / "o.wav")]
    assert job.main(args) == 1
    assert "lyrics" in _events(capsys)[-1]["message"]
    assert job.main(args + ["--duration", "400"]) == 2


def test_first_run_says_it_is_downloading(tmp_path, monkeypatch, capsys):
    calls = []
    _fake_music(monkeypatch, calls)
    hub = types.ModuleType("huggingface_hub")
    fetched = []

    def snapshot_download(repo, local_files_only=False):
        if local_files_only:
            raise FileNotFoundError(repo)
        fetched.append(repo)
        return str(tmp_path)

    hub.snapshot_download = snapshot_download
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    caption = tmp_path / "c.txt"
    caption.write_text("pop", encoding="utf-8")
    lyrics = tmp_path / "l.txt"
    lyrics.write_text("[Verse]\nla la", encoding="utf-8")
    code = job.main(["music", "--model", "mlx-community/MiniMax-Music3-4bit", "--caption-file", str(caption),
                     "--lyrics-file", str(lyrics), "--output", str(tmp_path / "o.wav")])
    assert code == 0
    assert fetched == ["mlx-community/MiniMax-Music3-4bit"]
    assert [e["event"] for e in _events(capsys)] == ["downloading", "loading", "generating", "done"]


def test_tts_speaks_in_a_voice_sample(tmp_path, monkeypatch, capsys):
    fake = types.ModuleType("vmlx_engine.audio.tts")
    from vmlx_engine.audio import tts as real

    fake.TTSEngine = _FakeTTS
    fake.AudioOutput = real.AudioOutput
    monkeypatch.setitem(sys.modules, "vmlx_engine.audio.tts", fake)
    text = tmp_path / "in.txt"
    text.write_text("Hello", encoding="utf-8")
    sample = tmp_path / "voice.wav"
    sample.write_bytes(b"RIFFvoice")
    _FakeTTS.calls.clear()
    args = ["tts", "--model", "mlx-community/chatterbox-turbo-fp16", "--input", str(text), "--output", str(tmp_path / "o.wav")]
    assert job.main(args + ["--ref-audio", str(sample)]) == 0
    assert _FakeTTS.calls[-1] == {"ref_audio": str(sample)}
    assert job.main(args) == 0
    assert _FakeTTS.calls[-1] == {}
    assert job.main(args + ["--ref-audio", str(tmp_path / "gone.wav")]) == 1

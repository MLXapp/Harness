# SPDX-License-Identifier: Apache-2.0
"""vmlx_engine.audio.job: the one-shot local audio runner the Audio tab calls."""

import json
import sys
import types

import numpy as np

from vmlx_engine.audio import job


class _FakeTTS:
    def __init__(self, model_name):
        self.model_name = model_name

    def load(self):
        pass

    def generate(self, text, voice="af_heart", speed=1.0, lang_code="a"):
        from vmlx_engine.audio.tts import AudioOutput

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

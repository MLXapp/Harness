# SPDX-License-Identifier: Apache-2.0
"""vmlx_engine.video.job: argument checks, progress lines and the call into mlx-video.

mlx-video is replaced by a stand-in module, so this runs without MLX. The real
pipeline was run end to end on a tiny random-weight Wan 2.2 (MLX CPU) while
building 0.5.1; on a Mac the bundle check imports the real module.
"""

import json
import sys
import types

from vmlx_engine.video import job


def _fake_wan(monkeypatch, calls):
    gen = types.ModuleType("mlx_video.models.wan_2.generate")

    def generate_video(**kwargs):
        for _ in gen.tqdm(range(kwargs["steps"]), desc="Diffusion"):
            pass
        with open(kwargs["output_path"], "wb") as f:
            f.write(b"\x00\x00\x00\x18ftypmp42")
        calls.append(kwargs)

    gen.generate_video = generate_video
    gen.tqdm = None
    pkg = types.ModuleType("mlx_video.models.wan_2")
    pkg.generate = gen
    for name, mod in {"mlx_video": types.ModuleType("mlx_video"), "mlx_video.models": types.ModuleType("mlx_video.models"),
                      "mlx_video.models.wan_2": pkg, "mlx_video.models.wan_2.generate": gen}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    return gen


def _events(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]


def test_sizes_frames_and_steps_are_checked():
    assert job.valid_size(832, 480, 49, 30) is None
    assert job.valid_size(1280, 704, 121, 50) is None
    assert "multiples of 32" in job.valid_size(830, 480, 49, 30)
    assert "4n + 1" in job.valid_size(832, 480, 48, 30)
    assert "4n + 1" in job.valid_size(832, 480, 125, 30)
    assert "Steps" in job.valid_size(832, 480, 49, 0)


def test_runs_wan_and_reports_each_step(tmp_path, monkeypatch, capsys):
    calls = []
    _fake_wan(monkeypatch, calls)
    model = tmp_path / "model"
    model.mkdir()
    prompt = tmp_path / "p.txt"
    prompt.write_text("A red ball rolls across a table.", encoding="utf-8")
    out = tmp_path / "out" / "clip.mp4"
    code = job.main(["wan", "--model", str(model), "--prompt-file", str(prompt), "--width", "832", "--height", "480",
                     "--frames", "49", "--steps", "3", "--seed", "7", "--output", str(out)])
    assert code == 0
    events = _events(capsys)
    assert [e["event"] for e in events] == ["loading", "generating", "step", "step", "step", "finishing", "done"]
    assert [e["step"] for e in events if e["event"] == "step"] == [1, 2, 3]
    assert calls[0] | {"output_path": None} == {"model_dir": str(model), "prompt": "A red ball rolls across a table.", "image": None,
                                              "width": 832, "height": 480, "num_frames": 49, "steps": 3, "seed": 7, "output_path": None}
    assert out.is_file() and events[-1]["path"] == str(out)


def test_refuses_bad_input_before_loading(tmp_path, monkeypatch, capsys):
    _fake_wan(monkeypatch, [])
    empty = tmp_path / "p.txt"
    empty.write_text("  ", encoding="utf-8")
    assert job.main(["wan", "--model", str(tmp_path), "--prompt-file", str(empty), "--output", str(tmp_path / "o.mp4")]) == 1
    assert _events(capsys)[-1] == {"event": "error", "message": "Describe the video first"}
    assert job.main(["wan", "--model", str(tmp_path), "--prompt-file", str(empty), "--width", "100", "--output", "x"]) == 2


def test_writes_an_mp4_with_whatever_encoder_opencv_has(tmp_path, capsys):
    import pytest

    np = pytest.importorskip("numpy")
    pytest.importorskip("cv2")
    frames = (np.random.default_rng(0).random((9, 64, 96, 3)) * 255).astype("uint8")
    out = tmp_path / "clip.mp4"
    job.save_video(frames, str(out), fps=24)
    assert out.stat().st_size > 1000
    assert _events(capsys) == [{"event": "encoding"}]

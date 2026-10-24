# SPDX-License-Identifier: Apache-2.0
"""
One-shot local video jobs for MLX Harness's Video tab.

    python -m vmlx_engine.video.job wan --model Anes1032/Wan2.2-TI2V-5B-mlx-q8 \
        --prompt-file prompt.txt --width 1280 --height 704 --frames 49 \
        --steps 30 --seed 7 --output clip.mp4

Wan 2.2 TI2V-5B (Apache-2.0) runs through Prince Canuma's mlx-video (MIT),
bundled with the app. The first run downloads the model (about 20 GB) and the
UMT5 tokenizer into the usual Hugging Face cache.

Like the audio jobs: no server and no chat model; the job loads the model,
writes the clip and exits, so the memory is returned at once. Progress goes to
stdout as one JSON object per line ({"event": "downloading" | "loading" |
"generating" | "step" | "finishing" | "encoding" | "done" | "error", ...}). Exit code 0 on
success, 1 on a failed job, 2 on bad arguments.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

# Wan 2.2 TI2V-5B: sizes divisible by 32, frames 4n + 1, 24 frames a second.
WAN_FPS = 24
MAX_FRAMES = 121  # 5 seconds
MAX_STEPS = 50


def _emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def _model_dir(repo: str) -> str:
    """A local folder for the model, downloading it first (and saying so) when needed."""
    if Path(repo).expanduser().is_dir():
        return str(Path(repo).expanduser())
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(repo, local_files_only=True)
    except Exception:  # noqa: BLE001 - not cached (or partly)
        pass
    _emit("downloading", model=repo)
    return snapshot_download(repo)


def valid_size(width: int, height: int, frames: int, steps: int) -> str | None:
    if width % 32 or height % 32 or not (256 <= width <= 1280) or not (256 <= height <= 1280):
        return "Width and height must be multiples of 32 between 256 and 1280"
    if frames < 5 or frames > MAX_FRAMES or (frames - 1) % 4:
        return f"Frames must be 4n + 1, from 5 to {MAX_FRAMES}"
    if not 1 <= steps <= MAX_STEPS:
        return f"Steps must be 1 to {MAX_STEPS}"
    return None


class _StepProgress:
    """Stands in for tqdm in mlx-video's denoising loop: one JSON line per step."""

    def __init__(self, iterable=None, total=None, **_kwargs):
        self.iterable = iterable
        self.total = total if total is not None else (len(iterable) if iterable is not None else None)

    def __iter__(self):
        # The text encoder and the model are loaded by now: denoising starts.
        _emit("generating", steps=self.total)
        for i, item in enumerate(self.iterable):
            yield item
            _emit("step", step=i + 1, of=self.total)
        # Denoising is done; the VAE turns the latents into frames next.
        _emit("finishing")

    def update(self, *_a, **_k):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def save_video(frames, output_path: str, fps: int = WAN_FPS) -> None:
    """H.264 through OpenCV (AVFoundation on a Mac), else MPEG-4; never a folder of PNGs.

    Replaces mlx-video's writer, which tries imageio (not bundled) and falls
    back to PNG frames when the encoder can't open.
    """
    import cv2

    _emit("encoding")
    h, w = int(frames.shape[1]), int(frames.shape[2])
    for fourcc in ("avc1", "mp4v"):
        writer = cv2.VideoWriter(str(output_path), cv2.VideoWriter_fourcc(*fourcc), float(fps), (w, h))
        if not writer.isOpened():
            writer.release()
            continue
        for frame in frames:
            writer.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        writer.release()
        if Path(output_path).is_file() and Path(output_path).stat().st_size > 0:
            return
    raise RuntimeError("The video could not be encoded on this Mac")


def _wan(args: argparse.Namespace) -> int:
    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt:
        _emit("error", message="Describe the video first")
        return 1
    if args.image and not Path(args.image).is_file():
        _emit("error", message="The start image is missing")
        return 1
    started = time.monotonic()
    model_dir = _model_dir(args.model)
    _emit("loading", model=args.model)
    from mlx_video.models.wan_2 import generate as wan_generate

    # Per-step progress instead of a terminal progress bar.
    wan_generate.tqdm = _StepProgress
    wan_generate.save_video = save_video
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    seed = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)
    wan_generate.generate_video(
        model_dir=model_dir,
        prompt=prompt,
        image=args.image or None,
        width=args.width,
        height=args.height,
        num_frames=args.frames,
        steps=args.steps,
        seed=seed,
        output_path=str(out),
    )
    if not out.is_file() or out.stat().st_size == 0:
        _emit("error", message="The video was not written")
        return 1
    _emit("done", path=str(out), seed=seed, seconds=round(time.monotonic() - started, 2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m vmlx_engine.video.job")
    sub = parser.add_subparsers(dest="task", required=True)
    wan = sub.add_parser("wan", help="Wan 2.2 TI2V-5B: text (or a start image) to video")
    wan.add_argument("--model", required=True)
    wan.add_argument("--prompt-file", required=True)
    wan.add_argument("--image", default="")
    wan.add_argument("--width", type=int, default=1280)
    wan.add_argument("--height", type=int, default=704)
    wan.add_argument("--frames", type=int, default=49)
    wan.add_argument("--steps", type=int, default=30)
    wan.add_argument("--seed", type=int, default=-1)
    wan.add_argument("--output", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except SystemExit:
        return 2
    problem = valid_size(args.width, args.height, args.frames, args.steps)
    if problem:
        _emit("error", message=problem)
        return 2
    try:
        return _wan(args)
    except ImportError as error:
        _emit("error", message=f"Video support is missing from this build: {error}")
        return 1
    except Exception as error:  # noqa: BLE001 - reported to the app, not raised
        _emit("error", message=str(error) or error.__class__.__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())

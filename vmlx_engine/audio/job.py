# SPDX-License-Identifier: Apache-2.0
"""
One-shot local audio jobs for MLX Harness's Audio tab.

    python -m vmlx_engine.audio.job tts --model mlx-community/Kokoro-82M-bf16 \
        --voice af_heart --speed 1.0 --input prompt.txt --output out.wav
    python -m vmlx_engine.audio.job stt --model mlx-community/whisper-large-v3-turbo \
        --input clip.wav --output transcript.json

No server and no chat model are needed: the job loads the model (first use
downloads it from Hugging Face into the usual cache), writes the result and
exits, so the memory is returned at once. Progress goes to stdout as one JSON
object per line ({"event": "loading" | "generating" | "done" | "error", ...});
the app reads only those lines. Exit code 0 on success, 1 on a failed job,
2 on bad arguments.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def _emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def _tts(args: argparse.Namespace) -> int:
    from .tts import TTSEngine

    text = Path(args.input).read_text(encoding="utf-8").strip()
    if not text:
        _emit("error", message="Nothing to say: the text is empty")
        return 1
    started = time.monotonic()
    _emit("loading", model=args.model)
    engine = TTSEngine(args.model)
    engine.load()
    _emit("generating", characters=len(text))
    audio = engine.generate(text, voice=args.voice, speed=args.speed, lang_code=args.lang)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(engine.to_bytes(audio, format="wav"))
    _emit(
        "done",
        path=str(out),
        duration=round(float(audio.duration), 3),
        sampleRate=int(audio.sample_rate),
        seconds=round(time.monotonic() - started, 2),
    )
    return 0


def _stt(args: argparse.Namespace) -> int:
    from .stt import STTEngine

    started = time.monotonic()
    _emit("loading", model=args.model)
    engine = STTEngine(args.model)
    engine.load()
    _emit("generating")
    result = engine.transcribe(args.input, language=args.language or None)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"text": result.text, "language": result.language, "duration": result.duration}),
        encoding="utf-8",
    )
    _emit("done", path=str(out), text=result.text, seconds=round(time.monotonic() - started, 2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vmlx_engine.audio.job", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="task", required=True)
    tts = sub.add_parser("tts", help="Text to speech")
    tts.add_argument("--model", required=True)
    tts.add_argument("--voice", default="af_heart")
    tts.add_argument("--speed", type=float, default=1.0)
    tts.add_argument("--lang", default="a", help="Kokoro language code (a = American English)")
    tts.add_argument("--input", required=True, help="UTF-8 text file")
    tts.add_argument("--output", required=True, help="WAV file to write")
    stt = sub.add_parser("stt", help="Speech to text")
    stt.add_argument("--model", required=True)
    stt.add_argument("--language", default="")
    stt.add_argument("--input", required=True, help="Audio file")
    stt.add_argument("--output", required=True, help="JSON file to write")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exit_:
        return 2 if exit_.code else 0
    if args.task == "tts" and not 0.5 <= args.speed <= 2.0:
        _emit("error", message="Speed must be between 0.5 and 2.0")
        return 2
    try:
        return _tts(args) if args.task == "tts" else _stt(args)
    except ImportError as error:
        _emit("error", message=f"Audio support is missing from this build: {error}")
        return 1
    except Exception as error:  # noqa: BLE001 - report every failure to the app
        _emit("error", message=str(error) or error.__class__.__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())

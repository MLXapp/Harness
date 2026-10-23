# SPDX-License-Identifier: Apache-2.0
"""
One-shot local audio jobs for MLX Harness's Audio tab.

    python -m vmlx_engine.audio.job tts --model mlx-community/Kokoro-82M-bf16 \
        --voice af_heart --speed 1.0 --input prompt.txt --output out.wav
    python -m vmlx_engine.audio.job stt --model mlx-community/whisper-large-v3-turbo \
        --input clip.wav --output transcript.json
    python -m vmlx_engine.audio.job music --model mlx-community/MiniMax-Music3-4bit \
        --caption-file caption.txt --lyrics-file lyrics.txt --duration 60 --output song.wav

Music uses mlx_audio.music (MiniMax Music 3, in the bundled mlx-audio 0.5.8):
the caption is the style, the lyrics are section-tagged lines, or exactly
"[instrumental]" for a song without vocals.

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


def _ensure_downloaded(repo: str) -> None:
    """Fetch a Hugging Face repo first, saying so, when it isn't cached yet.

    The app shows "Downloading the model" (with its size) instead of a long
    "Loading". A local folder, or a repo already in the cache, does nothing.
    """
    if Path(repo).expanduser().exists() or repo.count("/") != 1:
        return
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        return
    try:
        snapshot_download(repo, local_files_only=True)
        return
    except Exception:  # noqa: BLE001 - not cached (or partly): download below
        pass
    _emit("downloading", model=repo)
    snapshot_download(repo)


def _tts(args: argparse.Namespace) -> int:
    from .tts import TTSEngine

    text = Path(args.input).read_text(encoding="utf-8").strip()
    if not text:
        _emit("error", message="Nothing to say: the text is empty")
        return 1
    started = time.monotonic()
    _ensure_downloaded(args.model)
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


MUSIC_MAX_SECONDS = 360  # MiniMax Music 3's own limit
MUSIC_MAX_STEPS = 30


def _music(args: argparse.Namespace) -> int:
    from mlx_audio.music.generate import generate_music

    caption = Path(args.caption_file).read_text(encoding="utf-8").strip()
    lyrics = Path(args.lyrics_file).read_text(encoding="utf-8").strip()
    if not caption:
        _emit("error", message="Describe the music first")
        return 1
    if not lyrics:
        _emit("error", message="Add lyrics, or ask for an instrumental")
        return 1
    started = time.monotonic()
    _ensure_downloaded(args.model)
    _emit("loading", model=args.model)
    from mlx_audio.music.utils import load_model

    model = load_model(args.model)
    _emit("generating", seconds=args.duration)
    out = generate_music(
        caption=caption,
        lyrics=lyrics,
        model=model,
        duration=args.duration,
        steps=args.steps,
        seed=args.seed,
        output_path=args.output,
        verbose=False,
    )
    _emit("done", path=str(out), seconds=round(time.monotonic() - started, 2))
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
    music = sub.add_parser("music", help="Text to music (song or instrumental)")
    music.add_argument("--model", required=True)
    music.add_argument("--caption-file", required=True, help="UTF-8 text file: style, instruments, voice")
    music.add_argument("--lyrics-file", required=True, help='UTF-8 text file: tagged lyrics, or "[instrumental]"')
    music.add_argument("--duration", type=float, default=60.0, help="Seconds (at most 360)")
    music.add_argument("--steps", type=int, default=MUSIC_MAX_STEPS)
    music.add_argument("--seed", type=int, default=0)
    music.add_argument("--output", required=True, help="WAV file to write")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exit_:
        return 2 if exit_.code else 0
    if args.task == "tts" and not 0.5 <= args.speed <= 2.0:
        _emit("error", message="Speed must be between 0.5 and 2.0")
        return 2
    if args.task == "music" and not (0 < args.duration <= MUSIC_MAX_SECONDS and 1 <= args.steps <= MUSIC_MAX_STEPS):
        _emit("error", message=f"Length must be 1 to {MUSIC_MAX_SECONDS} seconds and steps 1 to {MUSIC_MAX_STEPS}")
        return 2
    try:
        run = {"tts": _tts, "stt": _stt, "music": _music}[args.task]
        return run(args)
    except ImportError as error:
        _emit("error", message=f"Audio support is missing from this build: {error}")
        return 1
    except Exception as error:  # noqa: BLE001 - report every failure to the app
        _emit("error", message=str(error) or error.__class__.__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())

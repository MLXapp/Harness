# SPDX-License-Identifier: Apache-2.0
"""Tool-call grammar (vmlx_engine/api/tool_grammar.py).

The token-level tests need llguidance and a real Qwen3 tokenizer; point
VMLX_TEST_QWEN_TOKENIZER at a folder with tokenizer.json + tokenizer_config.json
(Qwen/Qwen3-0.6B). Without them only the pure parts run.
"""

import json
import os

import pytest

from vmlx_engine.api import tool_grammar as tg

TOOLS = [
    {"type": "function", "function": {"name": "read_file", "parameters": {
        "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}}},
    {"type": "function", "function": {"name": "list_dir", "parameters": {"type": "object", "properties": {}}}},
]


def test_lark_lists_each_tool_once_and_ends_with_the_close_token():
    lark = tg.tool_call_lark(TOOLS + [TOOLS[0]], 151658)
    assert lark.startswith("start: WS call WS <[151658]>")
    schema = json.loads(lark.split("%json ", 1)[1])
    assert [o["properties"]["name"]["const"] for o in schema["anyOf"]] == ["read_file", "list_dir"]
    assert schema["anyOf"][0]["properties"]["arguments"]["required"] == ["path"]
    # A tool whose schema does not compile is held to "any object", not dropped.
    lark = tg.tool_call_lark(TOOLS, 7, check=lambda text: "read_file" not in text)
    first = json.loads(lark.split("%json ", 1)[1])["anyOf"][0]
    assert first["properties"]["arguments"] == {"type": "object"}
    assert tg.tool_call_lark([{"type": "function", "function": {}}], 7) is None


def test_thinking_open_is_read_from_the_prompt_tail():
    assert tg.prompt_leaves_thinking_open("<|im_start|>assistant\n<think>\n")
    assert not tg.prompt_leaves_thinking_open("<|im_start|>assistant\n<think>\n\n</think>\n\n")
    assert not tg.prompt_leaves_thinking_open("<|im_start|>assistant\n")


def test_off_switch(monkeypatch):
    monkeypatch.setenv("VMLX_TOOL_GRAMMAR", "0")
    assert tg.build_tool_call_logits_processor(TOOLS, object()) is None


QWEN = os.environ.get("VMLX_TEST_QWEN_TOKENIZER")
needs_qwen = pytest.mark.skipif(not QWEN, reason="set VMLX_TEST_QWEN_TOKENIZER")


@pytest.fixture(scope="module")
def tok():
    pytest.importorskip("llguidance")
    transformers = pytest.importorskip("transformers")
    return transformers.AutoTokenizer.from_pretrained(QWEN)


class Wrapper:
    """Stands in for mlx-lm's TokenizerWrapper."""

    def __init__(self, inner):
        self._tokenizer = inner


def _run(proc, tok, prompt_last, pieces):
    """Feed text pieces token by token; return (allowed?, token text) per token."""
    import numpy as np

    out = []
    generated = []
    for piece in pieces:
        for t in tok.encode(piece, add_special_tokens=False):
            logits = np.zeros((1, len(tok)), dtype=np.float32)
            masked = proc(np.array([prompt_last, *generated]), logits)
            out.append((bool(np.isfinite(masked[0, t])), tok.decode([t])))
            generated.append(t)
    return out


@needs_qwen
def test_qwen3_is_recognised_and_xml_templates_are_not(tok):
    assert tg.json_tool_call_tokens(Wrapper(tok)) == (151657, 151658)

    class Coder:
        chat_template = "<tool_call>\n<function=example_function_name>"

    assert tg.json_tool_call_tokens(Coder()) is None


@needs_qwen
def test_text_is_free_and_a_valid_call_passes(tok):
    proc = tg.build_tool_call_logits_processor(TOOLS, Wrapper(tok))
    assert proc is not None
    steps = _run(proc, tok, 0, ["Let me look.\n", "<tool_call>", '\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n', "</tool_call>", "Done."])
    assert all(ok for ok, _ in steps), [s for s in steps if not s[0]]
    assert not proc.active


@needs_qwen
def test_unknown_tool_and_missing_argument_are_refused(tok):
    proc = tg.build_tool_call_logits_processor(TOOLS, Wrapper(tok))
    steps = _run(proc, tok, 0, ["<tool_call>", '\n{"name": "rm_rf"'])
    assert not all(ok for ok, _ in steps)
    proc = tg.build_tool_call_logits_processor(TOOLS, Wrapper(tok))
    steps = _run(proc, tok, 0, ["<tool_call>", '\n{"name": "read_file", "arguments": {}}'])
    assert steps[-1] == (False, "}}") and all(ok for ok, _ in steps[:-1])


@needs_qwen
def test_while_thinking_the_tag_is_not_a_call(tok):
    proc = tg.build_tool_call_logits_processor(TOOLS, Wrapper(tok), thinking_open=True)
    steps = _run(proc, tok, 0, ["I could use ", "<tool_call>", " here, but nothing binds me yet.", "</think>", "\n\n", "<tool_call>", '\n{"name": "list_dir", "arguments": {}}\n', "</tool_call>"])
    assert all(ok for ok, _ in steps), [s for s in steps if not s[0]]


@needs_qwen
def test_two_calls_in_a_row(tok):
    proc = tg.build_tool_call_logits_processor(TOOLS, Wrapper(tok))
    call = '\n{"name": "list_dir", "arguments": {}}\n'
    steps = _run(proc, tok, 0, ["<tool_call>", call, "</tool_call>", "\n", "<tool_call>", call, "</tool_call>"])
    assert all(ok for ok, _ in steps)


def test_continuous_batching_path_is_wired():
    """The scheduler can't be imported without MLX; check the wiring in the source."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    batched = open(os.path.join(root, "vmlx_engine/engine/batched.py")).read()
    scheduler = open(os.path.join(root, "vmlx_engine/scheduler.py")).read()
    assert batched.count("tool_grammar=_tool_grammar_spec(kwargs, prompt)") == 2
    assert "build_tool_call_logits_processor(" in scheduler
    assert "self._wrap_generated_only_logits_processor(grammar, max(len(tokens_to_process) - 1, 0))" in scheduler


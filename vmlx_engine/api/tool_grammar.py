# SPDX-License-Identifier: Apache-2.0
"""
Well-formed tool calls for models that write them as JSON inside
``<tool_call> … </tool_call>`` (Qwen2.5, Qwen3, Hermes and their fine-tunes).

Nothing changes while the model writes text or thinks. The moment it emits the
``<tool_call>`` token, the next tokens are held to a grammar: one JSON object
whose ``name`` is one of the request's tools and whose ``arguments`` follow
that tool's parameter schema, then ``</tool_call>``. After the closing token
the model is free again (it may start another call). So a call can no longer
name a tool that does not exist, miss a required argument, or break its JSON,
which small local models otherwise do now and then.

Scope, on purpose:
- Only templates that ask for exactly this JSON shape (the template text says
  ``{"name": <function-name>, "arguments": <args-json-object>}``). XML-style
  tool calls (Qwen3-Coder, ``<function=…>``) and every other format are left
  alone.
- Schemas llguidance cannot compile fall back to "any object" for that tool,
  and any failure at runtime turns the constraint off for the rest of the
  request (the old parser + repair path still runs either way).
- Off with ``VMLX_TOOL_GRAMMAR=0`` (or ``--no-tool-grammar``).

The idea follows Rapid-MLX's tool-call grammar (Apache-2.0); this is our own
implementation on llguidance, which MLX Harness already bundles.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

OPEN_TAG = "<tool_call>"
CLOSE_TAG = "</tool_call>"
# Placeholders every Hermes/Qwen JSON tool template shows the model (Qwen2.5,
# Qwen3, Hermes 2/3): {"name": <function-name>, "arguments": <args-json-object>}.
_JSON_TEMPLATE_MARKERS = ("<function-name>", "<args-json-object>")

_LL_TOKENIZERS: Dict[int, Any] = {}
# Agents send the same tools every turn: keep the checked grammar (small, bounded).
_LARK_CACHE: Dict[Tuple[int, str], Optional[str]] = {}
_LARK_CACHE_MAX = 32


def tool_grammar_enabled() -> bool:
    return os.environ.get("VMLX_TOOL_GRAMMAR", "1").strip().lower() not in ("0", "false", "off", "no")


def _hf_tokenizer(tokenizer: Any) -> Any:
    """The Hugging Face tokenizer inside mlx-lm's TokenizerWrapper (or itself)."""
    return getattr(tokenizer, "_tokenizer", None) or tokenizer


def _chat_template_text(tokenizer: Any) -> str:
    template = getattr(_hf_tokenizer(tokenizer), "chat_template", None) or getattr(tokenizer, "chat_template", None)
    if isinstance(template, dict):
        return "\n".join(str(v) for v in template.values())
    if isinstance(template, list):
        return "\n".join(str(t.get("template", "")) for t in template if isinstance(t, dict))
    return str(template or "")


def _single_token_id(tokenizer: Any, text: str) -> Optional[int]:
    hf = _hf_tokenizer(tokenizer)
    try:
        ids = hf.encode(text, add_special_tokens=False)
    except Exception:
        return None
    return int(ids[0]) if len(ids) == 1 else None


def json_tool_call_tokens(tokenizer: Any) -> Optional[Tuple[int, int]]:
    """(open, close) token ids when this model writes JSON tool calls in tags, else None."""
    template = _chat_template_text(tokenizer)
    if not all(marker in template for marker in _JSON_TEMPLATE_MARKERS) or "<function=" in template:
        return None
    open_id = _single_token_id(tokenizer, OPEN_TAG)
    close_id = _single_token_id(tokenizer, CLOSE_TAG)
    if open_id is None or close_id is None:
        return None
    return open_id, close_id


def _tool_function(tool: Any) -> Optional[dict]:
    if hasattr(tool, "model_dump"):
        tool = tool.model_dump(exclude_none=True)
    if not isinstance(tool, dict):
        return None
    fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
    name = fn.get("name") if isinstance(fn, dict) else None
    if not isinstance(name, str) or not name:
        return None
    params = fn.get("parameters")
    if not isinstance(params, dict) or not params:
        params = {"type": "object"}
    return {"name": name, "parameters": params}


def _call_schema(name: str, params: dict) -> dict:
    return {
        "type": "object",
        "properties": {"name": {"const": name}, "arguments": params},
        "required": ["name", "arguments"],
        "additionalProperties": False,
    }


def tool_call_lark(tools: List[Any], close_id: int, check: Optional[Callable[[str], bool]] = None) -> Optional[str]:
    """The grammar for one call: whitespace, the JSON object, whitespace, the close token.

    ``check`` (optional) compiles a grammar and says whether it works; a tool
    whose parameters fail is held to "any object" instead of being dropped.
    """
    options = []
    seen = set()
    for tool in tools or []:
        fn = _tool_function(tool)
        if not fn or fn["name"] in seen:
            continue
        seen.add(fn["name"])
        schema = _call_schema(fn["name"], fn["parameters"])
        if check is not None and not check(_lark_for([schema], close_id)):
            schema = _call_schema(fn["name"], {"type": "object"})
        options.append(schema)
    if not options:
        return None
    return _lark_for(options, close_id)


def _lark_for(options: List[dict], close_id: int) -> str:
    schema = {"anyOf": options, "x-guidance": {"whitespace_flexible": True, "lenient": True}}
    return (
        f"start: WS call WS <[{int(close_id)}]>\n"
        "WS: /[ \\t\\n]*/\n"
        f"call: %json {json.dumps(schema, ensure_ascii=False)}\n"
    )


def _generated(tokens: Any) -> List[int]:
    try:
        values = tokens.tolist()
    except Exception:
        try:
            values = list(tokens)
        except Exception:
            return []
    if values and isinstance(values[0], list):
        values = values[0]
    return [int(v) for v in values]


class ToolCallGrammar:
    """mlx-lm logits processor ``(tokens, logits) -> logits`` for one request.

    ``tokens`` follows generate_step: the last prompt token on the first call,
    then that token plus everything generated so far.
    """

    def __init__(self, matcher: Any, bitmask: Any, open_id: int, close_id: int,
                 think_ids: Tuple[Optional[int], Optional[int]], thinking: bool,
                 fill: Callable[..., Any], apply: Callable[..., Any]) -> None:
        self.matcher = matcher
        self.bitmask = bitmask
        self.open_id = open_id
        self.close_id = close_id
        self.think_open, self.think_close = think_ids
        self.thinking = thinking
        self.active = False
        self.broken = False
        self.seen = 0
        self._fill = fill
        self._apply = apply

    def _advance(self, token: int) -> None:
        if self.active:
            try:
                self.matcher.consume_token(token)
            except Exception:
                self.broken = True
                self.active = False
                return
            if self.matcher.is_stopped() or self.matcher.get_error():
                if self.matcher.get_error():
                    logger.debug("tool grammar: %s", self.matcher.get_error())
                self.active = False
            return
        if token == self.think_open:
            self.thinking = True
        elif token == self.think_close:
            self.thinking = False
        elif token == self.open_id and not self.thinking:
            try:
                self.matcher.reset()
                self.active = True
            except Exception:
                self.broken = True

    def __call__(self, tokens: Any, logits: Any) -> Any:
        if self.broken:
            return logits
        generated = _generated(tokens)[1:]
        if len(generated) < self.seen:  # a fresh context (resumed request): start over, unconstrained
            self.seen, self.active = len(generated), False
        for token in generated[self.seen:]:
            self._advance(token)
        self.seen = len(generated)
        if not self.active:
            return logits
        try:
            self.bitmask.fill(-1)
            self._fill(self.matcher, self.bitmask, 0)
            return self._apply(logits, self.bitmask)
        except Exception as exc:
            logger.debug("tool grammar mask failed: %s", exc)
            self.broken = True
            return logits


def build_tool_call_logits_processor(tools: Optional[List[Any]], tokenizer: Any,
                                     thinking_open: bool = False) -> Optional[ToolCallGrammar]:
    """A processor for this request's tools, or None (other formats, no tools, off, or unavailable)."""
    if not tools or tokenizer is None or not tool_grammar_enabled():
        return None
    ids = json_tool_call_tokens(tokenizer)
    if ids is None:
        return None
    open_id, close_id = ids
    try:
        from llguidance import LLMatcher, grammar_from
        from llguidance.hf import from_tokenizer
        from llguidance.numpy import allocate_token_bitmask, fill_next_token_bitmask
        try:
            from llguidance.mlx import apply_token_bitmask
        except Exception:  # not on a Mac (tests): numpy logits
            from llguidance.numpy import apply_token_bitmask_inplace

            def apply_token_bitmask(logits, mask):
                apply_token_bitmask_inplace(logits, mask)
                return logits
    except Exception as exc:
        logger.debug("tool grammar unavailable: %s", exc)
        return None

    hf = _hf_tokenizer(tokenizer)
    try:
        ll_tokenizer = _LL_TOKENIZERS.get(id(hf))
        if ll_tokenizer is None:
            ll_tokenizer = from_tokenizer(hf)
            _LL_TOKENIZERS[id(hf)] = ll_tokenizer

        def compiles(lark: str) -> bool:
            try:
                return not LLMatcher(ll_tokenizer, grammar_from("lark", lark)).get_error()
            except Exception:
                return False

        key = (id(hf), json.dumps([_tool_function(t) for t in tools], sort_keys=True, default=str))
        if key in _LARK_CACHE:
            lark = _LARK_CACHE[key]
        else:
            lark = tool_call_lark(tools, close_id, check=compiles)
            if len(_LARK_CACHE) >= _LARK_CACHE_MAX:
                _LARK_CACHE.pop(next(iter(_LARK_CACHE)))
            _LARK_CACHE[key] = lark
        if not lark:
            return None
        matcher = LLMatcher(ll_tokenizer, grammar_from("lark", lark))
        if matcher.get_error():
            logger.debug("tool grammar: %s", matcher.get_error())
            return None
        bitmask = allocate_token_bitmask(1, ll_tokenizer.vocab_size)
    except Exception as exc:
        logger.debug("tool grammar setup failed: %s", exc)
        return None

    think_ids = (_single_token_id(tokenizer, "<think>"), _single_token_id(tokenizer, "</think>"))
    return ToolCallGrammar(matcher, bitmask, open_id, close_id, think_ids, thinking_open,
                           fill_next_token_bitmask, apply_token_bitmask)


def prompt_leaves_thinking_open(prompt: Any) -> bool:
    """True when the rendered prompt ends inside a <think> block (the model thinks first)."""
    if not isinstance(prompt, str):
        return False
    tail = prompt.rstrip()[-200:]
    return tail.rfind("<think>") > tail.rfind("</think>")

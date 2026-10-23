# SPDX-License-Identifier: Apache-2.0
"""DRY repetition penalty (vmlx_engine.sampling_dry, adapted from Rapid-MLX)."""

from types import SimpleNamespace

from vmlx_engine.request import SamplingParams
from vmlx_engine.sampling_dry import (
    DEFAULT_ALLOWED_LENGTH,
    DEFAULT_BASE,
    breaker_token_ids,
    dry_penalties,
    dry_processor_from_params,
)


def test_off_by_default_and_with_zero_multiplier():
    assert SamplingParams().dry_multiplier == 0.0
    assert dry_processor_from_params(SamplingParams(), tokenizer=None) is None
    assert dry_penalties([1, 2, 3, 1, 2], multiplier=0, base=1.75, allowed_length=2, breakers=frozenset()) == {}


def test_penalizes_the_token_that_would_extend_a_verbatim_repeat():
    # "1 2 3 4 ... 1 2 3" -> continuing with 4 repeats a 3-token stretch.
    tokens = [1, 2, 3, 4, 9, 9, 1, 2, 3]
    penalties = dry_penalties(tokens, multiplier=0.8, base=1.75, allowed_length=2, breakers=frozenset())
    assert set(penalties) == {4}
    assert abs(penalties[4] - 0.8 * 1.75 ** (3 - 2)) < 1e-9


def test_short_repeats_and_breakers_are_left_alone():
    # Only a 1-token match: below allowed_length.
    assert dry_penalties([5, 7, 8, 5], multiplier=1, base=2, allowed_length=2, breakers=frozenset()) == {}
    # A breaker (token 0) as the last token ends every match.
    assert dry_penalties([1, 2, 3, 1, 2, 0], multiplier=1, base=2, allowed_length=1, breakers=frozenset({0})) == {}
    # A breaker inside the stretch cuts the match short.
    tokens = [1, 0, 2, 3, 4, 1, 0, 2, 3]
    assert set(dry_penalties(tokens, multiplier=1, base=2, allowed_length=2, breakers=frozenset({0}))) == {4}


def test_penalty_last_n_limits_the_window():
    tokens = [1, 2, 3, 4] + [7] * 20 + [1, 2, 3]
    assert dry_penalties(tokens, multiplier=1, base=2, allowed_length=2, breakers=frozenset(), penalty_last_n=10) == {}


class _Tok:
    def encode(self, text, add_special_tokens=False):
        return [ord(c) for c in text]


def test_breakers_use_the_token_they_end_with_in_running_text():
    assert breaker_token_ids(_Tok(), ["\n", ":"]) == frozenset({ord("\n"), ord(":")})


def test_processor_from_request_params_and_history():
    params = SamplingParams(dry_multiplier=0.8, dry_allowed_length=3, dry_sequence_breakers=["\n"])
    cache = {}
    proc = dry_processor_from_params(params, _Tok(), cache)
    assert proc is not None
    assert proc.multiplier == 0.8 and proc.allowed_length == 3 and proc.base == DEFAULT_BASE
    assert proc.breakers == frozenset({ord("\n")})
    assert cache  # breaker ids memoized per breaker tuple
    request = SimpleNamespace(prompt_token_ids=[1, 2, 3, 4], output_token_ids=[9, 1, 2, 3])
    bound = proc.bind(request)
    assert bound.history() == [1, 2, 3, 4, 9, 1, 2, 3]
    assert set(proc.penalties(bound.history())) == {4}
    defaults = dry_processor_from_params(SamplingParams(dry_multiplier=1.0), _Tok())
    assert defaults.allowed_length == DEFAULT_ALLOWED_LENGTH

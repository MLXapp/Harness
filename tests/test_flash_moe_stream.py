"""Flash MoE from load (0.5.3): memory-sized expert cache, lazy load, prompt chunks."""
import argparse
import json

import pytest

GIB = 1024 ** 3


class TestCacheBudget:
    def test_small_mac_keeps_seven_gb_free(self):
        from vmlx_engine.flash_moe_config import flash_moe_cache_bytes

        # 32 GB Mac, 20 GB available, 6 GB of resident weights:
        # min(20 - 7, 24 - 6) = 13 GB.
        assert flash_moe_cache_bytes(32 * GIB, 20 * GIB, 6 * GIB) == 13 * GIB

    def test_big_mac_caps_the_process_at_sixty_percent(self):
        from vmlx_engine.flash_moe_config import flash_moe_cache_bytes

        # 128 GB Mac, 110 GB available, 30 GB resident: keep 19.2 GB free
        # (15%), footprint cap 76.8 GB → the cap wins: 76.8 - 30.
        got = flash_moe_cache_bytes(128 * GIB, 110 * GIB, 30 * GIB)
        assert got == int(128 * GIB * 0.60) - 30 * GIB

    def test_never_below_half_a_gigabyte(self):
        from vmlx_engine.flash_moe_config import flash_moe_cache_bytes

        assert flash_moe_cache_bytes(16 * GIB, 6 * GIB, 10 * GIB) == 512 * 1024 ** 2

    def test_a_size_the_user_set_wins(self):
        from vmlx_engine.flash_moe_config import flash_moe_cache_bytes

        assert flash_moe_cache_bytes(64 * GIB, 1 * GIB, 60 * GIB, requested_gb=3) == 3 * GIB


class TestByteLimitedCache:
    def _expert(self, layer, idx, nbytes):
        from vmlx_engine.utils.flash_moe_loader import ExpertWeightSet

        class Blob:
            def __init__(self, n):
                self.nbytes = n

        return ExpertWeightSet(layer_idx=layer, expert_idx=idx, tensors={"gate_proj": {"weight": Blob(nbytes)}})

    def test_evicts_oldest_until_it_fits(self):
        from vmlx_engine.utils.flash_moe_loader import SlotBankCache

        cache = SlotBankCache(max_slots=0, max_bytes=250)
        for i in range(3):
            cache.put(self._expert(0, i, 100))
        stats = cache.stats()
        assert stats["slots_used"] == 2 and stats["bytes_used"] == 200
        assert cache.get(0, 0) is None  # the oldest went first
        assert cache.get(0, 2) is not None

    def test_shrinking_the_budget_evicts(self):
        from vmlx_engine.utils.flash_moe_loader import SlotBankCache

        cache = SlotBankCache(max_slots=0)
        for i in range(4):
            cache.put(self._expert(1, i, 100))
        cache.set_max_bytes(150)
        assert cache.stats()["bytes_used"] == 100

    def test_slot_limit_still_applies_when_set(self):
        from vmlx_engine.utils.flash_moe_loader import SlotBankCache

        cache = SlotBankCache(max_slots=2, max_bytes=10_000)
        for i in range(3):
            cache.put(self._expert(0, i, 10))
        assert cache.stats()["slots_used"] == 2


class TestPrefillStep:
    def _args(self, **kw):
        base = dict(flash_moe=True, prefill_step_size=2048)
        base.update(kw)
        return argparse.Namespace(**base)

    def test_streaming_raises_the_default(self):
        from vmlx_engine.cli import _raise_prefill_step_for_streaming

        args = self._args()
        _raise_prefill_step_for_streaming(args, ["serve", "m", "--flash-moe"])
        assert args.prefill_step_size == 4096

    def test_a_size_on_the_command_line_stays(self):
        from vmlx_engine.cli import _raise_prefill_step_for_streaming

        args = self._args()
        _raise_prefill_step_for_streaming(args, ["serve", "m", "--prefill-step-size", "2048"])
        assert args.prefill_step_size == 2048

    def test_off_without_streaming(self):
        from vmlx_engine.cli import _raise_prefill_step_for_streaming

        args = self._args(flash_moe=False)
        _raise_prefill_step_for_streaming(args, [])
        assert args.prefill_step_size == 2048


@pytest.fixture(scope="module")
def tiny_moe(tmp_path_factory):
    mx = pytest.importorskip("mlx.core")
    nn = pytest.importorskip("mlx.nn")
    pytest.importorskip("mlx_lm")
    from mlx.utils import tree_flatten
    from mlx_lm.models import qwen3_moe

    out = tmp_path_factory.mktemp("tiny_moe")
    cfg = dict(
        model_type="qwen3_moe", hidden_size=128, num_hidden_layers=3, intermediate_size=256,
        num_attention_heads=4, num_experts=16, num_experts_per_tok=4, decoder_sparse_step=1,
        mlp_only_layers=[], moe_intermediate_size=128, rms_norm_eps=1e-6, vocab_size=512,
        num_key_value_heads=2, head_dim=32, rope_theta=1e6, tie_word_embeddings=False,
        max_position_embeddings=1024, norm_topk_prob=True,
    )
    mx.random.seed(0)
    model = qwen3_moe.Model(qwen3_moe.ModelArgs.from_dict(cfg))
    weights = model.sanitize(dict(tree_flatten(model.parameters())))
    model.load_weights(list(weights.items()))
    nn.quantize(model, group_size=64, bits=4)
    cfg["quantization"] = {"group_size": 64, "bits": 4}
    mx.save_safetensors(str(out / "model.safetensors"), dict(tree_flatten(model.parameters())))
    (out / "config.json").write_text(json.dumps(cfg))
    return out


def test_streams_from_load_with_the_same_answers(tiny_moe):
    import mlx.core as mx
    from mlx_lm.utils import load_model

    from vmlx_engine.utils.flash_moe_stream import stream_experts_on_load

    prompt = mx.array([[1, 7, 42, 99, 3, 250, 17]])
    eager, _ = load_model(tiny_moe, lazy=False)
    expected = eager(prompt)
    mx.eval(expected)
    del eager

    mx.clear_cache()
    mx.reset_peak_memory()
    model, _ = load_model(tiny_moe, lazy=True)
    streamed = stream_experts_on_load(model, str(tiny_moe), slot_bank=0, cache_gb=0.001)
    assert streamed is not None and streamed.layers == 3
    assert model._vmlx_flash_moe_loader is streamed.loader
    # Expert weights are never read: what loads is the model minus them.
    file_bytes = (tiny_moe / "model.safetensors").stat().st_size
    assert mx.get_peak_memory() < file_bytes - streamed.freed_bytes * 0.9

    got = model(prompt)
    mx.eval(got)
    assert float(mx.max(mx.abs(got - expected)).item()) < 1e-4
    stats = streamed.loader._cache.stats()
    assert stats["bytes_used"] <= stats["max_bytes"] == int(0.001 * GIB)
    streamed.loader.shutdown()


def test_a_dense_model_is_left_alone(tmp_path):
    mx = pytest.importorskip("mlx.core")
    pytest.importorskip("mlx_lm")
    from vmlx_engine.utils.flash_moe_stream import stream_experts_on_load

    mx.save_safetensors(str(tmp_path / "model.safetensors"), {"model.embed_tokens.weight": mx.zeros((4, 4))})
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "qwen3"}))
    assert stream_experts_on_load(object(), str(tmp_path)) is None

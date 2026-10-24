"""Stream a MoE model's experts from the SSD from the moment it loads.

Before 0.5.3, Flash MoE was applied after the model had loaded with every
weight in memory, so it could make a model that fits use less memory but could
never run one that doesn't. Here the model is built lazily (nothing read yet),
the experts are swapped for on-demand loading and dropped, and only then are
the remaining weights (attention, router, shared experts, embeddings) read.
A MoE model can then run on a Mac with less memory than its files, as long
as those remaining weights fit.

The expert cache is sized from what macOS can spare (see
``flash_moe_cache_bytes``), unless the user set a slot count or a size.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

import mlx.core as mx

logger = logging.getLogger(__name__)


@dataclass
class StreamedExperts:
    loader: object
    layers: int
    freed_bytes: int
    cache_bytes: int


def memory_snapshot() -> tuple[int, int]:
    """(total, available) bytes of this Mac's memory."""
    try:
        import psutil

        vm = psutil.virtual_memory()
        return int(vm.total), int(vm.available)
    except Exception:  # pragma: no cover - psutil ships with the engine
        total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        return int(total), int(total * 0.5)


def size_expert_cache(cache, requested_gb: float = 0.0) -> int:
    """Give the cache its byte budget, measured now that the rest is loaded."""
    from ..flash_moe_config import flash_moe_cache_bytes

    total, available = memory_snapshot()
    try:
        resident = int(mx.get_active_memory())
    except Exception:
        resident = 0
    budget = flash_moe_cache_bytes(total, available, resident, requested_gb)
    cache.set_max_bytes(budget)
    return budget


def stream_experts_on_load(
    model,
    model_path: str,
    *,
    slot_bank: int = 0,
    cache_gb: float = 0.0,
    io_workers: int = 4,
) -> Optional[StreamedExperts]:
    """Patch a lazily built model for expert streaming, then read the rest.

    Returns None (and leaves the model untouched) when the model has no MoE
    layers this loader can stream; the caller then evaluates it as usual.
    """
    from .flash_moe_loader import FlashMoEExpertLoader, SlotBankCache
    from .smelt_loader import ExpertIndex
    from ..models.flash_moe_integration import apply_flash_moe, free_expert_weights

    index = ExpertIndex.build(model_path)
    if index.num_moe_layers == 0:
        return None
    # slot_bank <= 0: no count limit, the byte budget decides.
    cache = SlotBankCache(max_slots=max(0, int(slot_bank or 0)))
    loader = FlashMoEExpertLoader(expert_index=index, cache=cache, io_workers=io_workers)
    patched = apply_flash_moe(model, loader)
    if patched <= 0:
        loader.shutdown()
        return None
    model._vmlx_flash_moe_loader = loader
    freed = free_expert_weights(model)
    # Read everything that stays resident. The experts were replaced by
    # 1-byte placeholders above, so their bytes are never read here.
    mx.eval(model.parameters())
    budget = size_expert_cache(cache, cache_gb)
    logger.info(
        "Flash MoE: streaming experts of %d layers from the SSD "
        "(%.1f GB not loaded; expert cache up to %.1f GB%s)",
        patched,
        freed / 1e9,
        budget / 1e9,
        f", {slot_bank} experts at most" if slot_bank and slot_bank > 0 else "",
    )
    return StreamedExperts(loader=loader, layers=patched, freed_bytes=freed, cache_bytes=budget)

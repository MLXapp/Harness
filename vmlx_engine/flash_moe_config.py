# SPDX-License-Identifier: Apache-2.0
"""Flash MoE configuration for SSD expert streaming."""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FlashMoEConfig:
    """Configuration for Flash MoE SSD expert streaming.

    Enables massive MoE models (35B-397B) to run on Macs with limited RAM
    by streaming expert weights from SSD on-demand, keeping only active
    experts in a slot-bank cache.

    Attributes:
        enabled: Whether Flash MoE is active. Default False (opt-in).
        slot_bank_size: Maximum number of expert weight sets cached in RAM.
            Higher = more cache hits but more RAM. Typical: 64-128.
        prefetch: Prefetching strategy for experts.
            "none" — no prefetching, load on demand only.
            "temporal" — prefetch experts that were recently used (LRU warmup).
        cache_io_split: Number of parallel I/O operations for expert loading.
            Higher = faster loading but more I/O pressure. Default 4.
        expert_index_path: Optional path to a pre-built expert index JSON.
            If None, the index is built on first load from safetensors headers.
    """

    enabled: bool = False
    slot_bank_size: int = 64
    prefetch: str = "none"
    cache_io_split: int = 4
    expert_index_path: Optional[str] = None

    def __post_init__(self):
        if self.slot_bank_size < 1:
            raise ValueError(f"slot_bank_size must be >= 1, got {self.slot_bank_size}")
        if self.prefetch not in ("none", "temporal"):
            raise ValueError(
                f"prefetch must be 'none' or 'temporal', got '{self.prefetch}'"
            )
        if self.cache_io_split < 1:
            raise ValueError(
                f"cache_io_split must be >= 1, got {self.cache_io_split}"
            )

    @classmethod
    def from_dict(cls, d: dict) -> "FlashMoEConfig":
        """Create from a dictionary (e.g., from config file or API request)."""
        return cls(
            enabled=d.get("enabled", False),
            slot_bank_size=d.get("slot_bank_size", d.get("slot_bank", 64)),
            prefetch=d.get("prefetch", "none"),
            cache_io_split=d.get("cache_io_split", 4),
            expert_index_path=d.get("expert_index_path"),
        )

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "slot_bank_size": self.slot_bank_size,
            "prefetch": self.prefetch,
            "cache_io_split": self.cache_io_split,
            "expert_index_path": self.expert_index_path,
        }


# ── How much memory the expert cache may use ────────────────────────────────

GIB = 1024 ** 3


def flash_moe_cache_bytes(
    total_bytes: int,
    available_bytes: int,
    resident_bytes: int,
    requested_gb: float = 0.0,
    floor_bytes: int = 0,
) -> int:
    """Bytes the expert cache may hold, when the user did not set a size.

    The cache's size matters more than anything else when experts stream from
    the SSD (Strata measured 5.5 → 7.5 tok/s going from a 7.5 GB to a 12 GB
    cache on a 32 GB Mac), so it takes what macOS can spare, with the limits
    that kept their Macs out of swap and kernel panics:

    - leave macOS at least 7 GB, or 15% of the memory when that is more;
    - keep the whole process under 60% of the memory on a Mac with 64 GB or
      more, 75% below that;
    - inside that, leave 10% of the memory for the KV and prefix caches,
      which fill after this is measured.

    ``floor_bytes`` (e.g. what the old fixed 256-expert cache held) is kept
    when it still fits under the process cap, so a low reading of available
    memory never shrinks the cache below what it used to be. Never less than
    512 MB. The approach follows Strata's Metal engine (MIT); our own code.
    """
    if requested_gb and requested_gb > 0:
        return int(requested_gb * GIB)
    keep_free = max(7 * GIB, int(total_bytes * 0.15))
    kv_reserve = int(total_bytes * KV_RESERVE_SHARE)
    footprint_cap = int(total_bytes * (0.60 if total_bytes >= 64 * GIB else 0.75))
    room_under_cap = footprint_cap - resident_bytes - kv_reserve
    budget = min(available_bytes - keep_free - kv_reserve, room_under_cap)
    budget = max(budget, min(int(floor_bytes), room_under_cap))
    return max(int(budget), 512 * 1024 ** 2)


KV_RESERVE_SHARE = 0.10

#: Model types whose experts may stream from the moment the model loads
#: (and that the app turns Flash MoE on for by itself): softmax top-k routing
#: that FlashMoEBlock reproduces exactly, checked against the resident model.
#: Others keep the old path (patched after a full load), if they stream at all.
STREAM_FROM_LOAD_MODEL_TYPES = frozenset({"qwen3_moe", "qwen3_next", "mixtral"})

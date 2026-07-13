"""Worker 环境配置边界。"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class WorkerSettings:
    runtime_root: Path
    shared_secret: str | None
    max_body_bytes: int
    max_concurrency: int
    clock_skew_seconds: int
    tool_timeout_seconds: float
    nonce_cache_max: int

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        return cls(
            runtime_root=Path(os.environ.get("RUNTIME_ROOT", "runtime")).resolve(),
            shared_secret=os.environ.get("WORKER_SHARED_SECRET"),
            max_body_bytes=_positive_int("WORKER_MAX_BODY_BYTES", 16 * 1024 * 1024),
            max_concurrency=_positive_int("WORKER_MAX_CONCURRENCY", 2),
            clock_skew_seconds=_non_negative_int("WORKER_CLOCK_SKEW_SECONDS", 30),
            tool_timeout_seconds=_positive_float("WORKER_TOOL_TIMEOUT_SECONDS", 300.0),
            nonce_cache_max=_positive_int("WORKER_NONCE_CACHE_MAX", 10_000),
        )


def _positive_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} 必须大于 0")
    return value


def _non_negative_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value < 0:
        raise ValueError(f"{name} 不能小于 0")
    return value


def _positive_float(name: str, default: float) -> float:
    value = float(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} 必须大于 0")
    return value

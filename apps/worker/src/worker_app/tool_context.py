"""Worker 工具执行上下文。"""

from __future__ import annotations

from dataclasses import dataclass

from worker_app.path_sandbox import WorkerPathSandbox


@dataclass(frozen=True)
class WorkerToolContext:
    """由应用装配层注入工具的运行时依赖。"""

    path_sandbox: WorkerPathSandbox

# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具进程执行边界
#
#   文件:       execution.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5
# --------------------------------------------------------------------------

"""在可回收的子进程中执行科学计算。

科学计算可能进入原生库或不可取消的 Python 调用。将其放在
``asyncio.to_thread`` 中无法在超时后终止底层线程，因此本模块把每次工具
调用放入独立子进程；超时、客户端取消或 Worker 关闭时可以明确终止该进程。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import multiprocessing
from pathlib import Path
import traceback
from typing import Any, Protocol

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


class WorkerToolExecutor(Protocol):
    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: WorkerToolContext,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        """执行工具，并在超时或取消时释放执行资源。"""


class WorkerToolTimeoutError(TimeoutError):
    """科学计算子进程已被超时终止。"""


class WorkerToolExecutionError(RuntimeError):
    """子进程返回了不可公开的执行错误。"""

    def __init__(self, message: str, *, invalid_request: bool = False) -> None:
        super().__init__(message)
        self.invalid_request = invalid_request


@dataclass(frozen=True, slots=True)
class ProcessExecutionOptions:
    poll_interval_seconds: float = 0.02
    terminate_grace_seconds: float = 0.5


class InProcessToolExecutor:
    """仅供单元测试和显式本地调用使用的直接执行器。

    生产应用必须注入 :class:`ProcessToolExecutor`。保留该实现可以让路由
    测试使用 lambda 或测试替身，而不会把测试注册表强行要求为可 pickle。
    """

    def __init__(self, registry: WorkerToolRegistry) -> None:
        self.registry = registry

    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: WorkerToolContext,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        del timeout_seconds
        return self.registry.dispatch(tool_name, args, context)


class ProcessToolExecutor:
    """每次工具调用使用独立子进程，超时后可硬终止并回收。"""

    def __init__(
        self,
        registry: WorkerToolRegistry,
        *,
        options: ProcessExecutionOptions | None = None,
    ) -> None:
        self.registry = registry
        self.options = options or ProcessExecutionOptions()
        # Spawn avoids inheriting event-loop, DB-client or native-library locks
        # from the HTTP process. It is available on both Windows and POSIX and
        # gives every scientific call the same clean execution boundary.
        self._context = multiprocessing.get_context("spawn")
        self._active_processes: set[multiprocessing.Process] = set()

    async def shutdown(self) -> None:
        """终止并回收所有仍在运行的科学计算子进程。"""

        processes = tuple(self._active_processes)
        if not processes:
            return
        await asyncio.gather(
            *(asyncio.to_thread(self._terminate_process, process) for process in processes),
            return_exceptions=False,
        )

    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: WorkerToolContext,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if timeout_seconds <= 0:
            raise ValueError("Worker 工具超时必须大于 0")

        parent_connection, child_connection = self._context.Pipe(duplex=False)
        process = self._context.Process(
            target=_run_tool_child,
            args=(
                child_connection,
                self.registry,
                tool_name,
                args,
                context.path_sandbox.runtime_root,
            ),
            name=f"geo-worker-tool-{tool_name}",
            daemon=True,
        )
        try:
            process.start()
        except BaseException:
            child_connection.close()
            parent_connection.close()
            raise
        self._active_processes.add(process)
        child_connection.close()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds

        try:
            while True:
                if parent_connection.poll():
                    return _decode_child_message(parent_connection.recv())
                if not process.is_alive():
                    # A process can exit before writing its result when an import
                    # or native library crashes. Report that as a failed tool.
                    if parent_connection.poll():
                        return _decode_child_message(parent_connection.recv())
                    raise WorkerToolExecutionError("Worker 工具子进程异常退出")
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise WorkerToolTimeoutError("Worker 工具执行超时")
                await asyncio.sleep(min(self.options.poll_interval_seconds, remaining))
        except asyncio.CancelledError:
            self._terminate_process(process)
            raise
        except BaseException:
            self._terminate_process(process)
            raise
        finally:
            # A successful child may still be unwinding imports or flushing
            # descriptors after sending its payload; join it here so each
            # request has a bounded process-handle lifetime as well.
            self._terminate_process(process)
            self._active_processes.discard(process)
            parent_connection.close()

    def _terminate_process(self, process: multiprocessing.Process) -> None:
        if process.is_alive():
            process.terminate()
            process.join(timeout=self.options.terminate_grace_seconds)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(timeout=self.options.terminate_grace_seconds)
        else:
            process.join(timeout=0)


def _run_tool_child(
    connection: Any,
    registry: WorkerToolRegistry,
    tool_name: str,
    args: dict[str, Any],
    runtime_root: Path,
) -> None:
    """子进程入口；只通过受限消息通道回传 payload 或错误分类。"""

    try:
        # Windows spawn starts a fresh interpreter; restore the scientific
        # package path explicitly instead of relying on inherited sys.path.
        from worker_app.bootstrap import configure_science_package_path

        configure_science_package_path(Path(__file__))
        context = WorkerToolContext(WorkerPathSandbox(Path(runtime_root)))
        payload = registry.dispatch(tool_name, args, context)
        connection.send(("ok", payload))
    except (ValueError, FileNotFoundError) as exc:
        connection.send(("invalid", str(exc)))
    except BaseException as exc:  # pragma: no cover - native crashes have no Python traceback
        connection.send(("failed", type(exc).__name__, str(exc), traceback.format_exc(limit=3)))
    finally:
        connection.close()


def _decode_child_message(message: Any) -> dict[str, Any]:
    if not isinstance(message, tuple) or not message:
        raise WorkerToolExecutionError("Worker 工具子进程返回了无效消息")
    kind = message[0]
    if kind == "ok" and len(message) == 2 and isinstance(message[1], dict):
        return message[1]
    if kind == "invalid":
        raise WorkerToolExecutionError(str(message[1]), invalid_request=True)
    if kind == "failed":
        detail = str(message[2]) if len(message) > 2 else ""
        raise WorkerToolExecutionError(f"Worker 工具子进程失败：{detail}")
    raise WorkerToolExecutionError("Worker 工具子进程返回了未知消息")

# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 子进程执行边界测试
#
#   文件:       test_worker_execution.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5
# --------------------------------------------------------------------------

"""验证 Worker 工具超时会终止子进程，而不是遗留后台线程。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import time
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app.execution import ProcessToolExecutor, WorkerToolExecutionError, WorkerToolTimeoutError
from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.app_factory import create_worker_app
from worker_app.settings import WorkerSettings
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tool_routes import register_tool_routes


class DelayRequest(BaseModel):
    seconds: float


def delay_tool(args: dict, _context: WorkerToolContext) -> dict:
    time.sleep(args["seconds"])
    return {"completed": True}


class WorkerExecutionTests(unittest.TestCase):
    def _executor(self) -> tuple[ProcessToolExecutor, WorkerToolContext, tempfile.TemporaryDirectory]:
        registry = WorkerToolRegistry()
        registry.register("delay", delay_tool, request_model=DelayRequest)
        directory = tempfile.TemporaryDirectory()
        context = WorkerToolContext(WorkerPathSandbox(Path(directory.name)))
        return ProcessToolExecutor(registry), context, directory

    def test_successful_tool_runs_in_child_process(self) -> None:
        executor, context, directory = self._executor()
        try:
            result = asyncio.run(executor.execute("delay", {"seconds": 0.01}, context, timeout_seconds=5))
        finally:
            directory.cleanup()
        self.assertEqual(result, {"completed": True})

    def test_timeout_terminates_child_process(self) -> None:
        executor, context, directory = self._executor()
        started = time.perf_counter()
        try:
            with self.assertRaises(WorkerToolTimeoutError):
                asyncio.run(executor.execute("delay", {"seconds": 5}, context, timeout_seconds=0.1))
        finally:
            directory.cleanup()
        self.assertLess(time.perf_counter() - started, 2, "超时后不得遗留执行线程或进程")

    def test_route_returns_504_after_child_is_terminated(self) -> None:
        registry = WorkerToolRegistry()
        registry.register("delay", delay_tool, request_model=DelayRequest)
        app = FastAPI()
        directory = tempfile.TemporaryDirectory()
        try:
            register_tool_routes(
                app,
                tool_timeout_seconds=0.1,
                logger=logging.getLogger("worker.test.execution"),
                tool_context=WorkerToolContext(WorkerPathSandbox(Path(directory.name))),
                tool_executor=ProcessToolExecutor(registry),
            )
            response = TestClient(app).post("/tools/delay", json={"args": {"seconds": 5}})
        finally:
            directory.cleanup()
        self.assertEqual(response.status_code, 504)

    def test_request_cancellation_terminates_child_process(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> None:
            task = asyncio.create_task(
                executor.execute("delay", {"seconds": 5}, context, timeout_seconds=10)
            )
            await asyncio.sleep(0.1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        started = time.perf_counter()
        try:
            asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertLess(time.perf_counter() - started, 2, "取消请求后不得遗留 Worker 子进程")

    def test_shutdown_terminates_active_child_processes(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> None:
            task = asyncio.create_task(
                executor.execute("delay", {"seconds": 5}, context, timeout_seconds=10)
            )
            await asyncio.sleep(0.1)
            await executor.shutdown()
            with self.assertRaises(WorkerToolExecutionError):
                await task

        try:
            asyncio.run(scenario())
        finally:
            directory.cleanup()

    def test_production_app_wires_auth_limiter_and_process_executor(self) -> None:
        secret = "integration-worker-secret"
        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "RUNTIME_ROOT": directory,
                "WORKER_SHARED_SECRET": secret,
                "WORKER_MAX_CONCURRENCY": "1",
                "WORKER_TOOL_TIMEOUT_SECONDS": "10",
                "WORKER_CONCURRENCY_LEASE_SECONDS": "11",
            }
            with patch.dict(os.environ, environment, clear=False):
                app = create_worker_app(WorkerSettings.from_env())
            body = b'{"args":{}}'
            auth = _sign_request("recommend_radar_mosaic_strategy", body, secret)
            with TestClient(app) as client:
                response = client.post(
                    "/tools/recommend_radar_mosaic_strategy",
                    content=body,
                    headers={"content-type": "application/json", "authorization": auth},
                )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["payload"]["goalMode"], "quicklook")


def _sign_request(tool_name: str, body: bytes, secret: str) -> str:
    now = int(time.time())
    payload = {
        "v": 1,
        "toolName": tool_name,
        "iat": now,
        "exp": now + 60,
        "nonce": f"integration-nonce-{now}-{hashlib.sha256(body).hexdigest()[:12]}",
        "bodyHash": hashlib.sha256(body).hexdigest(),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    signature = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"GeoAgentPlatform-Worker {encoded}.{encoded_signature}"


if __name__ == "__main__":
    unittest.main()

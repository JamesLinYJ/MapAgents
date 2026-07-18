"""Worker registry、上下文注入和认证目标单元测试。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.security_middleware import worker_auth_target
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import register_builtin_tools


class EchoRequest(BaseModel):
    value: str


class WorkerRegistryTests(unittest.TestCase):
    def test_builtin_catalog_is_complete_and_isolated(self) -> None:
        first = WorkerToolRegistry()
        second = WorkerToolRegistry()
        register_builtin_tools(first)
        register_builtin_tools(second)

        self.assertEqual(first.catalog()["count"], 19)
        self.assertEqual(first.list_tools(), second.list_tools())
        self.assertIn("meteorological_inspect", first.list_tools())
        self.assertIn("render_radar_mosaic", first.list_tools())

    def test_dispatch_receives_injected_runtime_root(self) -> None:
        registry = WorkerToolRegistry()

        def echo(args, context):
            return {"value": args["value"], "root": str(context.path_sandbox.runtime_root)}

        registry.register("echo", echo, request_model=EchoRequest)
        with tempfile.TemporaryDirectory() as directory:
            context = WorkerToolContext(WorkerPathSandbox(Path(directory)))
            result = registry.dispatch("echo", {"value": "ok"}, context)

        self.assertEqual(result["value"], "ok")
        self.assertEqual(Path(result["root"]), Path(directory).resolve())

    def test_catalog_uses_the_signed_catalog_target(self) -> None:
        self.assertEqual(worker_auth_target("/tools/catalog"), "catalog")
        self.assertEqual(worker_auth_target("/tools/meteorological_stats"), "meteorological_stats")


if __name__ == "__main__":
    unittest.main()

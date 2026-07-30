# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具执行路由
#
#   文件:       tool_routes.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker 工具执行 HTTP 路由。"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


class ToolRequest(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)


def register_tool_routes(
    app: FastAPI,
    *,
    tool_timeout_seconds: float,
    logger: logging.Logger,
    tool_registry: WorkerToolRegistry,
    tool_context: WorkerToolContext,
) -> None:
    @app.post("/tools/{tool_name}")
    async def run_meteorology_tool(tool_name: str, tool_request: ToolRequest, request: Request) -> dict[str, Any]:
        """执行无状态科学计算；所有路径都必须是 runtime 根目录内的相对引用。"""
        trace_id = getattr(request.state, "trace_id", None)
        started = time.perf_counter()
        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(tool_registry.dispatch, tool_name, tool_request.args, tool_context),
                timeout=tool_timeout_seconds,
            )
            logger.info(
                "Worker 工具执行完成",
                extra={"trace_id": trace_id, "tool_name": tool_name, "duration_ms": round((time.perf_counter() - started) * 1000, 2)},
            )
            return {"message": f"{tool_name} 执行完成", "payload": payload, "warnings": payload.get("warnings", [])}
        except (ValueError, FileNotFoundError) as exc:
            logger.warning(
                "Worker 工具请求无效",
                extra={"trace_id": trace_id, "tool_name": tool_name, "duration_ms": round((time.perf_counter() - started) * 1000, 2), "detail": str(exc)},
            )
            raise HTTPException(400, str(exc)) from exc
        except TimeoutError as exc:
            logger.warning(
                "Worker 工具执行超时",
                extra={"trace_id": trace_id, "tool_name": tool_name, "duration_ms": round((time.perf_counter() - started) * 1000, 2)},
            )
            raise HTTPException(504, "Worker 工具执行超时") from exc
        except Exception as exc:
            logger.exception(
                "Worker 工具执行失败",
                extra={"trace_id": trace_id, "tool_name": tool_name, "duration_ms": round((time.perf_counter() - started) * 1000, 2)},
            )
            raise HTTPException(500, "Worker 工具执行失败，请查看 Worker 日志") from exc

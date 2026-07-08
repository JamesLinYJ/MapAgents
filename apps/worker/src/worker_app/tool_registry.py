# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker Tool Registry
#
#   文件:       tool_registry.py
#
#   日期:       2026年07月07日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

"""装饰器式工具注册表。

Worker 工具的内部 API 契约由 Pydantic request/response model 生成，
catalog 暴露模型 JSON Schema 与 hash。Node 端只消费 catalog，不维护
另一份手写 Worker schema。
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Callable

from pydantic import BaseModel

from worker_app.tool_contracts import WorkerPayload


@dataclass(frozen=True)
class WorkerToolEntry:
    name: str
    fn: Callable[[dict[str, Any]], dict[str, Any]]
    request_model: type[BaseModel]
    response_model: type[BaseModel]
    read_only: bool
    destructive: bool
    timeout_seconds: int
    display_surfaces: tuple[str, ...]
    value_ref_outputs: tuple[str, ...]


_worker_tools: dict[str, WorkerToolEntry] = {}


def worker_tool(
    name: str,
    *,
    request_model: type[BaseModel],
    response_model: type[BaseModel] = WorkerPayload,
    read_only: bool = True,
    destructive: bool = False,
    timeout_seconds: int = 300,
    display_surfaces: tuple[str, ...] = (),
    value_ref_outputs: tuple[str, ...] = (),
):
    """将函数注册为 Worker 工具。重复注册或缺模型直接抛错。"""

    def decorator(fn: Callable[[dict[str, Any]], dict[str, Any]]):
        if name in _worker_tools:
            raise ValueError(f"工具 '{name}' 重复注册——每个工具名只能注册一次")
        _worker_tools[name] = WorkerToolEntry(
            name=name,
            fn=fn,
            request_model=request_model,
            response_model=response_model,
            read_only=read_only,
            destructive=destructive,
            timeout_seconds=timeout_seconds,
            display_surfaces=display_surfaces,
            value_ref_outputs=value_ref_outputs,
        )
        return fn

    return decorator


def dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """按名称分发工具调用。未知工具或 schema 失败都硬失败。"""

    entry = _worker_tools.get(name)
    if entry is None:
        raise ValueError(f"未知科学计算工具：{name}")
    request = entry.request_model.model_validate(args)
    payload = entry.fn(request.model_dump(exclude_none=True))
    entry.response_model.model_validate(payload)
    return payload


def list_tools() -> list[str]:
    """返回所有已注册工具名称。"""

    return sorted(_worker_tools.keys())


def tool_catalog() -> dict[str, Any]:
    """返回带 Pydantic JSON Schema 和 hash 的 Worker catalog。"""

    specs = []
    for name in list_tools():
        entry = _worker_tools[name]
        contract = _entry_contract(entry)
        specs.append({
            "toolName": name,
            "route": f"/tools/{name}",
            "contract": contract,
            "schemaHash": _contract_hash(contract),
        })
    return {"tools": specs, "count": len(specs)}


def _entry_contract(entry: WorkerToolEntry) -> dict[str, Any]:
    return {
        "providerId": "geo-platform-meteorology-worker",
        "toolName": entry.name,
        "version": "0.1.0",
        "parametersSchema": entry.request_model.model_json_schema(),
        "resultSchema": entry.response_model.model_json_schema(),
        "valueRefInputs": [],
        "valueRefOutputs": list(entry.value_ref_outputs),
        "readOnly": entry.read_only,
        "destructive": entry.destructive,
        "timeoutSeconds": entry.timeout_seconds,
        "displaySurfaces": list(entry.display_surfaces),
    }


def _contract_hash(contract: dict[str, Any]) -> str:
    encoded = json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()

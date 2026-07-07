# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker Tool Registry
#
#   文件:       tool_registry.py
#
#   日期:       2026年07月07日
#   作者:       Claude Code
# --------------------------------------------------------------------------

"""装饰器式工具注册表，替代 execute_meteorology_tool 中的 if/elif 链。

每个科学计算工具通过 @worker_tool(name) 装饰器注册，自动暴露到
/tools/catalog 和 /tools/{tool_name} 端点。
"""

from __future__ import annotations

from typing import Any, Callable

_worker_tools: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}


def worker_tool(name: str):
    """将函数注册为 Worker 工具。重复注册抛出 ValueError。"""
    def decorator(fn: Callable[[dict[str, Any]], dict[str, Any]]):
        if name in _worker_tools:
            raise ValueError(f"工具 '{name}' 重复注册——每个工具名只能注册一次")
        _worker_tools[name] = fn
        return fn
    return decorator


def dispatch(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """按名称分发工具调用。未知工具抛出 ValueError。"""
    tool = _worker_tools.get(name)
    if tool is None:
        raise ValueError(f"未知科学计算工具：{name}")
    return tool(args)


def list_tools() -> list[str]:
    """返回所有已注册工具名称。"""
    return sorted(_worker_tools.keys())

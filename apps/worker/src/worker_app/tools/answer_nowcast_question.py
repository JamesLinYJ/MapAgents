"""短临事实问答草稿工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import required_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], _context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology import NowcastTextService

    analysis = args.get("analysis")
    if not isinstance(analysis, dict):
        raise ValueError("analysis 必须是对象")
    return NowcastTextService().build_draft_answer(
        facts=analysis,
        question=required_text(args, "question"),
    )


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "answer_nowcast_question",
        execute,
        request_model=contracts.AnswerNowcastQuestionRequest,
        value_ref_outputs=("nowcast_answer",),
    )

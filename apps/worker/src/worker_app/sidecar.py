# +-------------------------------------------------------------------------
#
#   地理智能平台 - Python 科学计算 Worker
#
#   文件:       sidecar.py
#
#   日期:       2026年06月08日
#   作者:       JamesLinYJ
# --------------------------------------------------------------------------

"""只承载 gis_meteorology 科学计算，不保存平台业务状态。"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from worker_app import tool_contracts as contracts
from worker_app.bootstrap import configure_science_package_path
from worker_app.logging import configure_logging
from worker_app.nowcast_bridge import (
    create_nowcast_sequence,
    nowcast_sequence_from_reference,
    serialize_nowcast_sequence,
)
from worker_app.path_sandbox import WorkerPathSandbox, referenced_filename, sequence_items
from worker_app.request_args import (
    optional_dict,
    optional_float,
    optional_int,
    optional_list_of_dicts,
    optional_number_list,
    optional_text,
    required_float,
    required_text,
)
from worker_app.routes import register_system_routes
from worker_app.tool_registry import worker_tool
from worker_app.tool_routes import register_tool_routes
from worker_app.worker_auth import WorkerAuthConfig, WorkerAuthVerifier

# 各工具模块 import 时通过 @worker_tool 自动注册。
# 新增工具只需在此添加一行 import + 一个独立模块文件。
import worker_app.tools.meteorological_inspect  # noqa: F401

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


configure_logging()
logger = logging.getLogger("worker")


# 宿主机开发直接从仓库源码启动 worker；生产镜像仍可使用已安装包。
REPOSITORY_ROOT = configure_science_package_path(Path(__file__))

app = FastAPI(title="geo-agent-science-worker", version="0.2.0")
RUNTIME_ROOT = Path(os.environ.get("RUNTIME_ROOT", "runtime")).resolve()
PATH_SANDBOX = WorkerPathSandbox(RUNTIME_ROOT)
WORKER_SHARED_SECRET = os.environ.get("WORKER_SHARED_SECRET")
WORKER_MAX_BODY_BYTES = int(os.environ.get("WORKER_MAX_BODY_BYTES", str(16 * 1024 * 1024)))
WORKER_MAX_CONCURRENCY = int(os.environ.get("WORKER_MAX_CONCURRENCY", "2"))
WORKER_CLOCK_SKEW_SECONDS = int(os.environ.get("WORKER_CLOCK_SKEW_SECONDS", "30"))
WORKER_TOOL_TIMEOUT_SECONDS = float(os.environ.get("WORKER_TOOL_TIMEOUT_SECONDS", "300"))
WORKER_NONCE_CACHE_MAX = max(1, int(os.environ.get("WORKER_NONCE_CACHE_MAX", "10000")))
_worker_semaphore = asyncio.Semaphore(WORKER_MAX_CONCURRENCY)
_worker_auth = WorkerAuthVerifier(WorkerAuthConfig(
    shared_secret=WORKER_SHARED_SECRET,
    clock_skew_seconds=WORKER_CLOCK_SKEW_SECONDS,
    nonce_cache_max=WORKER_NONCE_CACHE_MAX,
))
register_system_routes(
    app,
    worker_shared_secret=WORKER_SHARED_SECRET,
    worker_auth=_worker_auth,
    nonce_cache_max=WORKER_NONCE_CACHE_MAX,
)
register_tool_routes(app, tool_timeout_seconds=WORKER_TOOL_TIMEOUT_SECONDS, logger=logger)


@app.middleware("http")
async def require_worker_secret(request: Request, call_next):
    """工具接口必须由 Node API 携带短期签名调用；health 只暴露依赖状态。"""

    trace_id = request.headers.get("x-geoforge-trace-id") or uuid4().hex[:12]
    request.state.trace_id = trace_id
    if request.url.path == "/health":
        return await call_next(request)
    # Content-Length 预检：在完整读取 body 前先拒绝明显超大的请求
    content_length = request.headers.get("content-length")
    if content_length is not None and int(content_length) > WORKER_MAX_BODY_BYTES:
        logger.warning(
            "Worker 请求体超过大小限制",
            extra={"trace_id": trace_id, "content_length": int(content_length), "limit": WORKER_MAX_BODY_BYTES},
        )
        return JSONResponse({"detail": "Worker 请求体超过大小限制"}, status_code=413)
    body = await request.body()
    if len(body) > WORKER_MAX_BODY_BYTES:
        logger.warning(
            "Worker 请求体超过大小限制",
            extra={"trace_id": trace_id, "actual": len(body), "limit": WORKER_MAX_BODY_BYTES},
        )
        return JSONResponse({"detail": "Worker 请求体超过大小限制"}, status_code=413)
    authorization = request.headers.get("authorization") or ""
    tool_name = _tool_name_from_path(request.url.path)
    auth_error = _worker_auth.verify(authorization, tool_name, body)
    if auth_error is not None:
        status_code, detail = auth_error
        logger.warning(
            "Worker 认证失败",
            extra={"trace_id": trace_id, "tool_name": tool_name, "status": status_code, "detail": detail},
        )
        return JSONResponse({"detail": detail}, status_code=status_code)
    await _replay_body(request, body)
    async with _worker_semaphore:
        return await call_next(request)


async def _replay_body(request: Request, body: bytes) -> None:
    """中间件验签必须读取 body；重放缓存体让 FastAPI 后续继续解析同一请求。"""

    sent = False

    async def receive() -> dict[str, Any]:
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    request._receive = receive  # type: ignore[attr-defined]


def _tool_name_from_path(path: str) -> str:
    parts = path.strip("/").split("/")
    if len(parts) >= 2 and parts[-2] == "tools":
        return parts[-1]
    return ""


@worker_tool("meteorological_render", request_model=contracts.MeteorologicalRenderRequest, display_surfaces=("map", "download"), value_ref_outputs=("meteorological_render_result",))
@worker_tool("render_nowcast_raster", request_model=contracts.MeteorologicalRenderRequest, display_surfaces=("map", "download"), value_ref_outputs=("render_nowcast_raster_result",))
def _meteorological_render(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService
    source = input_path(args)
    filename = input_filename(args, source)
    output = output_path(args)
    result = MeteorologicalDataService().render_heatmap(
        source, output_path=output, filename=filename,
        variable=optional_text(args, "variable"), time_index=optional_int(args, "time_index"),
        level_index=optional_int(args, "level_index"), bbox=optional_number_list(args, "bbox"),
    )
    return {**result, "outputRelativePath": relative_runtime_path(output)}


@worker_tool("meteorological_stats", request_model=contracts.MeteorologicalStatsRequest, value_ref_outputs=("meteorological_threshold", "meteorological_contour_levels"))
def _meteorological_stats(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService
    return MeteorologicalDataService().stats(
        input_path(args), filename=input_filename(args),
        variable=optional_text(args, "variable"), time_index=optional_int(args, "time_index"),
        level_index=optional_int(args, "level_index"), bbox=optional_number_list(args, "bbox"),
    )


@worker_tool("meteorological_threshold", request_model=contracts.MeteorologicalThresholdRequest, display_surfaces=("map", "download"), value_ref_outputs=("meteorological_threshold_result",))
def _meteorological_threshold(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService
    return MeteorologicalDataService().threshold_geojson(
        input_path(args), threshold=required_float(args, "threshold"),
        operator=optional_text(args, "operator") or ">=", filename=input_filename(args),
        variable=optional_text(args, "variable"), time_index=optional_int(args, "time_index"),
        level_index=optional_int(args, "level_index"), bbox=optional_number_list(args, "bbox"),
    )


@worker_tool("meteorological_contour", request_model=contracts.MeteorologicalContourRequest, display_surfaces=("map", "download"), value_ref_outputs=("meteorological_contour_result",))
def _meteorological_contour(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService
    return MeteorologicalDataService().contours_geojson(
        input_path(args), levels=optional_number_list(args, "levels"), filename=input_filename(args),
        variable=optional_text(args, "variable"), time_index=optional_int(args, "time_index"),
        level_index=optional_int(args, "level_index"), bbox=optional_number_list(args, "bbox"),
    )


@worker_tool("meteorological_report", request_model=contracts.MeteorologicalReportRequest, read_only=False, display_surfaces=("download",))
def _meteorological_report(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService
    source = input_path(args)
    output = output_path(args)
    result = MeteorologicalDataService().generate_report_docx(
        source, output_path=output, filename=input_filename(args, source),
        llm_interpretation=required_text(args, "interpretation_text"),
    )
    return {**result, "outputRelativePath": relative_runtime_path(output)}


@worker_tool("create_nowcast_sequence", request_model=contracts.CreateNowcastSequenceRequest, value_ref_outputs=("nowcast_sequence",))
def _create_nowcast_sequence(args: dict[str, Any]) -> dict[str, Any]:
    return serialize_nowcast_sequence(create_nowcast_sequence(args, PATH_SANDBOX), PATH_SANDBOX)


@worker_tool("inspect_nowcast_sequence", request_model=contracts.InspectNowcastSequenceRequest, value_ref_outputs=("nowcast_sequence_inspection",))
def _inspect_nowcast_sequence(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology import NowcastSequenceService
    return NowcastSequenceService().inspect_sequence(nowcast_sequence_from_reference(args, PATH_SANDBOX))


@worker_tool("meteorological_precipitation_nowcast", request_model=contracts.MeteorologicalPrecipitationNowcastRequest, value_ref_outputs=("nowcast_analysis", "nowcast_map_candidate"))
def _meteorological_precipitation_nowcast(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology import NowcastAnalysisService
    sequence = nowcast_sequence_from_reference(args, PATH_SANDBOX, variable_override=optional_text(args, "variable"))
    analysis = NowcastAnalysisService().analyze(
        sequence, area=optional_dict(args, "area"), bbox=optional_number_list(args, "bbox"),
        coordinate=optional_dict(args, "coordinate"),
        point_buffer_meters=optional_float(args, "point_buffer_meters") or 1000,
        district_name_field=optional_text(args, "district_name_field"),
    )
    relative_paths = {item.dataset_id: relative_runtime_path(item.path) for item in sequence.datasets}
    analysis["mapCandidates"] = [
        {**candidate, "relativePath": relative_paths.get(str(candidate.get("datasetId") or ""))}
        for candidate in analysis.get("mapCandidates", [])
    ]
    return analysis


@worker_tool("answer_nowcast_question", request_model=contracts.AnswerNowcastQuestionRequest, value_ref_outputs=("nowcast_answer",))
def _answer_nowcast_question(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology import NowcastTextService
    analysis = args.get("analysis")
    if not isinstance(analysis, dict): raise ValueError("analysis 必须是对象")
    return NowcastTextService().build_draft_answer(facts=analysis, question=required_text(args, "question"))


@worker_tool("generate_nowcast_forecast_text", request_model=contracts.GenerateNowcastForecastTextRequest, value_ref_outputs=("nowcast_forecast_text",))
def _generate_nowcast_forecast_text(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology import NowcastTextService
    analysis = args.get("analysis")
    if not isinstance(analysis, dict): raise ValueError("analysis 必须是对象")
    return NowcastTextService().build_draft_answer(facts=analysis, question="生成正式短时临近预报（短临）预报文字")


@worker_tool("inspect_radar_station_collection", request_model=contracts.RadarStationCollectionRequest, value_ref_outputs=("radar_station_collection", "radar_target_time"))
def _inspect_radar_station_collection(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import inspect_radar_station_collection
    with radar_semantic_input_paths(args, "files") as paths:
        return inspect_radar_station_collection(paths)


@worker_tool("recommend_radar_mosaic_strategy", request_model=contracts.RecommendRadarMosaicStrategyRequest, value_ref_outputs=("radar_mosaic_strategy",))
def _recommend_radar_mosaic_strategy(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import recommend_radar_mosaic_strategy
    return recommend_radar_mosaic_strategy(
        goal_mode=optional_text(args, "goal_mode") or "quicklook",
        time_strategy=optional_text(args, "time_strategy") or "nearest",
    )


@worker_tool("render_radar_mosaic", request_model=contracts.RenderRadarMosaicRequest, display_surfaces=("map", "mini_app", "download"), value_ref_outputs=("radar_mosaic_result",))
def _render_radar_mosaic(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import render_radar_mosaic
    output_png = output_path(args, key="output_png_relative_path")
    output_npz = output_path(args, key="output_npz_relative_path")
    output_map_png = output_path(args, key="output_map_png_relative_path") if optional_text(args, "output_map_png_relative_path") else None
    with radar_semantic_input_paths(args, "files") as paths:
        result = render_radar_mosaic(
            paths=paths, output_png=output_png, output_npz=output_npz, output_map_png=output_map_png,
            target_time=required_text(args, "target_time"), tolerance_sec=optional_int(args, "tolerance_sec") or 300,
            strategy=optional_text(args, "strategy") or "max", product=optional_text(args, "product") or "reflectivity",
            level_index=optional_int(args, "level_index") or 0, grid_res_km=optional_float(args, "grid_res_km") or 1.0,
            min_dbz=optional_float(args, "min_dbz") or 5.0,
        )
    out: dict[str, Any] = {**result, "outputPngRelativePath": relative_runtime_path(output_png), "outputNpzRelativePath": relative_runtime_path(output_npz)}
    if output_map_png is not None: out["outputMapPngRelativePath"] = relative_runtime_path(output_map_png)
    return out


@worker_tool("compare_radar_mosaic_reference", request_model=contracts.CompareRadarMosaicReferenceRequest, display_surfaces=("mini_app", "download"), value_ref_outputs=("radar_reference_comparison",))
def _compare_radar_mosaic_reference(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import compare_radar_mosaic_reference
    output_png = output_path(args, key="output_png_relative_path")
    output_ref_png = output_path(args, key="output_reference_png_relative_path")
    result = compare_radar_mosaic_reference(
        mosaic_npz=referenced_path({"relativePath": required_text(args, "mosaic_npz_relative_path")}),
        reference_paths=referenced_paths(args, "reference_files"),
        output_png=output_png, output_reference_png=output_ref_png,
        target_time=required_text(args, "target_time"), level_index=optional_int(args, "level_index") or 0,
        product_label=optional_text(args, "product_label") or "反射率",
        product_unit=optional_text(args, "product_unit") or "dBZ", min_display=optional_float(args, "min_display") or 10.0,
    )
    return {**result, "outputPngRelativePath": relative_runtime_path(output_png), "outputReferencePngRelativePath": relative_runtime_path(output_ref_png)}


@worker_tool("render_rainfall_risk_map", request_model=contracts.RenderRainfallRiskMapRequest, display_surfaces=("map", "mini_app", "download"), value_ref_outputs=("rainfall_risk_map_result",))
def _render_rainfall_risk_map(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.third_party.rainfall_risk_map.adapter import render_rainfall_risk_map
    output = output_path(args)
    output_geojson = output_path(args, key="output_geojson_relative_path") if optional_text(args, "output_geojson_relative_path") else None
    result = render_rainfall_risk_map(
        nc_path=input_path(args), output_png=output, output_geojson=output_geojson,
        variable=required_text(args, "variable"), boundary_path=optional_referenced_path(args, "boundary_relative_path"),
        thresholds=optional_list_of_dicts(args, "thresholds"), map_mode=optional_text(args, "map_mode") or "regional",
        aggregation=optional_text(args, "aggregation") or "mean", label_field=optional_text(args, "label_field"),
        title=optional_text(args, "title"),
    )
    out = {**result, "outputRelativePath": relative_runtime_path(output)}
    if output_geojson is not None: out["outputGeojsonRelativePath"] = relative_runtime_path(output_geojson)
    return out


@worker_tool("generate_area_rainfall_table", request_model=contracts.GenerateAreaRainfallTableRequest, display_surfaces=("mini_app", "download"), value_ref_outputs=("area_rainfall_table_result",))
def _generate_area_rainfall_table(args: dict[str, Any]) -> dict[str, Any]:
    from gis_meteorology.third_party.short_term_forecast.adapter import generate_area_rainfall_table
    file_items = sequence_items(args)
    nc_paths = [referenced_path(item) for item in file_items]
    nc_names = [referenced_filename(item, source) for item, source in zip(file_items, nc_paths)]
    output_xlsx = output_path(args, key="output_xlsx_relative_path")
    output_png = output_path(args, key="output_png_relative_path")
    result = generate_area_rainfall_table(
        nc_paths=nc_paths, nc_names=nc_names,
        boundary_path=referenced_path({"relativePath": required_text(args, "boundary_relative_path")}),
        output_xlsx=output_xlsx, output_png=output_png, top_n=optional_int(args, "top_n") or 10,
        label_field=optional_text(args, "label_field"), style=optional_dict(args, "style"),
    )
    return {**result, "outputXlsxRelativePath": relative_runtime_path(output_xlsx), "outputPngRelativePath": relative_runtime_path(output_png)}


def input_path(args: dict[str, Any]) -> Path:
    return PATH_SANDBOX.input_path(args)


def input_filename(args: dict[str, Any], source: Path | None = None) -> str | None:
    for key in ("filename", "file_name", "name"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return Path(value.strip()).name
    return source.name if source is not None else None


def output_path(args: dict[str, Any], *, key: str = "output_relative_path") -> Path:
    return PATH_SANDBOX.output_path(args, key=key)


def optional_referenced_path(args: dict[str, Any], key: str) -> Path | None:
    return PATH_SANDBOX.optional_referenced_path(args, key)


def referenced_paths(args: dict[str, Any], key: str) -> list[Path]:
    return PATH_SANDBOX.referenced_paths(args, key)


def referenced_path(value: dict[str, Any]) -> Path:
    return PATH_SANDBOX.referenced_path(value)


def radar_semantic_input_paths(args: dict[str, Any], key: str):
    return PATH_SANDBOX.radar_semantic_input_paths(args, key)


def relative_runtime_path(value: Path) -> str:
    return PATH_SANDBOX.relative_runtime_path(value)

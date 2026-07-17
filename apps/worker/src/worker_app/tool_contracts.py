# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具 Pydantic 契约
#
#   文件:       tool_contracts.py
#
#   日期:       2026年07月07日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

"""Worker 内部 API 的 Pydantic 请求/响应模型。

这些模型是 Python Worker 接收 Node 调用的事实源。/tools/catalog 从
model_json_schema() 生成 JSON Schema，Node 启动和调用时消费该 catalog
做出站参数校验，避免 TS/Python 靠手写 JSON 或注释同步。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictWorkerRequest(BaseModel):
    """Worker 请求模型默认拒绝未声明的顶层字段。"""

    model_config = ConfigDict(extra="forbid")


class WorkerPayload(BaseModel):
    """Worker payload 至少必须是对象，领域字段由具体工具自行定义。"""

    model_config = ConfigDict(extra="allow")


class FileReference(BaseModel):
    """Node 传给 Worker 的 runtime 文件引用。"""

    model_config = ConfigDict(extra="allow")

    relativePath: str = Field(..., min_length=1)
    name: str | None = None
    filename: str | None = None
    fileId: str | None = None
    datasetId: str | None = None
    sourceRelativePath: str | None = None


class SequenceReference(BaseModel):
    """短时临近预报序列引用。"""

    model_config = ConfigDict(extra="allow")

    datasets: list[FileReference] = Field(..., min_length=1)
    variable: str | None = None


class MeteorologicalInspectRequest(StrictWorkerRequest):
    file_relative_path: str = Field(..., min_length=1)
    file_name: str | None = Field(None, min_length=1)
    filename: str | None = Field(None, min_length=1)


class MeteorologicalRenderRequest(StrictWorkerRequest):
    file_relative_path: str = Field(..., min_length=1)
    file_name: str | None = Field(None, min_length=1)
    filename: str | None = Field(None, min_length=1)
    variable: str | None = Field(None, min_length=1)
    time_index: int | None = None
    level_index: int | None = None
    bbox: list[float] | None = Field(None, min_length=4, max_length=4)
    output_relative_path: str = Field(..., min_length=1)
    output_cog_relative_path: str = Field(..., min_length=1)


class MeteorologicalStatsRequest(StrictWorkerRequest):
    file_relative_path: str = Field(..., min_length=1)
    file_name: str | None = Field(None, min_length=1)
    filename: str | None = Field(None, min_length=1)
    variable: str | None = Field(None, min_length=1)
    time_index: int | None = None
    level_index: int | None = None
    bbox: list[float] | None = Field(None, min_length=4, max_length=4)


class MeteorologicalThresholdRequest(MeteorologicalStatsRequest):
    threshold: float
    operator: Literal[">", ">=", "<", "<=", "=="] | None = None


class MeteorologicalContourRequest(MeteorologicalStatsRequest):
    levels: list[float] | None = Field(None, min_length=1)


class MeteorologicalReportRequest(StrictWorkerRequest):
    file_relative_path: str = Field(..., min_length=1)
    file_name: str | None = Field(None, min_length=1)
    filename: str | None = Field(None, min_length=1)
    interpretation_text: str = Field(..., min_length=1)
    output_relative_path: str = Field(..., min_length=1)


class CreateNowcastSequenceRequest(StrictWorkerRequest):
    files: list[FileReference] = Field(..., min_length=1)
    variable: str | None = Field(None, min_length=1)


class InspectNowcastSequenceRequest(StrictWorkerRequest):
    sequence: SequenceReference


class MeteorologicalPrecipitationNowcastRequest(StrictWorkerRequest):
    sequence: SequenceReference
    variable: str | None = Field(None, min_length=1)
    area: dict[str, Any] | None = None
    coordinate: dict[str, Any] | None = None
    bbox: list[float] | None = Field(None, min_length=4, max_length=4)
    point_buffer_meters: float | None = Field(None, gt=0)
    district_name_field: str | None = Field(None, min_length=1)


class AnswerNowcastQuestionRequest(StrictWorkerRequest):
    analysis: dict[str, Any]
    question: str = Field(..., min_length=1)


class GenerateNowcastForecastTextRequest(StrictWorkerRequest):
    analysis: dict[str, Any]


class RadarStationCollectionRequest(StrictWorkerRequest):
    files: list[FileReference] = Field(..., min_length=1)


class RecommendRadarMosaicStrategyRequest(StrictWorkerRequest):
    goal_mode: Literal["quicklook", "quality", "smooth"] | None = None
    time_strategy: Literal["nearest", "wide"] | None = None


class RenderRadarMosaicRequest(StrictWorkerRequest):
    files: list[FileReference] = Field(..., min_length=1)
    target_time: str = Field(..., min_length=1)
    strategy: str = Field(..., min_length=1)
    product: str | None = Field(None, min_length=1)
    level_index: int | None = None
    tolerance_sec: int | None = Field(None, ge=0)
    grid_res_km: float | None = Field(None, gt=0)
    min_dbz: float | None = None
    output_png_relative_path: str = Field(..., min_length=1)
    output_map_png_relative_path: str | None = Field(None, min_length=1)
    output_npz_relative_path: str = Field(..., min_length=1)


class CompareRadarMosaicReferenceRequest(StrictWorkerRequest):
    mosaic_npz_relative_path: str = Field(..., min_length=1)
    reference_files: list[FileReference] = Field(..., min_length=1)
    target_time: str = Field(..., min_length=1)
    level_index: int | None = None
    product_label: str | None = Field(None, min_length=1)
    product_unit: str | None = Field(None, min_length=1)
    min_display: float | None = None
    output_png_relative_path: str = Field(..., min_length=1)
    output_reference_png_relative_path: str = Field(..., min_length=1)


class RainfallThreshold(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(..., min_length=1)
    min: float
    max: float
    color: str = Field(..., pattern=r"^#[0-9a-fA-F]{6}$")


class RenderRainfallRiskMapRequest(StrictWorkerRequest):
    file_relative_path: str = Field(..., min_length=1)
    file_name: str | None = Field(None, min_length=1)
    filename: str | None = Field(None, min_length=1)
    variable: str = Field(..., min_length=1)
    boundary_relative_path: str = Field(..., min_length=1)
    thresholds: list[RainfallThreshold] | None = None
    map_mode: Literal["regional", "gradient", "compare"] | None = None
    aggregation: Literal["mean", "max", "sum"] | None = None
    label_field: str | None = Field(None, min_length=1)
    title: str | None = Field(None, min_length=1)
    output_relative_path: str = Field(..., min_length=1)
    output_geojson_relative_path: str | None = Field(None, min_length=1)


class GenerateAreaRainfallTableRequest(StrictWorkerRequest):
    files: list[FileReference] = Field(..., min_length=1)
    boundary_relative_path: str = Field(..., min_length=1)
    top_n: int | None = Field(None, ge=1)
    label_field: str | None = Field(None, min_length=1)
    style: dict[str, Any] | None = None
    output_xlsx_relative_path: str = Field(..., min_length=1)
    output_png_relative_path: str = Field(..., min_length=1)

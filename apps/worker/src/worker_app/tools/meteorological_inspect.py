# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据检查工具
#
#   文件:       meteorological_inspect.py
#
#   日期:       2026年07月07日
#   作者:       Claude Code
# --------------------------------------------------------------------------

"""独立 Worker 工具模块——含 Pydantic request/response model + 单元测试入口。

每个 @worker_tool 对应一个模块，sidecar.py 通过 import 自动注册。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from worker_app.tool_registry import worker_tool


class InspectRequest(BaseModel):
    """meteorological_inspect 请求参数。"""
    file_relative_path: str = Field(..., min_length=1, description="runtime 根目录内的相对文件路径")
    filename: str | None = Field(None, description="文件名提示，未提供时从 file_relative_path 推断")


@worker_tool("meteorological_inspect")
def meteorological_inspect(args: dict[str, Any]) -> dict[str, Any]:
    """检查 NetCDF/GRIB/GeoTIFF 数据集元数据。"""
    from pathlib import Path
    from gis_meteorology.service import MeteorologicalDataService
    from worker_app.sidecar import resolve_runtime_path

    request = InspectRequest.model_validate(args)
    source = resolve_runtime_path(request.file_relative_path, must_exist=True)
    filename = request.filename or Path(request.file_relative_path).name

    return MeteorologicalDataService().inspect(source, filename=filename)

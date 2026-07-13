"""短临候选栅格渲染工具。"""

from worker_app import tool_contracts as contracts
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools.meteorological_render import execute


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "render_nowcast_raster",
        execute,
        request_model=contracts.MeteorologicalRenderRequest,
        display_surfaces=("map", "download"),
        value_ref_outputs=("render_nowcast_raster_result",),
    )

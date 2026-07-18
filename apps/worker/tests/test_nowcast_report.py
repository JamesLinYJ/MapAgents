# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临自动化报告测试
#
#   文件:       test_nowcast_report.py
#
#   日期:       2026年07月18日
#   作者:       OpenAI Codex
# --------------------------------------------------------------------------

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
GIS_SRC = REPO_ROOT / "packages" / "gis-meteorology" / "src"
for source in (WORKER_SRC, GIS_SRC):
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import register_builtin_tools


class NowcastReportTests(unittest.TestCase):
    def test_report_uses_persisted_timeline_and_computes_global_peak(self) -> None:
        registry = WorkerToolRegistry()
        register_builtin_tools(registry)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = registry.dispatch(
                "meteorological_nowcast_report",
                _request(),
                WorkerToolContext(WorkerPathSandbox(root)),
            )

            self.assertEqual(result["frameCount"], 2)
            self.assertEqual(result["globalMaxQpf"], 44.798179626464844)
            self.assertEqual(result["globalMaxValidTime"], "2026-04-09T22:25:00")
            report_path = root / "artifacts" / "run_1" / "report.docx"
            self.assertTrue(report_path.is_file())
            with ZipFile(report_path) as archive:
                settings = archive.read("word/settings.xml").decode("utf-8")
                document = archive.read("word/document.xml").decode("utf-8")
            self.assertIn('w:percent="100"', settings)
            self.assertIn("44.798 mm", document)
            self.assertIn("雨带向西北移动约", document)
            self.assertNotIn("雨带向向西北", document)


def _request() -> dict[str, object]:
    return {
        "automation_run_id": "automation_run_1",
        "automation_id": "meteorological_nowcast_monitor",
        "automation_revision": 1,
        "started_at": "2026-04-09T19:55:00+08:00",
        "completed_at": "2026-04-09T22:55:00+08:00",
        "answer": "未来三小时持续降雨。",
        "analysis": {
            "kind": "nowcast_precipitation_analysis",
            "scope": {"type": "full_extent", "label": "产品覆盖范围"},
            "regions": [{
                "label": "产品覆盖范围",
                "regionId": "full",
                "timeline": [
                    _frame(0, 5, "2026-04-09T20:00:00", 34.53546142578125),
                    _frame(29, 150, "2026-04-09T22:25:00", 44.798179626464844),
                ],
                "diagnosis": {
                    "trend": "continuous",
                    "hasRain": True,
                    "peakP90": 5.2869,
                    "summary": "持续降雨",
                    "peakLevel": "moderate",
                    "endLeadMinutes": None,
                    "peakLeadMinutes": 150,
                    "onsetLeadMinutes": 5,
                },
            }],
            "movement": {
                "available": True,
                "direction": "西北",
                "distanceKm": 87.89,
                "from": {"lat": 29.07, "lng": 120.94, "sequenceIndex": 0},
                "to": {"lat": 29.09, "lng": 120.03, "sequenceIndex": 29},
            },
            "variable": "QPF",
            "warnings": ["按产品完整覆盖范围分析。"],
            "sequenceId": "sequence_1",
            "mapCandidates": [],
        },
        "artifacts": [{
            "artifactId": "artifact_map",
            "artifactType": "raster_cog",
            "name": "短临地图",
            "uri": "/api/v1/results/artifact_map/file",
        }],
        "output_relative_path": "artifacts/run_1/report.docx",
    }


def _frame(index: int, lead: int, valid_time: str, maximum: float) -> dict[str, object]:
    return {
        "stats": {
            "min": 0,
            "max": maximum,
            "mean": 0.4,
            "median": 0.9,
            "p90": 5.2,
            "count": 451401,
            "rainCoverage": 0.19,
        },
        "filename": f"frame_{index}.nc",
        "datasetId": f"file_{index}",
        "rainLevel": "moderate",
        "validTime": valid_time,
        "leadMinutes": lead,
        "sequenceIndex": index,
    }


if __name__ == "__main__":
    unittest.main()

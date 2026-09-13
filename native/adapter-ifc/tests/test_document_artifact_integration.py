from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("ifcopenshell")

ROOT = Path(__file__).resolve().parents[3]
ADAPTER = ROOT / "native" / "adapter-ifc" / "tools" / "extract_federation_scene_ir.py"
FIXTURE = ROOT / "fixtures" / "ifc" / "explicit-edge-wall.ifc"


def run_adapter(
    output_directory: Path,
    architecture: Path,
    structure: Path,
    cache_directory: Path | None,
    stage_timing: Path | None = None,
) -> dict[str, object]:
    output_directory.mkdir(parents=True)
    command = [
        sys.executable,
        str(ADAPTER),
        "--document",
        f"architecture={architecture}",
        "--uri-hint",
        "architecture=models/architecture.ifc",
        "--document",
        f"structure={structure}",
        "--uri-hint",
        "structure=models/structure.ifc",
        "--scene",
        str(output_directory / "scene.json"),
        "--geometry",
        str(output_directory / "geometry.bin"),
        "--properties",
        str(output_directory / "properties.bin"),
        "--report",
        str(output_directory / "report.json"),
        "--threads",
        "1",
    ]
    if cache_directory is not None:
        command.extend(["--document-cache", str(cache_directory)])
    if stage_timing is not None:
        command.extend(["--stage-timing", str(stage_timing)])
    subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads((output_directory / "report.json").read_text("utf-8"))


def assert_scene_bytes_equal(left: Path, right: Path) -> None:
    for filename in ["scene.json", "geometry.bin", "properties.bin"]:
        assert (left / filename).read_bytes() == (right / filename).read_bytes()


def test_reuses_unchanged_documents_and_matches_clean_federation(tmp_path: Path) -> None:
    architecture = tmp_path / "architecture.ifc"
    structure = tmp_path / "structure.ifc"
    architecture.write_bytes(FIXTURE.read_bytes())
    structure.write_bytes(FIXTURE.read_bytes())
    cache_directory = tmp_path / "document-cache"

    clean = tmp_path / "clean"
    cold = tmp_path / "cold"
    warm = tmp_path / "warm"
    clean_report = run_adapter(clean, architecture, structure, None)
    cold_report = run_adapter(cold, architecture, structure, cache_directory)
    warm_report = run_adapter(warm, architecture, structure, cache_directory)

    assert clean_report["documentArtifactCache"] == {
        "schemaVersion": "naru.ifc-document-artifact.3",
        "status": "disabled",
        "hits": [],
        "misses": [],
    }
    assert cold_report["documentArtifactCache"]["hits"] == []
    assert cold_report["documentArtifactCache"]["misses"] == [
        "architecture",
        "structure",
    ]
    assert warm_report["documentArtifactCache"]["hits"] == [
        "architecture",
        "structure",
    ]
    assert warm_report["documentArtifactCache"]["misses"] == []
    assert_scene_bytes_equal(clean, cold)
    assert_scene_bytes_equal(clean, warm)

    structure.write_text(
        structure.read_text("utf-8").replace(
            "Edge Proof Wall",
            "Changed Edge Proof Wall",
        ),
        encoding="utf-8",
        newline="\n",
    )
    changed_incremental = tmp_path / "changed-incremental"
    changed_clean = tmp_path / "changed-clean"
    changed_report = run_adapter(
        changed_incremental,
        architecture,
        structure,
        cache_directory,
    )
    run_adapter(changed_clean, architecture, structure, None)

    assert changed_report["documentArtifactCache"]["hits"] == ["architecture"]
    assert changed_report["documentArtifactCache"]["misses"] == ["structure"]
    assert_scene_bytes_equal(changed_incremental, changed_clean)


def test_stage_timing_ledger_is_separate_and_leaves_the_output_bytes_unchanged(
    tmp_path: Path,
) -> None:
    architecture = tmp_path / "architecture.ifc"
    structure = tmp_path / "structure.ifc"
    architecture.write_bytes(FIXTURE.read_bytes())
    structure.write_bytes(FIXTURE.read_bytes())
    cache_directory = tmp_path / "document-cache"
    ledger_path = tmp_path / "timing" / "stage-timing.json"

    plain = tmp_path / "plain"
    cold = tmp_path / "cold"
    warm = tmp_path / "warm"
    plain_report = run_adapter(plain, architecture, structure, cache_directory)
    run_adapter(cold, architecture, structure, None, ledger_path)
    cold_ledger = json.loads(ledger_path.read_text("utf-8"))
    warm_report = run_adapter(warm, architecture, structure, cache_directory, ledger_path)
    warm_ledger = json.loads(ledger_path.read_text("utf-8"))

    assert_scene_bytes_equal(plain, cold)
    assert_scene_bytes_equal(plain, warm)
    # The document-artifact ledger legitimately differs (plain populated the
    # cache, warm restored from it); everything else must match byte for byte.
    assert {k: v for k, v in warm_report.items() if k != "documentArtifactCache"} == {
        k: v for k, v in plain_report.items() if k != "documentArtifactCache"
    }
    assert warm_report["documentArtifactCache"]["hits"] == ["architecture", "structure"]
    assert "stageTiming" not in json.dumps(warm_report)

    assert warm_ledger["schemaVersion"] == "naru.ifc-adapter-stage-timing.1"
    clock = warm_ledger["wallClock"]
    assert (
        clock["moduleStartedAtMs"]
        <= clock["importsFinishedAtMs"]
        <= clock["mainStartedAtMs"]
        <= clock["finishedAtMs"]
    )
    assert warm_ledger["importMilliseconds"] >= 0
    assert [entry["discipline"] for entry in warm_ledger["documents"]] == [
        "architecture",
        "structure",
    ]
    for entry in warm_ledger["documents"]:
        assert entry["outcome"] == "restored"
        assert entry["artifactState"] == "verified"
        assert entry["sourceBytes"] == len(FIXTURE.read_bytes())
        for stage in (
            "readMilliseconds",
            "artifactLoadMilliseconds",
            "artifactVerifyMilliseconds",
            "restoreMilliseconds",
        ):
            assert entry[stage] >= 0
        assert "extractMilliseconds" not in entry
    for entry in cold_ledger["documents"]:
        assert entry["outcome"] == "extracted"
        assert entry["extractMilliseconds"] >= 0
        assert "artifactState" not in entry
        assert "publishMilliseconds" not in entry
    assert set(warm_ledger["federation"]) == {
        "mergeMilliseconds",
        "propertyIndexMilliseconds",
    }
    assert set(warm_ledger["write"]) == {
        "geometryMilliseconds",
        "propertiesMilliseconds",
        "structureMilliseconds",
        "digestMilliseconds",
        "reportMilliseconds",
    }

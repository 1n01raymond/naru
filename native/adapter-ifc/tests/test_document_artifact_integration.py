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
        "schemaVersion": "naru.ifc-document-artifact.4",
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


def run_manifest(
    manifest_path: Path,
    documents: list[tuple[str, Path]],
    cache_directory: Path | None,
    stage_timing: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(ADAPTER)]
    for discipline, path in documents:
        command.extend(["--document", f"{discipline}={path}"])
        command.extend(["--uri-hint", f"{discipline}=models/{discipline}.ifc"])
    command.extend(
        ["--federation-manifest", str(manifest_path), "--threads", "1"],
    )
    if cache_directory is not None:
        command.extend(["--document-cache", str(cache_directory)])
    if stage_timing is not None:
        command.extend(["--stage-timing", str(stage_timing)])
    return subprocess.run(command, capture_output=True, text=True)


def read_manifest(
    manifest_path: Path,
    documents: list[tuple[str, Path]],
    cache_directory: Path | None,
    stage_timing: Path | None = None,
) -> dict[str, object]:
    completed = run_manifest(manifest_path, documents, cache_directory, stage_timing)
    assert completed.returncode == 0, completed.stderr
    return json.loads(manifest_path.read_text("utf-8"))


def test_federation_manifest_names_the_same_artifacts_the_monolithic_path_publishes(
    tmp_path: Path,
) -> None:
    source = FIXTURE.read_bytes()
    architecture = tmp_path / "architecture.ifc"
    architecture.write_bytes(source)
    structure = tmp_path / "structure.ifc"
    structure.write_bytes(source)
    # The manifest publishes the order a consumer must merge in, so the
    # documents are handed over in the reverse of that order on purpose.
    documents = [("structure", structure), ("architecture", architecture)]

    manifest_cache = tmp_path / "manifest-cache"
    cold = read_manifest(tmp_path / "cold.json", documents, manifest_cache)
    warm = read_manifest(tmp_path / "warm.json", documents, manifest_cache)

    assert cold["schemaVersion"] == "naru.ifc-federation-manifest.1"
    assert cold["artifactSchemaVersion"] == "naru.ifc-document-artifact.4"
    assert cold["federation"]["documentOrder"] == ["architecture", "structure"]
    assert [entry["discipline"] for entry in cold["documents"]] == [
        "architecture",
        "structure",
    ]
    assert cold["documentArtifactCache"] == {
        "schemaVersion": "naru.ifc-document-artifact.4",
        "status": "enabled",
        "hits": [],
        "misses": ["architecture", "structure"],
    }
    assert warm["documentArtifactCache"]["hits"] == ["architecture", "structure"]
    assert warm["documentArtifactCache"]["misses"] == []

    for entry, expected in zip(cold["documents"], warm["documents"], strict=True):
        assert set(entry) == {
            "discipline",
            "uriHint",
            "sourceDigest",
            "byteLength",
            "keyInput",
            "artifactKey",
            "artifactPayloadSha256",
            "outcome",
        }
        assert entry["byteLength"] == len(source)
        assert entry["uriHint"] == f"models/{entry['discipline']}.ifc"
        assert entry["keyInput"]["sourceDigest"] == entry["sourceDigest"]
        assert entry["outcome"] == "extracted"
        assert expected["outcome"] == "restored"
        # Naming a hit from the stored header and naming a miss from the header
        # just written have to agree, or a consumer could not trust either.
        assert expected["artifactKey"] == entry["artifactKey"]
        assert expected["artifactPayloadSha256"] == entry["artifactPayloadSha256"]
        assert expected["keyInput"] == entry["keyInput"]

    # Artifacts the monolithic path published are named by the manifest path,
    # which is what lets a consumer hydrate a federation the adapter extracted.
    shared_cache = tmp_path / "shared-cache"
    report = run_adapter(tmp_path / "monolithic", architecture, structure, shared_cache)
    shared = read_manifest(tmp_path / "shared.json", documents, shared_cache)
    assert shared["documentArtifactCache"]["hits"] == ["architecture", "structure"]
    assert [entry["artifactKey"] for entry in shared["documents"]] == [
        entry["artifactKey"] for entry in cold["documents"]
    ]
    assert [entry["artifactPayloadSha256"] for entry in shared["documents"]] == [
        entry["artifactPayloadSha256"] for entry in cold["documents"]
    ]
    assert shared["federation"] == {
        "sourceDigest": report["federation"]["sourceDigest"],
        "documentOrder": report["federation"]["documentOrder"],
        "options": report["federation"]["options"],
    }
    # The report describes the adapter; the manifest has to identify it, because
    # the consumer that hydrates an artifact verifies the identity that wrote it.
    identity = subprocess.run(
        [sys.executable, str(ADAPTER), "--identity"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert shared["adapter"] == json.loads(identity.stdout)


def test_federation_manifest_requires_a_document_cache(tmp_path: Path) -> None:
    architecture = tmp_path / "architecture.ifc"
    architecture.write_bytes(FIXTURE.read_bytes())
    manifest = tmp_path / "manifest.json"

    completed = run_manifest(manifest, [("architecture", architecture)], None)

    assert completed.returncode != 0
    assert "--federation-manifest requires --document-cache." in completed.stderr
    assert not manifest.exists()


def test_federation_manifest_stage_timing_reports_only_the_manifest_write(
    tmp_path: Path,
) -> None:
    source = FIXTURE.read_bytes()
    architecture = tmp_path / "architecture.ifc"
    architecture.write_bytes(source)
    structure = tmp_path / "structure.ifc"
    structure.write_bytes(source)
    documents = [("architecture", architecture), ("structure", structure)]
    cache = tmp_path / "cache"
    timing_path = tmp_path / "timing.json"

    read_manifest(tmp_path / "manifest.json", documents, cache, timing_path)
    ledger = json.loads(timing_path.read_text("utf-8"))

    assert ledger["schemaVersion"] == "naru.ifc-adapter-stage-timing.1"
    assert [entry["discipline"] for entry in ledger["documents"]] == [
        "architecture",
        "structure",
    ]
    for entry in ledger["documents"]:
        assert entry["outcome"] == "extracted"
    # Manifest assembly performs no merge and writes no Scene IR, so the only
    # write it can report is the manifest itself.
    assert ledger["federation"] == {}
    assert set(ledger["write"]) == {"manifestMilliseconds"}
    assert ledger["write"]["manifestMilliseconds"] >= 0

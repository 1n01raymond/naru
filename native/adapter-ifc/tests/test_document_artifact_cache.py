from __future__ import annotations

import gzip
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from property_columns import (  # noqa: E402
    decode_property_row,
    encode_property_value_columns,
)

from document_artifact_cache import (  # noqa: E402
    DOCUMENT_ARTIFACT_SCHEMA,
    document_artifact_key,
    document_artifact_path,
    prepare_document_payload,
    publish_document_artifact,
    read_document_artifact,
    restore_document_payload,
)


def key_input(digest: str = "a" * 64) -> dict[str, object]:
    return {
        "schemaVersion": "naru.ifc-document-artifact-key.1",
        "discipline": "architecture",
        "sourceDigest": digest,
        "uriHint": "models/architecture.ifc",
        "threads": 4,
        "adapterFingerprint": "b" * 64,
    }


def extracted_document() -> dict[str, object]:
    positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    return {
        "input": object(),
        "sourceDigest": "a" * 64,
        "timestamp": "1970-01-01T00:00:00.000Z",
        "document": {"id": "document:architecture"},
        "semantics": [],
        "prototypes": [],
        "occurrences": [],
        "representations": [
            {
                "id": "representation:wall",
                "surface": {"positions": positions, "indices": [0, 1]},
                "edges": {"positions": positions, "segments": [0, 1]},
            }
        ],
        "materials": [],
        "diagnostics": [],
        "counts": {"prototypeCount": 1},
        "prototypeReuse": [],
    }


def as_plain(value: object) -> object:
    """Restored geometry is typed arrays; compare payloads by their values."""

    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {key: as_plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [as_plain(item) for item in value]
    return value


# The geometry region is aligned so a restored array is a view, never a copy.
_GEOMETRY_ALIGNMENT = 8
_SHARED_POSITIONS = {"$naruAlias": "surface.positions"}


def _aligned(offset: int) -> int:
    return offset + (-offset % _GEOMETRY_ALIGNMENT)


def test_publishes_deterministic_verified_artifact(tmp_path: Path) -> None:
    first_directory = tmp_path / "first"
    second_directory = tmp_path / "second"
    payload = prepare_document_payload(extracted_document())

    first_path = publish_document_artifact(first_directory, key_input(), payload)
    second_path = publish_document_artifact(second_directory, key_input(), payload)

    assert first_path.read_bytes() == second_path.read_bytes()
    assert as_plain(read_document_artifact(first_directory, key_input())) == as_plain(payload)


def test_restores_shared_surface_edge_positions(tmp_path: Path) -> None:
    payload = prepare_document_payload(extracted_document())
    publish_document_artifact(tmp_path, key_input(), payload)

    loaded = read_document_artifact(tmp_path, key_input())
    assert loaded is not None
    document_input = object()
    restored = restore_document_payload(loaded, document_input)
    representation = restored["representations"][0]

    assert restored["input"] is document_input
    assert representation["edges"]["positions"] is representation["surface"]["positions"]


def test_corruption_and_identity_changes_are_cache_misses(tmp_path: Path) -> None:
    payload = prepare_document_payload(extracted_document())
    artifact_path = publish_document_artifact(tmp_path, key_input(), payload)
    artifact_path.write_bytes(b"corrupted")

    assert read_document_artifact(tmp_path, key_input()) is None
    assert read_document_artifact(tmp_path, key_input("c" * 64)) is None
    assert document_artifact_path(tmp_path, key_input("c" * 64)) != artifact_path

    renamed_uri = {**key_input(), "uriHint": "models/architecture-renamed.ifc"}
    renamed_discipline = {**key_input(), "discipline": "architecture-core"}
    assert read_document_artifact(tmp_path, renamed_uri) is None
    assert read_document_artifact(tmp_path, renamed_discipline) is None

    publish_document_artifact(tmp_path, key_input(), payload)
    assert as_plain(read_document_artifact(tmp_path, key_input())) == as_plain(payload)

    different_payload = {**payload, "sourceDigest": "different"}
    with pytest.raises(ValueError, match="two different payloads"):
        publish_document_artifact(tmp_path, key_input(), different_payload)


def test_read_reports_load_and_verify_stages_without_changing_the_verdict(
    tmp_path: Path,
) -> None:
    payload = prepare_document_payload(extracted_document())
    artifact_path = publish_document_artifact(tmp_path, key_input(), payload)

    verified: dict[str, object] = {}
    assert as_plain(read_document_artifact(tmp_path, key_input(), verified)) == as_plain(
        payload
    )
    assert verified["artifactState"] == "verified"
    assert verified["artifactBytes"] == artifact_path.stat().st_size
    assert verified["artifactLoadMilliseconds"] >= 0
    assert verified["artifactVerifyMilliseconds"] >= 0
    assert verified["artifactParseMilliseconds"] >= 0
    assert verified["artifactPayloadBytes"] > 0

    absent: dict[str, object] = {}
    assert read_document_artifact(tmp_path, key_input("c" * 64), absent) is None
    assert absent["artifactState"] == "absent"
    assert "artifactVerifyMilliseconds" not in absent

    artifact_path.write_bytes(b"corrupted")
    corrupted: dict[str, object] = {}
    assert read_document_artifact(tmp_path, key_input(), corrupted) is None
    assert corrupted["artifactState"] == "invalid"
    assert corrupted["artifactInvalidReason"].startswith("unreadable artifact")
    assert "artifactParseMilliseconds" not in corrupted


def _decompress(artifact_path: Path) -> tuple[dict[str, object], bytes]:
    with gzip.open(artifact_path, "rb") as source:
        header = json.loads(source.readline())
        body = source.read()
    return header, body


def test_artifact_is_a_header_line_over_the_stored_payload_bytes(tmp_path: Path) -> None:
    payload = prepare_document_payload(extracted_document())
    artifact_path = publish_document_artifact(tmp_path, key_input(), payload)
    header, body = _decompress(artifact_path)

    assert header["schemaVersion"] == DOCUMENT_ARTIFACT_SCHEMA
    assert header["key"] == document_artifact_key(key_input())
    assert header["keyInput"] == key_input()
    assert header["payloadBytes"] == len(body)
    assert header["payloadSha256"] == hashlib.sha256(body).hexdigest()

    # The payload is a canonical-JSON structure region, zero padding to the
    # geometry alignment, then the hoisted arrays in layout order.
    structure_bytes = header["structureBytes"]
    assert 0 < structure_bytes < header["payloadBytes"]
    structure = json.loads(body[:structure_bytes])
    canonical = json.dumps(
        structure, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False
    ).encode("utf-8")
    assert body[:structure_bytes] == canonical
    geometry_start = _aligned(structure_bytes)
    assert set(body[structure_bytes:geometry_start]) <= {0}

    # A hoisted field keeps its place in the structure as its byte length, so the
    # offsets follow from the layout order and no offset table is stored: six
    # float64 positions, then two uint32 indices, then two uint32 segments.
    representation = structure["representations"][0]
    assert representation["surface"] == {"positions": 48, "indices": 8}
    assert representation["edges"] == {"positions": _SHARED_POSITIONS, "segments": 8}
    assert len(body) - geometry_start == 64


def test_restored_geometry_keeps_the_dtype_the_scene_writer_packs(tmp_path: Path) -> None:
    payload = prepare_document_payload(extracted_document())
    publish_document_artifact(tmp_path, key_input(), payload)

    loaded = read_document_artifact(tmp_path, key_input())
    assert loaded is not None
    surface = loaded["representations"][0]["surface"]
    edges = loaded["representations"][0]["edges"]

    assert surface["positions"].dtype == np.dtype("<f8")
    assert surface["indices"].dtype == np.dtype("<u4")
    assert edges["segments"].dtype == np.dtype("<u4")
    assert surface["positions"].tolist() == [0.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    assert surface["indices"].tolist() == [0, 1]
    assert edges["segments"].tolist() == [0, 1]


PROPERTY_ROWS = [["wall", 300, None], [], ["wall", True]]


def document_with_properties() -> dict[str, object]:
    """A document that interned its own keys and encoded its own values.

    That is what the per-document pass produces since ADR-0019 slice 3, so the
    artifact has to carry both tables and hand the columns back ready to merge.
    """

    extracted = extracted_document()
    extracted["propertyIndex"] = {
        "keys": ["Load", "Name", "Note"],
        "sets": [[0, 1, 2], [], [0, 1]],
    }
    extracted["propertyValues"] = encode_property_value_columns(PROPERTY_ROWS)
    return extracted


def test_property_columns_round_trip_as_typed_views_over_the_stored_region(
    tmp_path: Path,
) -> None:
    extracted = document_with_properties()
    encoded = extracted["propertyValues"]
    payload = prepare_document_payload(extracted)
    publish_document_artifact(tmp_path, key_input(), payload)

    loaded = read_document_artifact(tmp_path, key_input())
    assert loaded is not None
    assert loaded["propertyIndex"] == extracted["propertyIndex"]
    columns = loaded["propertyValues"]
    assert columns["value_heap"].dtype == np.dtype("<u1")
    assert columns["value_offsets"].dtype == np.dtype("<u4")
    assert columns["row_refs"].dtype == np.dtype("<u4")
    assert columns["row_offsets"].dtype == np.dtype("<u4")
    assert bytes(columns["value_heap"]) == bytes(encoded["value_heap"])
    assert [decode_property_row(columns, row) for row in range(len(PROPERTY_ROWS))] == (
        PROPERTY_ROWS
    )


def test_property_columns_keep_their_place_in_the_structure_as_byte_lengths(
    tmp_path: Path,
) -> None:
    extracted = document_with_properties()
    encoded = extracted["propertyValues"]
    artifact_path = publish_document_artifact(
        tmp_path, key_input(), prepare_document_payload(extracted)
    )
    header, body = _decompress(artifact_path)

    structure = json.loads(body[: int(header["structureBytes"])])
    assert structure["propertyValues"] == {
        "value_heap": len(encoded["value_heap"]),
        "value_offsets": 4 * len(encoded["value_offsets"]),
        "row_refs": 4 * len(encoded["row_refs"]),
        "row_offsets": 4 * len(encoded["row_offsets"]),
        "value_count": encoded["value_count"],
        "row_count": encoded["row_count"],
        "distinct_value_count": encoded["distinct_value_count"],
    }
    # The property regions follow the geometry ones, every region padded so a
    # restored array is a view over aligned bytes: six float64 positions, two
    # uint32 indices, two uint32 segments, then the heap and the three tables.
    region_start = _aligned(int(header["structureBytes"]))
    assert len(body) - region_start == 64 + sum(
        _aligned(length)
        for length in (
            len(encoded["value_heap"]),
            4 * len(encoded["value_offsets"]),
            4 * len(encoded["row_refs"]),
            4 * len(encoded["row_offsets"]),
        )
    )


def test_property_columns_are_hoisted_even_without_geometry(tmp_path: Path) -> None:
    """The heap is raw `bytes`, so it can never be left in the structure JSON."""

    extracted = document_with_properties()
    extracted["representations"] = []
    artifact_path = publish_document_artifact(
        tmp_path, key_input(), prepare_document_payload(extracted)
    )
    header, _ = _decompress(artifact_path)
    assert int(header["structureBytes"]) < int(header["payloadBytes"])

    loaded = read_document_artifact(tmp_path, key_input())
    assert loaded is not None
    assert [
        decode_property_row(loaded["propertyValues"], row)
        for row in range(len(PROPERTY_ROWS))
    ] == PROPERTY_ROWS


def test_a_document_without_geometry_stores_the_structure_alone(tmp_path: Path) -> None:
    extracted = extracted_document()
    extracted["representations"] = []
    payload = prepare_document_payload(extracted)
    artifact_path = publish_document_artifact(tmp_path, key_input(), payload)
    header, body = _decompress(artifact_path)

    assert header["structureBytes"] == header["payloadBytes"] == len(body)
    assert json.loads(body) == payload
    assert read_document_artifact(tmp_path, key_input()) == payload


def _rewrite(artifact_path: Path, header: dict[str, object], body: bytes) -> None:
    line = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
    with gzip.GzipFile(filename="", mode="wb", fileobj=artifact_path.open("wb"), mtime=0) as out:
        out.write(line + body)


def test_stored_byte_verification_rejects_tampering_truncation_and_old_envelopes(
    tmp_path: Path,
) -> None:
    payload = prepare_document_payload(extracted_document())
    artifact_path = publish_document_artifact(tmp_path, key_input(), payload)
    original = artifact_path.read_bytes()
    header, body = _decompress(artifact_path)

    def state_after(rewrite_header: dict[str, object], rewrite_body: bytes) -> dict[str, object]:
        _rewrite(artifact_path, rewrite_header, rewrite_body)
        timing: dict[str, object] = {}
        assert read_document_artifact(tmp_path, key_input(), timing) is None
        assert timing["artifactState"] == "invalid"
        return timing

    flipped = bytearray(body)
    flipped[len(flipped) // 2] ^= 0x01
    assert state_after(header, bytes(flipped))["artifactInvalidReason"] == "payload digest mismatch"
    assert state_after(header, body[:-1])["artifactInvalidReason"] == "payload length mismatch"
    assert state_after({**header, "schemaVersion": "naru.ifc-document-artifact.1"}, body)[
        "artifactInvalidReason"
    ] == "schema mismatch"
    assert state_after({**header, "key": "0" * 64}, body)["artifactInvalidReason"] == "key mismatch"

    # A `.1`-shaped envelope (one JSON object, no header line) is a miss, never parsed as a payload.
    envelope = {"schemaVersion": "naru.ifc-document-artifact.1", "payload": payload}
    with gzip.GzipFile(filename="", mode="wb", fileobj=artifact_path.open("wb"), mtime=0) as out:
        out.write(json.dumps(envelope).encode("utf-8"))
    old: dict[str, object] = {}
    assert read_document_artifact(tmp_path, key_input(), old) is None
    assert old["artifactState"] == "invalid"

    # A gzip stream cut mid-member is unreadable, and therefore invalid rather than absent.
    whole = artifact_path.read_bytes()
    artifact_path.write_bytes(whole[: len(whole) // 2])
    cut: dict[str, object] = {}
    assert read_document_artifact(tmp_path, key_input(), cut) is None
    assert cut["artifactState"] == "invalid"

    # Republishing over any invalid artifact restores a verified one with the same bytes.
    assert publish_document_artifact(tmp_path, key_input(), payload) == artifact_path
    assert artifact_path.read_bytes() == original
    assert as_plain(read_document_artifact(tmp_path, key_input())) == as_plain(payload)


def _republish_with_structure(
    artifact_path: Path,
    header: dict[str, object],
    body: bytes,
    structure: dict[str, object],
) -> None:
    """Rewrite an artifact around a tampered structure, keeping its geometry.

    The header is re-derived, so what the read path sees is a well-formed
    artifact whose declared geometry lengths are the only thing wrong with it.
    """

    geometry = body[_aligned(int(header["structureBytes"])) :]
    encoded = json.dumps(
        structure, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False
    ).encode("utf-8")
    payload = encoded + bytes(_aligned(len(encoded)) - len(encoded)) + geometry
    _rewrite(
        artifact_path,
        {
            **header,
            "structureBytes": len(encoded),
            "payloadBytes": len(payload),
            "payloadSha256": hashlib.sha256(payload).hexdigest(),
        },
        payload,
    )


def test_geometry_lengths_that_do_not_describe_the_region_are_misses(tmp_path: Path) -> None:
    payload = prepare_document_payload(extracted_document())
    artifact_path = publish_document_artifact(tmp_path, key_input(), payload)
    header, body = _decompress(artifact_path)
    structure = json.loads(body[: int(header["structureBytes"])])

    # Twelve overruns the stored region, zero leaves eight bytes unclaimed, and
    # seven is not a whole number of uint32 elements. Four is deliberately not
    # among these: a shortfall smaller than the alignment padding is absorbed by
    # the next field's alignment, which is why the read path also checks that the
    # declared lengths end exactly where the stored region does.
    for length in (12, 0, 7):
        tampered = json.loads(json.dumps(structure))
        tampered["representations"][0]["surface"]["indices"] = length
        _republish_with_structure(artifact_path, header, body, tampered)
        timing: dict[str, object] = {}
        assert read_document_artifact(tmp_path, key_input(), timing) is None
        assert timing["artifactState"] == "invalid"
        assert (
            timing["artifactInvalidReason"]
            == "region lengths do not describe the stored bytes"
        )

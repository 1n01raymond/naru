"""Verified per-document Scene IR artifacts for the IFC federation adapter.

An artifact is one deterministic gzip stream (mtime 0, no embedded file name)
whose decompressed content is a canonical-JSON header line followed by exactly
``payloadBytes`` bytes of payload:

    {"key":...,"keyInput":{...},"payloadBytes":N,"payloadSha256":"...",
     "structureBytes":S,"schemaVersion":"naru.ifc-document-artifact.4"}\n
    <structure JSON, exactly S bytes><zero padding to 8><binary regions>

The structure region is canonical JSON (UTF-8, sorted keys, compact
separators, no NaN). The binary regions hold the vertex, index, normal, and
edge arrays of every representation (ADR-0019 slice 2) followed by the
document's property value heap and index columns (slice 3), each already in the
little-endian dtype the scene writer packs it as, so restoring one is a typed
view rather than a scan of Python numbers; a hoisted field keeps its place in
the structure JSON as its byte length, and the fields' offsets follow from
walking the representations in order and then the property columns. When a
document carries neither the payload is the structure region alone.

The header names what the payload must hash to. A reader checks the schema,
the key, and the key input, hashes the payload bytes it just decompressed, and
parses them only when the length and the digest match: verification is one
read and one hash of the stored bytes, never a re-serialization of the parsed
object (ADR-0019 slice 1). Any file that fails a check is a miss; nothing
executable such as pickle is ever loaded. Publication serializes the structure
once and streams the binary regions it already holds, writing to a temporary
sibling and renaming it into place.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

DOCUMENT_ARTIFACT_SCHEMA = "naru.ifc-document-artifact.4"
_SURFACE_POSITION_ALIAS = {"$naruAlias": "surface.positions"}

# The geometry fields hoisted out of the payload JSON, in the order the scene
# writer packs them, each with the dtype it is packed as. Storing an array in
# its final dtype makes restoration a typed view and packing a copy, instead of
# a scan of Python numbers on both sides (ADR-0019 slice 2).
GEOMETRY_FIELD_LAYOUT: tuple[tuple[str, str, str], ...] = (
    ("surface", "positions", "<f8"),
    ("surface", "indices", "<u4"),
    ("surface", "normals", "<f4"),
    ("edges", "positions", "<f8"),
    ("edges", "segments", "<u4"),
    ("edges", "classes", "<u1"),
    ("edges", "sourceIds", "<u4"),
)

# The property column fields hoisted out of the payload JSON, in the order they
# are stored, each with the dtype the scene writer packs it as. The value heap
# carries the bytes `encode_property_value` produced for this document, so a
# federation merge moves encoded values instead of running the encoder again
# (ADR-0019 slice 3).
PROPERTY_FIELD_LAYOUT: tuple[tuple[str, str], ...] = (
    ("value_heap", "<u1"),
    ("value_offsets", "<u4"),
    ("row_refs", "<u4"),
    ("row_offsets", "<u4"),
)
_REGION_ALIGNMENT = 8


def _canonical_bytes(value: Any) -> bytes:
    """Serialize `value` as canonical JSON: sorted keys, compact, UTF-8, no NaN."""

    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def _canonical_sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def document_artifact_key(key_input: dict[str, Any]) -> str:
    return _canonical_sha256(key_input)


def document_artifact_path(
    cache_directory: str | os.PathLike[str],
    key_input: dict[str, Any],
) -> Path:
    return Path(cache_directory) / f"{document_artifact_key(key_input)}.json.gz"


def prepare_document_payload(extracted: dict[str, Any]) -> dict[str, Any]:
    """Remove process-only input and encode shared geometry-list identity."""

    payload = {key: value for key, value in extracted.items() if key != "input"}
    representations = []
    for representation in extracted["representations"]:
        representation_copy = dict(representation)
        surface = representation.get("surface")
        edges = representation.get("edges")
        if surface is not None:
            representation_copy["surface"] = dict(surface)
        if edges is not None:
            edges_copy = dict(edges)
            if surface is not None and edges.get("positions") is surface.get("positions"):
                edges_copy["positions"] = _SURFACE_POSITION_ALIAS
            representation_copy["edges"] = edges_copy
        representations.append(representation_copy)
    payload["representations"] = representations
    return payload


def restore_document_payload(
    payload: dict[str, Any],
    document_input: Any,
) -> dict[str, Any]:
    """Restore process-only input and geometry aliases after JSON loading."""

    for representation in payload["representations"]:
        surface = representation.get("surface")
        edges = representation.get("edges")
        if surface is None or edges is None:
            continue
        # Compare the marker by type first: once geometry is restored as typed
        # arrays, `array == dict` is an elementwise comparison, not a test.
        marker = edges.get("positions")
        if isinstance(marker, dict) and marker == _SURFACE_POSITION_ALIAS:
            edges["positions"] = surface["positions"]
    return {"input": document_input, **payload}


def _aligned(offset: int) -> int:
    remainder = offset % _REGION_ALIGNMENT
    return offset if remainder == 0 else offset + (_REGION_ALIGNMENT - remainder)


def _region_view(value: Any, dtype: str) -> memoryview | None:
    """The little-endian bytes of one hoistable field, or None when it is not one."""

    if isinstance(value, (bytes, bytearray, memoryview)):
        return memoryview(value).cast("B")
    if isinstance(value, (list, tuple, np.ndarray)):
        # `ascontiguousarray` returns the argument itself when it already has
        # this dtype and layout, so a stored-form array is not copied.
        return memoryview(np.ascontiguousarray(value, dtype=dtype)).cast("B")
    return None


def split_payload_regions(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[memoryview]]:
    """Hoist the binary arrays of `payload` into one aligned sequence of regions.

    Returns the structure to serialize and the regions to store after it, in
    order: every representation's geometry first, then the document's property
    columns. The regions are views rather than one joined buffer: a real-large
    document carries hundreds of megabytes of geometry, and it is hashed and
    written a region at a time. Each hoisted field keeps its place in the
    structure as its byte length; the offsets follow from walking
    `representations` in order with `GEOMETRY_FIELD_LAYOUT` within each and then
    `PROPERTY_FIELD_LAYOUT`, so no offset table is stored. A field that is
    absent, null, or the shared-positions marker is left where it is.
    """

    blocks: list[memoryview] = []
    offset = 0

    def hoist(block: dict[str, Any], field: str, dtype: str) -> None:
        nonlocal offset
        raw = _region_view(block.get(field), dtype)
        if raw is None:
            return
        padding = _aligned(offset) - offset
        if padding:
            blocks.append(memoryview(bytes(padding)))
            offset += padding
        blocks.append(raw)
        offset += raw.nbytes
        block[field] = raw.nbytes

    structure = dict(payload)
    representations = structure.get("representations")
    if isinstance(representations, list):
        replacements: list[Any] = []
        for representation in representations:
            if not isinstance(representation, dict):
                replacements.append(representation)
                continue
            replacement = dict(representation)
            for part in ("surface", "edges"):
                block = replacement.get(part)
                if isinstance(block, dict):
                    replacement[part] = dict(block)
            for part, field, dtype in GEOMETRY_FIELD_LAYOUT:
                block = replacement.get(part)
                if isinstance(block, dict):
                    hoist(block, field, dtype)
            replacements.append(replacement)
        structure["representations"] = replacements
    columns = structure.get("propertyValues")
    if isinstance(columns, dict):
        replacement = dict(columns)
        for field, dtype in PROPERTY_FIELD_LAYOUT:
            hoist(replacement, field, dtype)
        structure["propertyValues"] = replacement
    if offset == 0:
        return payload, []
    return structure, blocks


def attach_payload_regions(
    structure: dict[str, Any],
    buffer: bytes,
    start: int,
) -> dict[str, Any] | None:
    """Restore hoisted arrays in place as typed views over `buffer`.

    `start` is where the binary regions begin in `buffer`. Returns `structure`
    once every hoisted length has been resolved, or None when the lengths do not
    describe exactly the stored region: a malformed artifact is a miss, never an
    exception and never a partially restored document.
    """

    available = len(buffer) - start
    if available < 0:
        return None
    fields: list[tuple[dict[str, Any], str, str]] = []
    representations = structure.get("representations")
    if isinstance(representations, list):
        for representation in representations:
            if not isinstance(representation, dict):
                continue
            for part, field, dtype in GEOMETRY_FIELD_LAYOUT:
                block = representation.get(part)
                if isinstance(block, dict):
                    fields.append((block, field, dtype))
    columns = structure.get("propertyValues")
    if isinstance(columns, dict):
        for field, dtype in PROPERTY_FIELD_LAYOUT:
            fields.append((columns, field, dtype))
    offset = 0
    for block, field, dtype in fields:
        length = block.get(field)
        if isinstance(length, bool) or not isinstance(length, int):
            continue
        descriptor = np.dtype(dtype)
        if length < 0 or length % descriptor.itemsize:
            return None
        offset = _aligned(offset)
        if offset + length > available:
            return None
        block[field] = np.frombuffer(
            buffer,
            dtype=descriptor,
            count=length // descriptor.itemsize,
            offset=start + offset,
        )
        offset += length
    if offset != available:
        return None
    return structure


class _StoredArtifact:
    """What one read of an artifact file established, before any parsing."""

    __slots__ = ("state", "reason", "header", "payload_bytes", "file_bytes", "load_ms", "verify_ms")

    def __init__(self, state: str, reason: str | None) -> None:
        self.state = state
        self.reason = reason
        self.header: dict[str, Any] | None = None
        self.payload_bytes: bytes | None = None
        self.file_bytes = 0
        self.load_ms = 0.0
        self.verify_ms = 0.0


def _header_failure(header: Any, key: str, key_input: dict[str, Any]) -> str | None:
    if not isinstance(header, dict):
        return "header is not an object"
    if header.get("schemaVersion") != DOCUMENT_ARTIFACT_SCHEMA:
        return "schema mismatch"
    if header.get("key") != key:
        return "key mismatch"
    if header.get("keyInput") != key_input:
        return "key input mismatch"
    payload_bytes = header.get("payloadBytes")
    if isinstance(payload_bytes, bool) or not isinstance(payload_bytes, int) or payload_bytes < 0:
        return "payloadBytes is not a byte count"
    if not isinstance(header.get("payloadSha256"), str):
        return "payloadSha256 is not a digest"
    structure_bytes = header.get("structureBytes")
    if (
        isinstance(structure_bytes, bool)
        or not isinstance(structure_bytes, int)
        or not 0 <= structure_bytes <= payload_bytes
    ):
        return "structureBytes is not a byte count within the payload"
    return None


def _load_stored_artifact(path: Path, key: str, key_input: dict[str, Any]) -> _StoredArtifact:
    """Read one artifact file and verify its stored bytes without parsing the payload."""

    started = time.perf_counter()
    try:
        with gzip.open(path, "rb") as source:
            header_line = source.readline()
            payload = source.read()
        file_bytes = path.stat().st_size
    except FileNotFoundError:
        return _StoredArtifact("absent", None)
    except (OSError, EOFError) as error:
        # Present but not a readable gzip member (corrupt or truncated stream).
        result = _StoredArtifact("invalid", f"unreadable artifact: {type(error).__name__}")
        result.load_ms = (time.perf_counter() - started) * 1000.0
        return result
    result = _StoredArtifact("invalid", None)
    result.file_bytes = file_bytes
    result.load_ms = (time.perf_counter() - started) * 1000.0
    started = time.perf_counter()
    try:
        header = json.loads(header_line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        header = None
    failure = _header_failure(header, key, key_input)
    if failure is None and len(payload) != header["payloadBytes"]:
        failure = "payload length mismatch"
    if failure is None and hashlib.sha256(payload).hexdigest() != header["payloadSha256"]:
        failure = "payload digest mismatch"
    result.verify_ms = (time.perf_counter() - started) * 1000.0
    if failure is not None:
        result.reason = failure
        return result
    result.state = "verified"
    result.header = header
    result.payload_bytes = payload
    return result


def read_document_artifact(
    cache_directory: str | os.PathLike[str],
    key_input: dict[str, Any],
    timing: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Return the verified payload for `key_input`, or None when it must be re-extracted.

    `timing`, when given, receives the load/verify/parse split, the stored
    byte counts, and `artifactState` (`verified`, `invalid`, or `absent`).
    """

    path = document_artifact_path(cache_directory, key_input)
    stored = _load_stored_artifact(path, document_artifact_key(key_input), key_input)
    if timing is not None:
        timing["artifactState"] = stored.state
        if stored.state != "absent":
            timing["artifactLoadMilliseconds"] = stored.load_ms
            timing["artifactBytes"] = stored.file_bytes
            timing["artifactVerifyMilliseconds"] = stored.verify_ms
        if stored.reason is not None:
            timing["artifactInvalidReason"] = stored.reason
    if stored.state != "verified" or stored.payload_bytes is None:
        return None
    structure_bytes = stored.header["structureBytes"] if stored.header else 0
    started = time.perf_counter()
    try:
        payload = json.loads(stored.payload_bytes[:structure_bytes])
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    failure = None if isinstance(payload, dict) else "structure is not a JSON object"
    if failure is None:
        regions_start = (
            structure_bytes
            if len(stored.payload_bytes) == structure_bytes
            else _aligned(structure_bytes)
        )
        if attach_payload_regions(payload, stored.payload_bytes, regions_start) is None:
            failure = "region lengths do not describe the stored bytes"
    parse_ms = (time.perf_counter() - started) * 1000.0
    if failure is not None:
        if timing is not None:
            timing["artifactState"] = "invalid"
            timing["artifactInvalidReason"] = failure
        return None
    if timing is not None:
        timing["artifactPayloadBytes"] = len(stored.payload_bytes)
        timing["artifactParseMilliseconds"] = parse_ms
    return payload


def publish_document_artifact(
    cache_directory: str | os.PathLike[str],
    key_input: dict[str, Any],
    payload: dict[str, Any],
) -> Path:
    """Write the artifact for `key_input` atomically; idempotent for an identical payload.

    The structure is serialized exactly once and the binary regions are streamed
    from the arrays the caller already holds, so no copy of the whole payload is
    built. An existing artifact whose stored bytes verify and name the same
    digest is kept; one naming a different digest is an error (one key must
    never mean two payloads); one that fails verification is overwritten.
    """

    if not isinstance(payload, dict):
        raise TypeError("IFC document artifact payload must be a JSON object.")
    directory = Path(cache_directory)
    directory.mkdir(parents=True, exist_ok=True)
    key = document_artifact_key(key_input)
    path = directory / f"{key}.json.gz"
    structure, regions = split_payload_regions(payload)
    structure_bytes = _canonical_bytes(structure)
    padding = (
        bytes(_aligned(len(structure_bytes)) - len(structure_bytes)) if regions else b""
    )
    stored_regions: list[Any] = [structure_bytes, padding, *regions]
    digest = hashlib.sha256()
    payload_bytes_count = 0
    for region in stored_regions:
        digest.update(region)
        payload_bytes_count += memoryview(region).nbytes
    payload_sha256 = digest.hexdigest()
    existing = _load_stored_artifact(path, key, key_input)
    if existing.state == "verified" and existing.header is not None:
        if existing.header["payloadSha256"] != payload_sha256:
            raise ValueError("IFC document artifact key produced two different payloads.")
        return path
    del existing
    header_line = _canonical_bytes(
        {
            "schemaVersion": DOCUMENT_ARTIFACT_SCHEMA,
            "key": key,
            "keyInput": key_input,
            "payloadBytes": payload_bytes_count,
            "payloadSha256": payload_sha256,
            "structureBytes": len(structure_bytes),
        }
    ) + b"\n"
    descriptor, temporary_name = tempfile.mkstemp(
        dir=directory, prefix=f".{path.stem}-", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as raw_output:
            with gzip.GzipFile(
                filename="", mode="wb", fileobj=raw_output, mtime=0
            ) as compressed:
                compressed.write(header_line)
                for region in stored_regions:
                    if memoryview(region).nbytes:
                        compressed.write(region)
            raw_output.flush()
            os.fsync(raw_output.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    return path

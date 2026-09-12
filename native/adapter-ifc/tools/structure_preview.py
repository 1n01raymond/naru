"""Publish one IFC document's assembly tree before that document is tessellated.

ADR-0021 stages an import per document: as soon as a document is parsed its
tree is readable, long before geometry exists and long before a package is
written. This module owns the staged form.

A preview directory holds one canonical-JSON file per document plus an
``index.json`` that names them. Every file is written to a temporary sibling
and renamed into place, so a reader never observes a half-written tree, and the
index records each file's ``sha256`` and ``byteLength`` so a reader verifies
stored bytes before parsing them -- the same contract
``naru.ifc-document-artifact.3`` uses (ADR-0019 slice 1).

A preview is not a package and can never be mistaken for one: it carries its
own schema identifier, no ``scene.gltf``, no ``scene.bin``, and no digest
chain. It is disposable -- a completed import supersedes it -- and it is never
a cache tier: nothing here is ever restored into a compile.

The module is pure standard library on purpose, so it imports without
IfcOpenShell and is unit-testable anywhere.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Sequence

STRUCTURE_PREVIEW_SCHEMA = "naru.ifc-structure-preview.1"
STRUCTURE_PREVIEW_INDEX_SCHEMA = "naru.ifc-structure-preview-index.1"
INDEX_FILENAME = "index.json"


def _canonical_bytes(value: Any) -> bytes:
    """Serialize `value` as canonical JSON: sorted keys, compact, UTF-8, no NaN."""

    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def preview_filename(discipline: str) -> str:
    return f"structure-{discipline}.json"


#: A reader that opens the destination for the moment it takes to read it can
#: make os.replace fail on Windows, so a rename is retried for about this long
#: before the failure is treated as real. Chosen an order of magnitude above the
#: observed contention: a reader holds a tree open for well under a millisecond.
_REPLACE_TIMEOUT_SECONDS = 2.0
_REPLACE_RETRY_SECONDS = 0.002


def _replace_with_retry(temporary_path: Path, path: Path) -> None:
    """Rename a completed temporary file over `path`, tolerating live readers.

    `os.replace` is atomic on both platforms, but on Windows it raises
    PermissionError while any other process holds the destination open --
    which is exactly what a viewer polling this directory does. Without a
    retry the reader would decide whether the adapter survives publication,
    so a whole import could fail because someone was watching it. Retrying
    keeps publication atomic (a rename either happened or did not) and makes
    a reader unable to break the writer. A rename that never succeeds inside
    the budget is a real failure and is raised.
    """

    deadline = time.monotonic() + _REPLACE_TIMEOUT_SECONDS
    while True:
        try:
            os.replace(temporary_path, path)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(_REPLACE_RETRY_SECONDS)


def _write_atomically(path: Path, payload: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.stem}-", suffix=".tmp"
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        _replace_with_retry(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def build_structure_preview(
    *,
    discipline: str,
    uri_hint: str,
    document_id: str,
    source_digest: str,
    source_bytes: int,
    schema: str,
    nodes: Sequence[tuple[str, str, str | None, str | None]],
) -> dict[str, Any]:
    """Assemble one document's staged tree.

    `nodes` are `(id, type, name, parentId)` in the order the Scene IR lists
    the document's occurrences, so a preview node and a Scene IR occurrence are
    the same node in the same position. Parents are resolved to indexes into
    this list; a parent that is not in the list is an inconsistency, not a root,
    and is refused.
    """

    index_of = {node[0]: index for index, node in enumerate(nodes)}
    if len(index_of) != len(nodes):
        raise ValueError(f"Structure preview for {discipline} has duplicate node ids.")
    entries: list[dict[str, Any]] = []
    for identifier, kind, name, parent_id in nodes:
        if parent_id is not None and parent_id not in index_of:
            raise ValueError(
                f"Structure preview for {discipline} names an unknown parent {parent_id!r}."
            )
        entry: dict[str, Any] = {
            "id": identifier,
            "type": kind,
            "parent": index_of[parent_id] if parent_id is not None else None,
        }
        if name:
            entry["name"] = name
        entries.append(entry)
    return {
        "schemaVersion": STRUCTURE_PREVIEW_SCHEMA,
        "discipline": discipline,
        "uriHint": uri_hint,
        "documentId": document_id,
        "sourceDigest": source_digest,
        "sourceBytes": source_bytes,
        "schema": schema,
        "nodes": entries,
    }


class StructurePreviewPublisher:
    """Publishes staged trees into one directory, index last.

    The index is rewritten after every document, so it always names exactly the
    files that are already complete on disk. An empty index is written when the
    publisher is constructed, which is what lets a consumer attach to an import
    that has not finished parsing its first document.
    """

    def __init__(
        self,
        directory: str | os.PathLike[str],
        disciplines: Sequence[str],
        emission_order: Sequence[str],
    ) -> None:
        self.directory = Path(directory)
        self._disciplines = sorted(disciplines)
        self._emission_order = list(emission_order)
        if sorted(self._emission_order) != self._disciplines:
            raise ValueError("Structure preview emission order must cover every discipline.")
        self._documents: list[dict[str, Any]] = []
        self.directory.mkdir(parents=True, exist_ok=True)
        self._write_index()

    @property
    def documents(self) -> list[dict[str, Any]]:
        return list(self._documents)

    @property
    def emission_order(self) -> list[str]:
        return list(self._emission_order)

    def publish(self, preview: dict[str, Any]) -> dict[str, Any]:
        discipline = preview["discipline"]
        if discipline not in self._disciplines:
            raise ValueError(f"Structure preview for unexpected discipline {discipline}.")
        if any(item["discipline"] == discipline for item in self._documents):
            raise ValueError(f"Structure preview for {discipline} was already published.")
        payload = _canonical_bytes(preview)
        name = preview_filename(discipline)
        _write_atomically(self.directory / name, payload)
        descriptor = {
            "discipline": discipline,
            "path": name,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "byteLength": len(payload),
            "nodeCount": len(preview["nodes"]),
            "rootCount": sum(1 for node in preview["nodes"] if node["parent"] is None),
        }
        self._documents.append(descriptor)
        self._write_index()
        return descriptor

    def _write_index(self) -> None:
        index = {
            "schemaVersion": STRUCTURE_PREVIEW_INDEX_SCHEMA,
            "disciplines": self._disciplines,
            "emissionOrder": self._emission_order,
            "complete": len(self._documents) == len(self._disciplines),
            "documents": self._documents,
        }
        _write_atomically(self.directory / INDEX_FILENAME, _canonical_bytes(index))


def read_structure_preview_index(directory: str | os.PathLike[str]) -> dict[str, Any]:
    """Read the index, refusing anything that is not this schema."""

    index = json.loads((Path(directory) / INDEX_FILENAME).read_bytes().decode("utf-8"))
    if not isinstance(index, dict) or index.get("schemaVersion") != STRUCTURE_PREVIEW_INDEX_SCHEMA:
        raise ValueError("Structure preview index is not a naru.ifc-structure-preview-index.1.")
    return index


def read_structure_preview(
    directory: str | os.PathLike[str],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    """Verify one staged tree's stored bytes, then parse them.

    Length and digest are checked against what the index recorded, before
    `json.loads` ever sees the bytes.
    """

    stored = (Path(directory) / descriptor["path"]).read_bytes()
    if len(stored) != descriptor["byteLength"]:
        raise ValueError(
            f"Structure preview {descriptor['path']} is {len(stored)} bytes, "
            f"not the {descriptor['byteLength']} the index declares."
        )
    if hashlib.sha256(stored).hexdigest() != descriptor["sha256"]:
        raise ValueError(f"Structure preview {descriptor['path']} failed digest verification.")
    preview = json.loads(stored.decode("utf-8"))
    if not isinstance(preview, dict) or preview.get("schemaVersion") != STRUCTURE_PREVIEW_SCHEMA:
        raise ValueError("Structure preview is not a naru.ifc-structure-preview.1.")
    return preview

"""Unit tests for `native/adapter-ifc/tools/property_columns.py`.

Deliberately independent of IfcOpenShell: `property_columns` has no adapter
dependency, so these run with only `requirements-dev.txt` installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from property_columns import (  # noqa: E402
    decode_property_row,
    encode_property_value,
    encode_property_value_columns,
    merge_property_value_columns,
)

BAG_ROWS = [
    ["first", 2233332, None],
    [],
    ["first", True, 1.5],
    [{"type": "array", "values": [1, "x"]}, "Dëck famïly"],
]


def test_columns_round_trip_every_row():
    columns = encode_property_value_columns(BAG_ROWS)
    decoded = [decode_property_row(columns, row) for row in range(len(BAG_ROWS))]
    assert decoded == BAG_ROWS


def test_totals_count_references_not_distinct_values():
    columns = encode_property_value_columns(BAG_ROWS)
    assert columns["value_count"] == 8
    assert columns["row_count"] == 4
    # "first" repeats across bags but is stored once.
    assert columns["distinct_value_count"] == 7


def test_distinct_values_are_deduplicated_and_byte_sorted():
    columns = encode_property_value_columns([["b", "a"], ["a"]])
    offsets = columns["value_offsets"]
    heap = columns["value_heap"]
    encoded = [heap[offsets[i] : offsets[i + 1]] for i in range(len(offsets) - 1)]
    assert encoded == [b'"a"', b'"b"']
    assert encoded == sorted(encoded)


def test_row_offsets_bracket_each_bag():
    columns = encode_property_value_columns(BAG_ROWS)
    assert columns["row_offsets"] == [0, 3, 3, 6, 8]
    assert columns["row_offsets"][-1] == columns["value_count"]


def test_distinct_table_is_independent_of_bag_order():
    forward = encode_property_value_columns(BAG_ROWS)
    backward = encode_property_value_columns(list(reversed(BAG_ROWS)))
    assert forward["value_heap"] == backward["value_heap"]
    assert forward["value_offsets"] == backward["value_offsets"]


def test_compound_values_encode_canonically():
    # Key order inside compound values must not leak into the encoding.
    left = encode_property_value({"type": "quantity", "value": 1.5, "unit": "m"})
    right = encode_property_value({"unit": "m", "value": 1.5, "type": "quantity"})
    assert left == right
    assert left == b'{"type":"quantity","unit":"m","value":1.5}'


def test_non_ascii_values_stay_literal_utf8():
    assert encode_property_value("Dëck") == '"Dëck"'.encode("utf-8")


def test_non_finite_numbers_are_rejected():
    with pytest.raises(ValueError):
        encode_property_value(float("nan"))
DOCUMENT_ROWS = [
    [["first", 2233332, None], []],
    [["first", True, 1.5], ["shared"]],
    [[{"type": "array", "values": [1, "x"]}, "Deck famxily"], ["shared", None]],
]

# Federation rows are sorted by record id, not by document, so the merge has to
# hold up under an interleaved order.
FEDERATION_ROWS = [(1, 0), (0, 0), (2, 1), (1, 1), (0, 1), (2, 0)]


def test_merging_per_document_columns_equals_one_pass_over_every_row():
    """The federation merge must be the single pass, or ADR-0019 gate 1 fails.

    Each document encodes its own values, so the merge only dedupes and reorders
    byte strings. Every field has to match the columns `encode_property_value_columns`
    would have produced over the same rows in the same order -- including the heap
    bytes, which land in `properties.bin` verbatim.
    """
    expected = encode_property_value_columns(
        [DOCUMENT_ROWS[document][row] for document, row in FEDERATION_ROWS]
    )
    merged = merge_property_value_columns(
        [encode_property_value_columns(document) for document in DOCUMENT_ROWS],
        FEDERATION_ROWS,
    )
    assert bytes(merged["value_heap"]) == bytes(expected["value_heap"])
    assert list(merged["value_offsets"]) == list(expected["value_offsets"])
    assert list(merged["row_refs"]) == list(expected["row_refs"])
    assert list(merged["row_offsets"]) == list(expected["row_offsets"])
    for key in ("value_count", "row_count", "distinct_value_count"):
        assert merged[key] == expected[key]


def test_merged_columns_still_decode_every_row():
    merged = merge_property_value_columns(
        [encode_property_value_columns(document) for document in DOCUMENT_ROWS],
        FEDERATION_ROWS,
    )
    decoded = [decode_property_row(merged, row) for row in range(len(FEDERATION_ROWS))]
    assert decoded == [DOCUMENT_ROWS[document][row] for document, row in FEDERATION_ROWS]


def test_merging_accepts_columns_whose_members_are_typed_views():
    """A restored artifact hands the merge numpy views over the stored region."""
    numpy = pytest.importorskip("numpy")
    columns = [
        {
            "value_heap": numpy.frombuffer(
                bytes(entry["value_heap"]), dtype=numpy.dtype("<u1")
            ),
            "value_offsets": numpy.asarray(entry["value_offsets"], dtype="<u4"),
            "row_refs": numpy.asarray(entry["row_refs"], dtype="<u4"),
            "row_offsets": numpy.asarray(entry["row_offsets"], dtype="<u4"),
            "value_count": entry["value_count"],
            "row_count": entry["row_count"],
            "distinct_value_count": entry["distinct_value_count"],
        }
        for entry in (encode_property_value_columns(d) for d in DOCUMENT_ROWS)
    ]
    merged = merge_property_value_columns(columns, FEDERATION_ROWS)
    decoded = [decode_property_row(merged, row) for row in range(len(FEDERATION_ROWS))]
    assert decoded == [DOCUMENT_ROWS[document][row] for document, row in FEDERATION_ROWS]

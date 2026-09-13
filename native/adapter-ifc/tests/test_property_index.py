"""Unit tests for `native/adapter-ifc/tools/property_index.py`.

Deliberately independent of IfcOpenShell: `property_index` has no adapter
dependency, so these run with only `requirements-dev.txt` installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from property_index import (  # noqa: E402
    index_property_bags,
    merge_property_indexes,
)


def resolve(property_index, reference):
    """Joins a reference back to entries, mirroring the Scene IR consumer."""
    key_indexes = property_index["sets"][reference["set"]]
    return {
        property_index["keys"][key_index]: value
        for key_index, value in zip(key_indexes, reference["values"], strict=True)
    }


def test_indexing_is_lossless():
    bags = [
        {"b": 2, "a": 1},
        {"a": "x"},
        {},
        {"c": None, "a": True, "b": {"type": "array", "values": [1]}},
    ]
    property_index, references = index_property_bags(bags)
    assert [resolve(property_index, reference) for reference in references] == bags


def test_keys_are_distinct_and_codepoint_sorted():
    property_index, _ = index_property_bags(
        [{"Zeta": 1, "alpha": 2}, {"alpha": 3, "ifc.Tag": 4}]
    )
    assert property_index["keys"] == ["Zeta", "alpha", "ifc.Tag"]


def test_sets_are_distinct_ascending_and_lexicographically_sorted():
    property_index, references = index_property_bags(
        [
            {"b": 1, "a": 2},
            {"a": 3, "b": 4},
            {"b": 5},
            {},
        ]
    )
    assert property_index["sets"] == [[], [0, 1], [1]]
    assert [reference["set"] for reference in references] == [1, 1, 2, 0]
    for entry in property_index["sets"]:
        assert entry == sorted(set(entry))


def test_values_align_with_sorted_keys():
    _, references = index_property_bags([{"b": "second", "a": "first"}])
    assert references[0]["values"] == ["first", "second"]


def test_index_is_independent_of_bag_order():
    bags = [{"a": 1}, {"a": 2, "b": 3}, {"c": 4}]
    forward, _ = index_property_bags(bags)
    backward, _ = index_property_bags(list(reversed(bags)))
    assert forward == backward
DOCUMENT_BAGS = [
    [{"b": 2, "a": 1}, {"a": "x"}],
    [{}, {"c": None, "a": True}, {"b": 7, "c": 8}],
    [{"Zeta": 1}],
]


def test_merging_per_document_indexes_equals_one_pass_over_every_bag():
    """The federation merge must be the single pass, or ADR-0019 gate 1 fails.

    A document interns its own keys, so the merge has to rebuild exactly the
    tables `index_property_bags` would have produced over the concatenation --
    same keys, same sets, and the same set index for every bag.
    """
    expected_index, expected_references = index_property_bags(
        [bag for document in DOCUMENT_BAGS for bag in document]
    )
    per_document = [index_property_bags(document) for document in DOCUMENT_BAGS]
    merged_index, set_remaps = merge_property_indexes(
        [index for index, _ in per_document]
    )
    assert merged_index == expected_index
    remapped = [
        set_remaps[document][reference["set"]]
        for document, (_, references) in enumerate(per_document)
        for reference in references
    ]
    assert remapped == [reference["set"] for reference in expected_references]


def test_merging_one_index_reproduces_it():
    index, _ = index_property_bags(DOCUMENT_BAGS[1])
    merged_index, set_remaps = merge_property_indexes([index])
    assert merged_index == index
    assert set_remaps == [list(range(len(index["sets"])))]


def test_merging_no_index_yields_empty_tables():
    assert merge_property_indexes([]) == ({"keys": [], "sets": []}, [])

"""Deterministic key/key-set interning for flattened semantic property bags.

Pure Python (no ifcopenshell import) so `pnpm adapter:ifc:test` can cover it
without a native toolchain. The index format matches the Scene IR
`propertyIndex` contract: `keys` holds every distinct property key once in
codepoint order, `sets` holds every distinct key combination as a strictly
ascending tuple of key indexes, sorted lexicographically. Both tables depend
only on the multiset of bags, never on bag order.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence


def index_property_bags(
    bags: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Builds the scene-level property index and one reference per bag.

    Returns ``(property_index, references)`` where ``references[i]`` is
    ``{"set": s, "values": [...]}`` for ``bags[i]``: ``values[j]`` is the value
    of ``property_index["keys"][property_index["sets"][s][j]]``.
    """
    keys = sorted({key for bag in bags for key in bag})
    key_positions = {key: position for position, key in enumerate(keys)}
    bag_keys = [sorted(bag) for bag in bags]
    distinct_sets = sorted(
        {tuple(key_positions[key] for key in sorted_keys) for sorted_keys in bag_keys}
    )
    set_positions = {entry: position for position, entry in enumerate(distinct_sets)}
    references = [
        {
            "set": set_positions[tuple(key_positions[key] for key in sorted_keys)],
            "values": [bag[key] for key in sorted_keys],
        }
        for bag, sorted_keys in zip(bags, bag_keys, strict=True)
    ]
    property_index = {
        "keys": keys,
        "sets": [list(entry) for entry in distinct_sets],
    }
    return property_index, references


def merge_property_indexes(
    indexes: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], list[list[int]]]:
    """Merges per-document property indexes into one federation-level index.

    Each element of ``indexes`` is an index in the shape
    :func:`index_property_bags` returns. The result is
    ``(property_index, set_remaps)``: ``property_index`` is what
    :func:`index_property_bags` would have produced from the concatenation of
    every document's bags, and ``set_remaps[d][s]`` is the federation set index
    of document ``d``'s local set ``s``.

    The key remap is monotone -- each document's keys are a subset of the
    federation keys and both tables are sorted -- so a locally ascending key
    tuple stays ascending and lexicographic set order is preserved.
    """
    keys = sorted({key for index in indexes for key in index["keys"]})
    key_positions = {key: position for position, key in enumerate(keys)}
    remapped_sets = [
        [
            tuple(key_positions[index["keys"][local]] for local in entry)
            for entry in index["sets"]
        ]
        for index in indexes
    ]
    distinct_sets = sorted({entry for document in remapped_sets for entry in document})
    set_positions = {entry: position for position, entry in enumerate(distinct_sets)}
    set_remaps = [
        [set_positions[entry] for entry in document] for document in remapped_sets
    ]
    property_index = {
        "keys": keys,
        "sets": [list(entry) for entry in distinct_sets],
    }
    return property_index, set_remaps

"""Generate the LOD method-comparison corpus (issue #126).

One small assembly with four analytic parts, every face a PLANE, CYLINDER, or
SPHERE so the experiment can measure mesh error against the exact source
surface instead of only against another mesh:

- ``curved-shell``: sphere r20 united with a cylinder r6 h40 (curved silhouette).
- ``thin-plate-holes``: 60 x 40 x 1 plate with four 3 mm and one 10 mm hole.
- ``planar-control``: 40 x 30 x 10 block with a 20 x 14 x 4 pocket (no curvature).
- ``fillet-bracket``: L-bracket with an r3 inner fillet and two 6 mm holes.

Parts sit 100 mm apart along X. The header is canonicalized exactly like the
other generated fixtures so the committed bytes are reproducible.
"""

from __future__ import annotations

from pathlib import Path

import cadquery as cq
from cadquery.occ_impl.exporters.assembly import exportAssembly

from generate_fixtures import canonicalize_header

FIXTURE_DIRECTORY = Path(__file__).resolve().parent.parent


def curved_shell() -> cq.Workplane:
    return cq.Workplane("XY").sphere(20).union(cq.Workplane("XY").circle(6).extrude(40))


def thin_plate_holes() -> cq.Workplane:
    return (
        cq.Workplane("XY")
        .box(60, 40, 1)
        .faces(">Z")
        .workplane()
        .pushPoints([(22, 14), (-22, 14), (22, -14), (-22, -14)])
        .hole(3)
        .faces(">Z")
        .workplane()
        .hole(10)
    )


def planar_control() -> cq.Workplane:
    return cq.Workplane("XY").box(40, 30, 10).faces(">Z").workplane().rect(20, 14).cutBlind(-4)


def fillet_bracket() -> cq.Workplane:
    return (
        cq.Workplane("XY")
        .box(40, 30, 4)
        .union(cq.Workplane("XZ").box(40, 30, 4).translate((0, 13, 13)))
        .edges("|X")
        .edges(cq.selectors.NearestToPointSelector((0, 11, 2)))
        .fillet(3)
        .faces("<Z")
        .workplane()
        .pushPoints([(-12, 0), (12, 0)])
        .hole(6)
    )


def lod_corpus_assembly() -> cq.Assembly:
    assembly = cq.Assembly(name="naru-lod-corpus")
    parts = [
        ("curved-shell", curved_shell()),
        ("thin-plate-holes", thin_plate_holes()),
        ("planar-control", planar_control()),
        ("fillet-bracket", fillet_bracket()),
    ]
    for index, (name, part) in enumerate(parts):
        assembly.add(part, name=name, loc=cq.Location(cq.Vector(100 * index, 0, 0)))
    return assembly


def main() -> None:
    path = FIXTURE_DIRECTORY / "lod-corpus.step"
    if not exportAssembly(
        lod_corpus_assembly(), str(path), unit="MM", write_pcurves=True, precision_mode=0
    ):
        raise RuntimeError("CadQuery failed to export lod-corpus.step")
    canonicalize_header(path)
    print(f"generated {path}")


if __name__ == "__main__":
    main()

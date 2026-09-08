"""Describe the analytic surface of every face the STEP adapter tessellates.

Diagnostic companion to ``extract_scene_ir.py`` for the LOD method comparison
(issue #126). It opens the same assembly through the same CadQuery call, walks
the same nodes in the same order, and enumerates ``shape.Faces()`` exactly as
``tessellate_shape`` does, so ``faces[i]`` here is the face behind
``source:<prototypeId>:face:<i>`` in the Scene IR. Planes, cylinders, and
spheres receive closed-form parameters; every other surface kind is reported
with ``"analytic": false`` so a consumer falls back to sampled distances.

Never called by a compile; it produces no bytes that reach a package.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane, GeomAbs_Sphere

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_scene_ir import rounded, slug  # noqa: E402


def xyz(value: Any) -> list[float]:
    return [rounded(value.X()), rounded(value.Y()), rounded(value.Z())]


def describe_face(face: cq.Face) -> dict[str, Any]:
    adaptor = BRepAdaptor_Surface(face.wrapped)
    kind = adaptor.GetType()
    if kind == GeomAbs_Plane:
        plane = adaptor.Plane()
        return {
            "kind": "plane",
            "analytic": True,
            "point": xyz(plane.Location()),
            "normal": xyz(plane.Axis().Direction()),
        }
    if kind == GeomAbs_Cylinder:
        cylinder = adaptor.Cylinder()
        return {
            "kind": "cylinder",
            "analytic": True,
            "point": xyz(cylinder.Location()),
            "axis": xyz(cylinder.Axis().Direction()),
            "radius": rounded(cylinder.Radius()),
        }
    if kind == GeomAbs_Sphere:
        sphere = adaptor.Sphere()
        return {
            "kind": "sphere",
            "analytic": True,
            "center": xyz(sphere.Location()),
            "radius": rounded(sphere.Radius()),
        }
    return {"kind": str(face.geomType()).lower(), "analytic": False}


def describe_edge(edge: cq.Edge) -> dict[str, Any]:
    adaptor = BRepAdaptor_Curve(edge.wrapped)
    kind = adaptor.GetType()
    if kind == GeomAbs_Line:
        line = adaptor.Line()
        return {
            "kind": "line",
            "analytic": True,
            "point": xyz(line.Location()),
            "direction": xyz(line.Direction()),
        }
    if kind == GeomAbs_Circle:
        circle = adaptor.Circle()
        return {
            "kind": "circle",
            "analytic": True,
            "center": xyz(circle.Location()),
            "axis": xyz(circle.Axis().Direction()),
            "radius": rounded(circle.Radius()),
        }
    return {"kind": str(edge.geomType()).lower(), "analytic": False}


def describe(source: Path) -> dict[str, Any]:
    assembly = cq.Assembly.importStep(str(source))
    prototypes: dict[str, dict[str, Any]] = {}
    seen: dict[int, str] = {}

    def walk(node: cq.Assembly) -> None:
        node_name = node.name or "unnamed"
        if node.obj is not None:
            shape_key = node.obj.hashCode()
            prototype_id = seen.get(shape_key, "")
            if not prototype_id:
                prototype_id = f"prototype:part:{slug(node_name)}"
                suffix = 2
                original_id = prototype_id
                while prototype_id in prototypes:
                    prototype_id = f"{original_id}-{suffix}"
                    suffix += 1
                seen[shape_key] = prototype_id
                shape = node.obj
                prototypes[prototype_id] = {
                    "faces": [describe_face(face) for face in shape.Faces()],
                    "edges": [describe_edge(edge) for edge in shape.Edges()],
                }
        for child in node.children:
            walk(child)

    walk(assembly)
    return {
        "schemaVersion": "naru.occt-analytic-faces.1",
        "source": source.name,
        "prototypes": prototypes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    result = describe(arguments.source)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    with arguments.output.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")
    counts = {key: len(value["faces"]) for key, value in result["prototypes"].items()}
    print(json.dumps(counts))


if __name__ == "__main__":
    main()

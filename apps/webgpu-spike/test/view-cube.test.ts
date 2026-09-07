import { describe, expect, it } from "vitest";

import {
  describeOrientation,
  isViewCubeFace,
  orientationCaption,
  projectViewCube,
  viewCubeFaceOrientations,
  viewCubeFaces,
  type ViewCubeFace,
} from "../src/view-cube.js";
import { OrthographicOrbitCamera, orbitCameraBasis } from "../src/view.js";

const bounds = { min: [-4, 0, -6] as const, max: [4, 3, 6] as const };
const defaultYaw = -Math.PI / 4;
const defaultPitch = Math.asin(1 / Math.sqrt(3));

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function parseMatrix(transform: string): number[] {
  const match = /^matrix\(([^)]+)\)$/.exec(transform);
  if (!match) throw new Error(`not a matrix transform: ${transform}`);
  return (match[1] ?? "").split(" ").map(Number);
}

describe("view cube faces", () => {
  it("labels six faces whose text axes span each outward normal", () => {
    expect(viewCubeFaces.map((face) => face.face)).toEqual([
      "front",
      "back",
      "right",
      "left",
      "top",
      "bottom",
    ]);
    for (const face of viewCubeFaces) {
      expect(cross(face.textRight, face.textUp).map((value) => value + 0)).toEqual([...face.normal]);
    }
  });

  it("names the orientation that looks squarely at every face", () => {
    for (const face of viewCubeFaces) {
      const { yaw, pitch } = viewCubeFaceOrientations[face.face];
      const { towardEye } = orbitCameraBasis(yaw, pitch);
      towardEye.forEach((value, axis) => expect(value).toBeCloseTo(face.normal[axis] ?? 0, 12));
      expect(describeOrientation(yaw, pitch)).toBe(face.face);
      const cube = projectViewCube(orbitCameraBasis(yaw, pitch));
      expect(cube.faces.map((projected) => projected.face)).toEqual([face.face]);
    }
  });
});

describe("view cube projection", () => {
  it("shows top, front, and left from the default isometric view, nearest face last", () => {
    const cube = projectViewCube(orbitCameraBasis(defaultYaw, defaultPitch));
    const faces = cube.faces.map((face) => face.face);
    expect(faces).toHaveLength(3);
    expect(new Set(faces)).toEqual(new Set<ViewCubeFace>(["top", "front", "left"]));
    for (const face of cube.faces) expect(face.facing).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(describeOrientation(defaultYaw, defaultPitch)).toBe("isometric");
    expect(orientationCaption(describeOrientation(defaultYaw, defaultPitch))).toBe("Isometric");
  });

  it("never mirrors a visible label", () => {
    for (let yaw = -Math.PI; yaw <= Math.PI; yaw += Math.PI / 7) {
      for (let pitch = -Math.PI / 2; pitch <= Math.PI / 2; pitch += Math.PI / 9) {
        const cube = projectViewCube(orbitCameraBasis(yaw, pitch));
        expect(cube.faces.length).toBeGreaterThanOrEqual(1);
        expect(cube.faces.length).toBeLessThanOrEqual(3);
        for (const face of cube.faces) {
          const [a, b, c, d] = parseMatrix(face.labelTransform);
          // Text-local x and y (down) map through the matrix; in SVG's
          // downward-y plane an unmirrored frame keeps a positive determinant.
          expect((a ?? 0) * (d ?? 0) - (b ?? 0) * (c ?? 0)).toBeGreaterThan(0);
          expect(face.points).toHaveLength(4);
        }
      }
    }
  });

  it("places the front label upright and unrotated in the front view", () => {
    const { yaw, pitch } = viewCubeFaceOrientations.front;
    const [front] = projectViewCube(orbitCameraBasis(yaw, pitch)).faces;
    expect(front?.points).toEqual([
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ]);
    const [a, b, c, d, e, f] = parseMatrix(front?.labelTransform ?? "");
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
    expect(c).toBe(0);
    expect(d).toBe(a);
    expect([e, f]).toEqual([0, 0]);
  });
});

describe("orientation naming", () => {
  it("distinguishes faces, isometric corners, and oblique views", () => {
    expect(describeOrientation(0, 0)).toBe("front");
    expect(describeOrientation(0.001, 0)).toBe("front");
    expect(describeOrientation(0.02, 0)).toBe("oblique");
    expect(describeOrientation(Math.PI / 4, defaultPitch)).toBe("isometric");
    expect(describeOrientation(Math.PI / 4, -defaultPitch)).toBe("isometric");
    expect(describeOrientation(Math.PI / 4, 0.2)).toBe("oblique");
    expect(isViewCubeFace("top")).toBe(true);
    expect(isViewCubeFace("Top")).toBe(false);
    expect(isViewCubeFace(null)).toBe(false);
  });

  it("follows the camera through a face snap that keeps pan and zoom", () => {
    const camera = new OrthographicOrbitCamera(bounds);
    camera.pan(30, -20, 300, 200, 1.5);
    camera.zoomBy(-400);
    const before = camera.state();
    camera.setOrientation(viewCubeFaceOrientations.top.yaw, viewCubeFaceOrientations.top.pitch);
    const after = camera.state();
    expect(describeOrientation(after.yaw, after.pitch)).toBe("top");
    expect(after.panRight).toBe(before.panRight);
    expect(after.panUp).toBe(before.panUp);
    expect(after.zoom).toBe(before.zoom);
    expect(projectViewCube(camera.basis()).faces.map((face) => face.face)).toEqual(["top"]);
  });
});

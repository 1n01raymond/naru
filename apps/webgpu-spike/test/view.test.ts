import { describe, expect, it } from "vitest";

import { OrthographicOrbitCamera, createCompiledSceneCamera, orbitCameraBasis } from "../src/view.js";

const bounds = { min: [-0.048, 0, -0.028], max: [0.048, 0.022, 0.028] } as const;

type Point = readonly [number, number, number];

/** Applies the orthographic view projection (w stays 1) to a world point. */
function project(matrix: Float32Array, point: Point): Point {
  const m = (index: number): number => matrix[index] ?? 0;
  return [
    m(0) * point[0] + m(4) * point[1] + m(8) * point[2] + m(12),
    m(1) * point[0] + m(5) * point[1] + m(9) * point[2] + m(13),
    m(2) * point[0] + m(6) * point[1] + m(10) * point[2] + m(14),
  ];
}

function axis(matrix: Float32Array, column: number): Point {
  const m = (index: number): number => matrix[index] ?? 0;
  return [m(column), m(column + 4), m(column + 8)];
}

function cross(a: Point, b: Point): Point {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Point, b: Point): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("compiled scene camera", () => {
  it("fits finite Y-up metre bounds", () => {
    const camera = createCompiledSceneCamera(bounds, 16 / 9);

    expect(camera).toHaveLength(16);
    expect(Array.from(camera).every(Number.isFinite)).toBe(true);
  });

  it("changes the matrix for orbit, pan, and zoom and restores fit", () => {
    const camera = new OrthographicOrbitCamera(bounds);
    const initial = Array.from(camera.viewProjection(16 / 9));

    camera.orbit(40, -20);
    expect(Array.from(camera.viewProjection(16 / 9))).not.toEqual(initial);
    camera.reset();
    expect(Array.from(camera.viewProjection(16 / 9))).toEqual(initial);

    camera.pan(50, -25, 1_000, 500, 2);
    expect(Array.from(camera.viewProjection(2))).not.toEqual(
      Array.from(createCompiledSceneCamera(bounds, 2)),
    );
    camera.fit();
    expect(Array.from(camera.viewProjection(2))).toEqual(
      Array.from(createCompiledSceneCamera(bounds, 2)),
    );

    camera.zoomBy(-120);
    expect(camera.viewProjection(2)[0] ?? 0).toBeGreaterThan(
      createCompiledSceneCamera(bounds, 2)[0] ?? 0,
    );
  });

  it("frames a storey's bounds and returns to the scene bounds", () => {
    const camera = new OrthographicOrbitCamera(bounds);
    const whole = Array.from(camera.viewProjection(2));

    camera.frameBounds({ min: [-0.01, 0.01, -0.01], max: [0.01, 0.022, 0.01] });
    const storey = Array.from(camera.viewProjection(2));
    expect(storey).not.toEqual(whole);
    expect(storey[0] ?? 0).toBeGreaterThan(whole[0] ?? 0);
    expect(camera.state()).toEqual(new OrthographicOrbitCamera(bounds).state());

    camera.frameBounds(undefined);
    expect(Array.from(camera.viewProjection(2))).toEqual(whole);
    expect(() => camera.frameBounds({ min: [1, 0, 0], max: [0, 1, 1] })).toThrow(
      /ordered finite values/u,
    );
  });

  it("rejects invalid scene bounds", () => {
    expect(
      () => new OrthographicOrbitCamera({ min: [1, 0, 0], max: [0, 1, 1] }),
    ).toThrow(/ordered finite values/u);
  });

  it("produces the same relative frame for millimetre geometry at a large offset", () => {
    const offset = [10_000_000, -7_000_000, 3_000_000] as const;
    const translated = {
      min: bounds.min.map((value, axis) => value + (offset[axis] ?? 0)) as [number, number, number],
      max: bounds.max.map((value, axis) => value + (offset[axis] ?? 0)) as [number, number, number],
    };
    const near = new OrthographicOrbitCamera(bounds);
    const far = new OrthographicOrbitCamera(translated);

    for (const camera of [near, far]) {
      camera.orbit(40, -20);
      camera.pan(25, -10, 1_000, 500, 2);
      camera.zoomBy(-120);
    }
    const nearFrame = near.frame(2);
    const farFrame = far.frame(2);

    expect(Array.from(farFrame.viewProjection)).toEqual(Array.from(nearFrame.viewProjection));
    expect(farFrame.origin.map((value, axis) => value - (nearFrame.origin[axis] ?? 0)))
      .toEqual(offset);
  });
});

describe("default view orientation", () => {
  const building = { min: [-10, 0, -10], max: [10, 12, 10] } as const;

  it("looks down from above: the higher of two stacked points is nearer the eye", () => {
    const matrix = createCompiledSceneCamera(building, 1);
    const roof = project(matrix, [0, 12, 0]);
    const floor = project(matrix, [0, 0, 0]);

    expect(roof[1]).toBeGreaterThan(floor[1]);
    expect(roof[2]).toBeLessThan(floor[2]);
    for (const clip of [roof, floor]) {
      expect(clip[2]).toBeGreaterThan(0);
      expect(clip[2]).toBeLessThan(1);
    }
  });

  it("projects an unmirrored right-handed frame", () => {
    const matrix = createCompiledSceneCamera(building, 1);
    const right = axis(matrix, 0);
    const up = axis(matrix, 1);
    const depth = axis(matrix, 2);

    expect(dot(cross(right, up), depth)).toBeLessThan(0);
    expect(right[1]).toBe(0);
    expect(up[1]).toBeGreaterThan(0);
    expect(depth[1]).toBeLessThan(0);
  });

  it("drags the eye higher when the pointer moves down", () => {
    const camera = new OrthographicOrbitCamera(building);
    const before = axis(camera.viewProjection(1), 2);
    camera.orbit(0, 100);
    const after = axis(camera.viewProjection(1), 2);
    const elevation = (depth: Point): number => -depth[1] / Math.hypot(...depth);

    expect(elevation(after)).toBeGreaterThan(elevation(before));
    expect(elevation(before)).toBeCloseTo(1 / Math.sqrt(3), 6);
  });
});

describe("orbit camera poles", () => {
  const bounds = { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };

  it("keeps the frame continuous through the top view", () => {
    const nearPole = orbitCameraBasis(0.3, Math.PI / 2 - 1e-7);
    const pole = orbitCameraBasis(0.3, Math.PI / 2);
    for (const axis of ["right", "up", "depth"] as const) {
      nearPole[axis].forEach((value, index) => expect(pole[axis][index]).toBeCloseTo(value, 5));
    }
    expect(pole.right).toEqual([Math.cos(0.3), 0, -Math.sin(0.3)]);
    expect(pole.up.every(Number.isFinite)).toBe(true);
  });

  it("orbits up to, and restores no further than, the poles", () => {
    const camera = new OrthographicOrbitCamera(bounds);
    camera.orbit(0, 10_000);
    expect(camera.state().pitch).toBe(Math.PI / 2);
    camera.orbit(0, -20_000);
    expect(camera.state().pitch).toBe(-Math.PI / 2);
    camera.restore({ yaw: 0, pitch: 9, panRight: 0, panUp: 0, zoom: 1 });
    expect(camera.state().pitch).toBe(Math.PI / 2);
    camera.setOrientation(1, Number.NaN);
    expect(camera.state()).toMatchObject({ yaw: 0, pitch: Math.PI / 2 });
  });
});

import { describe, expect, it } from "vitest";

import { OrthographicOrbitCamera, createCompiledSceneCamera } from "../src/view.js";

const bounds = { min: [-0.048, 0, -0.028], max: [0.048, 0.022, 0.028] } as const;

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

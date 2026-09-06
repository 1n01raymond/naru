import { describe, expect, it } from "vitest";

import {
  DistanceMeasurement,
  formatLength,
  formatMeasurement,
  measureDistance,
  projectToClient,
} from "../src/measurement.js";
import { OrthographicOrbitCamera } from "../src/view.js";

describe("distance measurement", () => {
  it("collects two points and reports the metre distance with axis deltas", () => {
    const measurement = new DistanceMeasurement();
    expect(measurement.state()).toEqual({ kind: "idle" });
    expect(measurement.active()).toBe(false);

    measurement.arm();
    expect(measurement.state()).toEqual({ kind: "armed" });
    expect(measurement.active()).toBe(true);

    expect(measurement.addPoint([1, 2, 3])).toEqual({ kind: "first", start: [1, 2, 3] });
    const complete = measurement.addPoint([4, 6, 15]);
    expect(complete).toEqual({
      kind: "complete",
      start: [1, 2, 3],
      end: [4, 6, 15],
      distance: 13,
      delta: [3, 4, 12],
    });
  });

  it("starts a new measurement on the third click and clears on toggle", () => {
    const measurement = new DistanceMeasurement();
    measurement.arm();
    measurement.addPoint([0, 0, 0]);
    measurement.addPoint([1, 0, 0]);
    expect(measurement.addPoint([5, 5, 5])).toEqual({ kind: "first", start: [5, 5, 5] });

    measurement.toggle();
    expect(measurement.state()).toEqual({ kind: "idle" });
    measurement.toggle();
    expect(measurement.state()).toEqual({ kind: "armed" });
  });

  it("freezes the points it stores and refuses non-finite input", () => {
    const measurement = new DistanceMeasurement();
    measurement.arm();
    const point: [number, number, number] = [1, 1, 1];
    measurement.addPoint(point);
    point[0] = 99;
    expect(measurement.state()).toEqual({ kind: "first", start: [1, 1, 1] });
    expect(() => measurement.addPoint([Number.NaN, 0, 0])).toThrow(RangeError);
    expect(measurement.state()).toEqual({ kind: "first", start: [1, 1, 1] });
  });

  it("arms only from idle so a click sequence survives repeated arm calls", () => {
    const measurement = new DistanceMeasurement();
    measurement.arm();
    measurement.addPoint([2, 2, 2]);
    measurement.arm();
    expect(measurement.state()).toEqual({ kind: "first", start: [2, 2, 2] });
  });

  it("measures a distance without touching its inputs", () => {
    expect(measureDistance([0, 0, 0], [0, 3, 4])).toEqual({ distance: 5, delta: [0, 3, 4] });
    expect(measureDistance([1, 1, 1], [1, 1, 1])).toEqual({ distance: 0, delta: [0, 0, 0] });
  });
});

describe("measurement formatting", () => {
  it("chooses millimetres, metres, or kilometres by magnitude", () => {
    expect(formatLength(0.0125)).toBe("12.5 mm");
    expect(formatLength(-0.5)).toBe("-500.0 mm");
    expect(formatLength(3.14159)).toBe("3.142 m");
    expect(formatLength(12_345.678)).toBe("12.346 km");
    expect(() => formatLength(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("describes every state for the HUD", () => {
    expect(formatMeasurement({ kind: "idle" })).toBe("");
    expect(formatMeasurement({ kind: "armed" })).toBe("Measure: click the first surface point.");
    expect(formatMeasurement({ kind: "first", start: [0, 0, 0] })).toBe(
      "Measure: click the second surface point.",
    );
    expect(
      formatMeasurement({
        kind: "complete",
        start: [0, 0, 0],
        end: [3, 0.4, -12],
        distance: 12.375,
        delta: [3, 0.4, -12],
      }),
    ).toBe("Distance 12.375 m · ΔX 3.000 m · ΔY 400.0 mm · ΔZ -12.000 m");
  });
});

describe("projecting measured points onto the canvas", () => {
  const bounds = { min: [-10, -5, -2], max: [10, 5, 2] } as const;

  it("puts the orbit target at the canvas centre through the camera's own frame", () => {
    const camera = new OrthographicOrbitCamera(bounds);
    const frame = camera.frame(2);
    const projected = projectToClient(frame.viewProjection, frame.origin, [0, 0, 0], 800, 400);
    expect(projected).toBeDefined();
    expect(projected?.x).toBeCloseTo(400, 6);
    expect(projected?.y).toBeCloseTo(200, 6);
    expect(projected?.depth).toBeGreaterThan(0);
    expect(projected?.depth).toBeLessThan(1);
  });

  it("moves with the camera origin so far-away points keep their pixel", () => {
    const far = { min: [9_999_990, -5, -2], max: [10_000_010, 5, 2] } as const;
    const camera = new OrthographicOrbitCamera(far);
    const frame = camera.frame(1);
    expect(frame.origin[0]).not.toBe(0);
    const projected = projectToClient(frame.viewProjection, frame.origin, [10_000_000, 0, 0], 500, 500);
    expect(projected?.x).toBeCloseTo(250, 6);
    expect(projected?.y).toBeCloseTo(250, 6);
  });

  it("maps a screen-aligned identity frame linearly and rejects points behind w", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(projectToClient(identity, [0, 0, 0], [1, 1, 0.5], 200, 100)).toEqual({
      x: 200,
      y: 0,
      depth: 0.5,
    });
    const perspective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0];
    expect(projectToClient(perspective, [0, 0, 0], [0, 0, 1], 200, 100)).toBeUndefined();
    expect(() => projectToClient([1, 2, 3], [0, 0, 0], [0, 0, 0], 1, 1)).toThrow(RangeError);
  });
});

/**
 * Two-click distance measurement between picked surface points.
 *
 * The module owns no DOM and no GPU: the renderer resolves a click into a
 * world-space point, this state machine collects two of them, and `main.ts`
 * draws the result. Packages are metre-scaled (the compiler refuses a Scene IR
 * without a positive `scaleToMeters`), so every length here is in metres.
 */

export type MeasuredPoint = readonly [number, number, number];

export interface MeasuredDistance {
  readonly distance: number;
  readonly delta: MeasuredPoint;
}

export type MeasurementState =
  | { readonly kind: "idle" }
  | { readonly kind: "armed" }
  | { readonly kind: "first"; readonly start: MeasuredPoint }
  | {
      readonly kind: "complete";
      readonly start: MeasuredPoint;
      readonly end: MeasuredPoint;
      readonly distance: number;
      readonly delta: MeasuredPoint;
    };

export function measureDistance(start: MeasuredPoint, end: MeasuredPoint): MeasuredDistance {
  const delta: MeasuredPoint = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  return { distance: Math.hypot(delta[0], delta[1], delta[2]), delta };
}

export class DistanceMeasurement {
  private current: MeasurementState = { kind: "idle" };

  state(): MeasurementState {
    return this.current;
  }

  /** True while clicks should measure instead of select. */
  active(): boolean {
    return this.current.kind !== "idle";
  }

  arm(): void {
    if (this.current.kind === "idle") this.current = { kind: "armed" };
  }

  clear(): void {
    this.current = { kind: "idle" };
  }

  toggle(): void {
    if (this.current.kind === "idle") this.arm();
    else this.clear();
  }

  /** Records a picked point; a third click starts a new measurement. */
  addPoint(point: MeasuredPoint): MeasurementState {
    if (!point.every((value) => Number.isFinite(value))) {
      throw new RangeError("A measured point must have finite coordinates.");
    }
    const frozen: MeasuredPoint = [point[0], point[1], point[2]];
    if (this.current.kind === "first") {
      this.current = { kind: "complete", start: this.current.start, end: frozen, ...measureDistance(this.current.start, frozen) };
    } else {
      this.current = { kind: "first", start: frozen };
    }
    return this.current;
  }
}

/** Formats a length in metres for the HUD: millimetres below one metre. */
export function formatLength(meters: number): string {
  if (!Number.isFinite(meters)) throw new RangeError("A length must be finite.");
  const magnitude = Math.abs(meters);
  if (magnitude < 1) return `${(meters * 1000).toFixed(1)} mm`;
  if (magnitude < 1000) return `${meters.toFixed(3)} m`;
  return `${(meters / 1000).toFixed(3)} km`;
}

export function formatMeasurement(state: MeasurementState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "armed":
      return "Measure: click the first surface point.";
    case "first":
      return "Measure: click the second surface point.";
    case "complete": {
      const [dx, dy, dz] = state.delta;
      return (
        `Distance ${formatLength(state.distance)} · ` +
        `ΔX ${formatLength(dx)} · ΔY ${formatLength(dy)} · ΔZ ${formatLength(dz)}`
      );
    }
  }
}

export interface ClientPoint {
  readonly x: number;
  readonly y: number;
  /** Normalized device depth in 0..1 (WebGPU clip convention). */
  readonly depth: number;
}

/**
 * Projects a world point through a camera-relative frame onto CSS pixels of a
 * `width` x `height` canvas. `viewProjection` is the column-major matrix the
 * renderer receives and `origin` is the frame's camera origin, so the
 * subtraction happens in JavaScript numbers exactly as the renderer does it.
 * Returns undefined when the point is behind the projection (w <= 0).
 */
export function projectToClient(
  viewProjection: ArrayLike<number>,
  origin: MeasuredPoint,
  point: MeasuredPoint,
  width: number,
  height: number,
): ClientPoint | undefined {
  if (viewProjection.length !== 16) throw new RangeError("A view-projection matrix has 16 entries.");
  const x = point[0] - origin[0];
  const y = point[1] - origin[1];
  const z = point[2] - origin[2];
  const m = (index: number): number => viewProjection[index] ?? 0;
  const clipX = m(0) * x + m(4) * y + m(8) * z + m(12);
  const clipY = m(1) * x + m(5) * y + m(9) * z + m(13);
  const clipZ = m(2) * x + m(6) * y + m(10) * z + m(14);
  const clipW = m(3) * x + m(7) * y + m(11) * z + m(15);
  if (!(clipW > 0)) return undefined;
  return {
    x: ((clipX / clipW + 1) / 2) * width,
    y: ((1 - clipY / clipW) / 2) * height,
    depth: clipZ / clipW,
  };
}

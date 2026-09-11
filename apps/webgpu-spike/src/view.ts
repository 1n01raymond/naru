import type { SceneBounds } from "@naru3d/runtime-webgpu";

export type Vector3 = readonly [number, number, number];

export interface CameraRelativeFrame {
  readonly viewProjection: Float32Array;
  readonly origin: Vector3;
}

/** The navigation numbers a saved workspace carries, in camera units. */
export interface OrbitCameraState {
  readonly yaw: number;
  readonly pitch: number;
  readonly panRight: number;
  readonly panUp: number;
  readonly zoom: number;
}

// The eye sits 45 degrees off the Z axis and asin(1 / sqrt 3) = 35.26 degrees
// above the horizon: the classic isometric view, looking down at the model.
const defaultYaw = -Math.PI / 4;
const defaultPitch = Math.asin(1 / Math.sqrt(3));
/** Pitch is limited to the poles so a true top or bottom view exists. */
const maximumPitch = Math.PI / 2;
const minimumScale = 0.000_001;
const poleTolerance = 1e-9;

function assertOrderedFiniteBounds(bounds: SceneBounds): void {
  const values = [...bounds.min, ...bounds.max];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    bounds.min.some((value, axis) => value > (bounds.max[axis] ?? -Infinity))
  ) {
    throw new TypeError("Scene bounds must contain ordered finite values.");
  }
}

function boundsCenter(bounds: SceneBounds): Vector3 {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

function boundsCorners(bounds: SceneBounds): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

function dot(axis: Vector3, point: Vector3): number {
  return axis[0] * point[0] + axis[1] * point[1] + axis[2] * point[2];
}

function finiteAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export interface CameraBasis {
  /** The unit vector from the framed target toward the viewer. */
  readonly towardEye: Vector3;
  /** Screen right, horizontal in world space. */
  readonly right: Vector3;
  /** Screen up; carries a positive world +Y component. */
  readonly up: Vector3;
  /** The viewing direction: clip depth grows along it, away from the eye. */
  readonly depth: Vector3;
}

/**
 * Builds the view frame for an orbit orientation.
 *
 * `towardEye` points from the framed target to the viewer: a positive pitch
 * lifts the eye above the horizon, so the default view looks down onto the
 * model. `right` stays horizontal and `up = towardEye x right` keeps world +Y
 * pointing up the screen. `depth` is the direction the viewer looks along, the
 * negation of `towardEye`, so clip depth grows away from the eye and
 * `right x up` points back at the viewer: a right-handed, unmirrored frame in
 * which the surface nearest the eye wins the depth test.
 *
 * At the poles (`pitch = +-pi/2`) `towardEye` has no horizontal part, so
 * `right` takes its limit `(cos yaw, 0, -sin yaw)`: the frame stays continuous
 * through a top or bottom view instead of dividing by zero.
 */
export function orbitCameraBasis(yaw: number, pitch: number): CameraBasis {
  const cosinePitch = Math.cos(pitch);
  const towardEye: Vector3 = [
    Math.sin(yaw) * cosinePitch,
    Math.sin(pitch),
    Math.cos(yaw) * cosinePitch,
  ];
  const horizontalLength = Math.hypot(towardEye[0], towardEye[2]);
  const right: Vector3 =
    horizontalLength < poleTolerance
      ? [Math.cos(yaw), 0, -Math.sin(yaw)]
      : [towardEye[2] / horizontalLength, 0, -towardEye[0] / horizontalLength];
  const up: Vector3 = [
    towardEye[1] * right[2],
    towardEye[2] * right[0] - towardEye[0] * right[2],
    -towardEye[1] * right[0],
  ];
  const depth: Vector3 = [-towardEye[0], -towardEye[1], -towardEye[2]];
  return { towardEye, right, up, depth };
}

/**
 * Small orthographic CAD camera used by the Phase 1 Studio slice.
 *
 * It keeps navigation state independent of the renderer, so fit/orbit/pan/zoom
 * can later be reused by a framework-neutral viewer shell.
 */
export class OrthographicOrbitCamera {
  private readonly sceneBounds: SceneBounds;
  private corners: readonly Vector3[];
  private center: Vector3;
  private yaw = defaultYaw;
  private pitch = defaultPitch;
  private panRight = 0;
  private panUp = 0;
  private zoom = 1;
  private fittedHalfWidth = 1;
  private fittedHalfHeight = 1;

  constructor(bounds: SceneBounds) {
    assertOrderedFiniteBounds(bounds);
    this.sceneBounds = { min: [...bounds.min], max: [...bounds.max] };
    this.corners = boundsCorners(bounds);
    this.center = boundsCenter(bounds);
    this.fit();
  }

  /**
   * Replaces the framed extents (a storey's bounds, for example) and fits the
   * view to them while keeping the view direction. `undefined` returns to the
   * constructed scene bounds. Framing is view state: `state()` still carries
   * navigation only, so a saved workspace reopens against the scene extents.
   */
  frameBounds(bounds: SceneBounds | undefined): void {
    const framed = bounds ?? this.sceneBounds;
    assertOrderedFiniteBounds(framed);
    this.corners = boundsCorners(framed);
    this.center = boundsCenter(framed);
    this.fit();
  }

  /** The navigation state a workspace persists; framing extents stay derived. */
  state(): OrbitCameraState {
    return {
      yaw: this.yaw,
      pitch: this.pitch,
      panRight: this.panRight,
      panUp: this.panUp,
      zoom: this.zoom,
    };
  }

  /**
   * Reapplies persisted navigation without refitting.
   *
   * Fitted extents are derived from the bounds this camera is currently
   * framing (the constructed scene bounds unless `frameBounds` replaced them;
   * a storey frame is not persisted), so a reopened package frames itself at
   * the same scale a fresh one does. Orbiting never refits either, which makes the round trip exact for
   * the ordinary path. A view that was fitted at a non-default orientation and
   * then orbited restores its direction, pan, and zoom but reframes at the
   * constructed scale, because the manifest carries navigation, not extents.
   *
   * Pitch and zoom are clamped to the interactive range so a hand-edited
   * manifest cannot place the camera where orbiting and zooming cannot.
   */
  restore(state: OrbitCameraState): void {
    const { yaw, pitch, panRight, panUp, zoom } = state;
    if (![yaw, pitch, panRight, panUp, zoom].every((value) => Number.isFinite(value))) {
      throw new TypeError("Camera state must contain finite values.");
    }
    this.yaw = yaw;
    this.pitch = clamp(pitch, -maximumPitch, maximumPitch);
    this.panRight = panRight;
    this.panUp = panUp;
    this.zoom = clamp(zoom, 0.05, 100);
  }

  /** Restores the default view (eye above, looking down at the model) and frames the complete scene. */
  reset(): void {
    this.yaw = defaultYaw;
    this.pitch = defaultPitch;
    this.fit();
  }

  /** Frames the complete scene while preserving the current view direction. */
  fit(): void {
    const { right, up } = orbitCameraBasis(this.yaw, this.pitch);
    const projectedX = this.corners.map((corner) => dot(right, corner));
    const projectedY = this.corners.map((corner) => dot(up, corner));
    this.fittedHalfWidth = Math.max(
      (Math.max(...projectedX) - Math.min(...projectedX)) * 0.58,
      minimumScale,
    );
    this.fittedHalfHeight = Math.max(
      (Math.max(...projectedY) - Math.min(...projectedY)) * 0.58,
      minimumScale,
    );
    this.panRight = 0;
    this.panUp = 0;
    this.zoom = 1;
  }

  orbit(deltaX: number, deltaY: number): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.setOrientation(this.yaw + deltaX * 0.006, this.pitch + deltaY * 0.006);
  }

  /**
   * Turns the view to an orientation (a view-cube face, for example) while
   * keeping pan and zoom, exactly as orbiting does. Pitch is clamped to the
   * poles; yaw is taken as given, so a caller can pick the yaw a face reads
   * upright from.
   */
  setOrientation(yaw: number, pitch: number): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.yaw = yaw;
    this.pitch = clamp(pitch, -maximumPitch, maximumPitch);
  }

  /** The current view direction, for anything that draws relative to it. */
  basis(): CameraBasis {
    return orbitCameraBasis(this.yaw, this.pitch);
  }

  pan(deltaX: number, deltaY: number, width: number, height: number, aspect: number): void {
    if (
      !Number.isFinite(deltaX) ||
      !Number.isFinite(deltaY) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return;
    }
    const { halfWidth, halfHeight } = this.halfExtents(aspect);
    this.panRight -= (deltaX / width) * halfWidth * 2;
    this.panUp += (deltaY / height) * halfHeight * 2;
  }

  zoomBy(deltaY: number): void {
    if (!Number.isFinite(deltaY)) return;
    this.zoom = clamp(this.zoom * Math.exp(-deltaY * 0.0015), 0.05, 100);
  }

  viewProjection(aspect: number): Float32Array {
    return this.projection(aspect, [0, 0, 0]).viewProjection;
  }

  /**
   * World metres covered by one viewport pixel.
   *
   * The projection is orthographic, so the scale is uniform over the frame and
   * a screen-space error is simply a world deviation divided by this number.
   * A viewport with no height reports `Infinity`: nothing is drawn at that
   * size, and the level selector treats the sentinel as "no new measurement"
   * rather than dividing it into a deceptively small pixel error.
   */
  metresPerPixel(aspect: number, viewportHeightPx: number): number {
    if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return Infinity;
    return (this.halfExtents(aspect).halfHeight * 2) / viewportHeightPx;
  }

  /** Builds a stable f32 projection around a double-precision camera origin. */
  frame(aspect: number): CameraRelativeFrame {
    const { right, up } = orbitCameraBasis(this.yaw, this.pitch);
    const target: Vector3 = [
      this.center[0] + right[0] * this.panRight + up[0] * this.panUp,
      this.center[1] + right[1] * this.panRight + up[1] * this.panUp,
      this.center[2] + right[2] * this.panRight + up[2] * this.panUp,
    ];
    return this.projection(aspect, target);
  }

  private projection(aspect: number, origin: Vector3): CameraRelativeFrame {
    const { right, up, depth } = orbitCameraBasis(this.yaw, this.pitch);
    const { halfWidth, halfHeight } = this.halfExtents(aspect);
    const target: Vector3 = [
      this.center[0] + right[0] * this.panRight + up[0] * this.panUp - origin[0],
      this.center[1] + right[1] * this.panRight + up[1] * this.panUp - origin[1],
      this.center[2] + right[2] * this.panRight + up[2] * this.panUp - origin[2],
    ];
    const projectedDepth = this.corners.map((corner) =>
      dot(depth, [
        corner[0] - origin[0],
        corner[1] - origin[1],
        corner[2] - origin[2],
      ]),
    );
    const minDepth = Math.min(...projectedDepth);
    const maxDepth = Math.max(...projectedDepth);
    const depthPadding = Math.max((maxDepth - minDepth) * 0.08, minimumScale);
    const nearDepth = minDepth - depthPadding;
    const depthRange = Math.max(maxDepth - minDepth + depthPadding * 2, minimumScale);

    return {
      origin,
      viewProjection: new Float32Array([
        right[0] / halfWidth,
        up[0] / halfHeight,
        depth[0] / depthRange,
        0,
        right[1] / halfWidth,
        up[1] / halfHeight,
        depth[1] / depthRange,
        0,
        right[2] / halfWidth,
        up[2] / halfHeight,
        depth[2] / depthRange,
        0,
        -dot(right, target) / halfWidth,
        -dot(up, target) / halfHeight,
        -nearDepth / depthRange,
        1,
      ]),
    };
  }

  private halfExtents(aspect: number): { readonly halfWidth: number; readonly halfHeight: number } {
    const safeAspect = finiteAspect(aspect);
    const halfHeight =
      Math.max(this.fittedHalfHeight, this.fittedHalfWidth / safeAspect) / this.zoom;
    return { halfWidth: halfHeight * safeAspect, halfHeight };
  }
}

/** Fits a right-handed, Y-up glTF scene into WebGPU's 0..1 depth range. */
export function createCompiledSceneCamera(
  bounds: SceneBounds,
  aspect: number,
): Float32Array {
  return new OrthographicOrbitCamera(bounds).viewProjection(aspect);
}

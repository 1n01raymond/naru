/**
 * The view cube: a small cube drawn in the corner of the viewport whose faces
 * are labelled Top, Front, Right and so on, projected through the same
 * orthographic frame the model uses. It rotates with the camera, names the
 * current orientation, and turns the camera to a face when that face is
 * clicked.
 *
 * The module owns no DOM: it projects the cube into 2D polygons and label
 * transforms, classifies an orientation, and knows which yaw and pitch look
 * squarely at each face. `main.ts` draws the result as SVG.
 */

import { orbitCameraBasis, type CameraBasis, type Vector3 } from "./view.js";

export type ViewCubeFace = "front" | "back" | "left" | "right" | "top" | "bottom";

/** A face name when the view looks squarely at one, else how far off it is. */
export type ViewOrientation = ViewCubeFace | "isometric" | "oblique";

export interface ViewCubeFaceDefinition {
  readonly face: ViewCubeFace;
  readonly label: string;
  /** Outward unit normal of the face in world space (Y up, Z toward the viewer). */
  readonly normal: Vector3;
  /** The direction the label reads along, in world space. */
  readonly textRight: Vector3;
  /** The direction the label stands up along; `textRight x textUp = normal`. */
  readonly textUp: Vector3;
}

export interface ProjectedViewCubeFace {
  readonly face: ViewCubeFace;
  readonly label: string;
  /** Corner positions in SVG units (y grows downward), a square of side 2. */
  readonly points: readonly (readonly [number, number])[];
  /** SVG `transform` placing an upright, unmirrored label at the face centre. */
  readonly labelTransform: string;
  /** `normal . towardEye`: 1 when the face looks straight at the viewer. */
  readonly facing: number;
}

export interface ProjectedViewCube {
  /** Visible faces, painted back to front. Never more than three. */
  readonly faces: readonly ProjectedViewCubeFace[];
}

/**
 * The six faces. Labels read along `textRight` and stand along `textUp`, and
 * `textRight x textUp` equals the outward normal for every face, which is what
 * keeps a visible label unmirrored (see `projectViewCube`). The front face is
 * +Z, the default glTF viewing side; Top reads with its top toward -Z, so a
 * plan view from above with the default yaw of zero shows it upright.
 */
export const viewCubeFaces: readonly ViewCubeFaceDefinition[] = [
  { face: "front", label: "Front", normal: [0, 0, 1], textRight: [1, 0, 0], textUp: [0, 1, 0] },
  { face: "back", label: "Back", normal: [0, 0, -1], textRight: [-1, 0, 0], textUp: [0, 1, 0] },
  { face: "right", label: "Right", normal: [1, 0, 0], textRight: [0, 0, -1], textUp: [0, 1, 0] },
  { face: "left", label: "Left", normal: [-1, 0, 0], textRight: [0, 0, 1], textUp: [0, 1, 0] },
  { face: "top", label: "Top", normal: [0, 1, 0], textRight: [1, 0, 0], textUp: [0, 0, -1] },
  { face: "bottom", label: "Bottom", normal: [0, -1, 0], textRight: [1, 0, 0], textUp: [0, 0, 1] },
];

/** The orbit orientation that looks squarely at a face with its label upright. */
export const viewCubeFaceOrientations: Readonly<
  Record<ViewCubeFace, { readonly yaw: number; readonly pitch: number }>
> = {
  front: { yaw: 0, pitch: 0 },
  back: { yaw: Math.PI, pitch: 0 },
  right: { yaw: Math.PI / 2, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 },
  top: { yaw: 0, pitch: Math.PI / 2 },
  bottom: { yaw: 0, pitch: -Math.PI / 2 },
};

/** Half a degree: closer than this to a face normal counts as that face. */
/** Faces whose normal is this close to perpendicular to the eye are hidden. */
const edgeOnTolerance = 1e-6;

export const defaultOrientationToleranceRadians = (0.5 * Math.PI) / 180;

const labelScale = 0.42;
const decimals = 4;

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function round(value: number): number {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function projectPoint(basis: CameraBasis, point: Vector3): readonly [number, number] {
  // Screen y grows upward in the camera frame and downward in SVG.
  return [round(dot(basis.right, point)), round(-dot(basis.up, point))];
}

/**
 * Projects the unit cube through a camera basis.
 *
 * A face is visible when its outward normal has a positive component toward
 * the eye. For such a face the projected label axes `(right . textRight,
 * up . textRight)` and `(right . textUp, up . textUp)` span a parallelogram
 * whose signed area is `normal . towardEye` (the triple product of the basis
 * with `textRight x textUp = normal`), so it is positive exactly when the face
 * is visible: the label transform below never mirrors a label the viewer can
 * see. Faces are returned back to front by their centre depth.
 */
export function projectViewCube(basis: CameraBasis): ProjectedViewCube {
  const faces: ProjectedViewCubeFace[] = [];
  for (const definition of viewCubeFaces) {
    const facing = dot(definition.normal, basis.towardEye);
    // An edge-on face projects to a line; floating-point residue such as
    // sin(pi) must not make it appear as a sliver with a degenerate label.
    if (facing <= edgeOnTolerance) continue;
    const { normal, textRight, textUp } = definition;
    const corners: Vector3[] = [];
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      corners.push([
        normal[0] + a * textRight[0] + b * textUp[0],
        normal[1] + a * textRight[1] + b * textUp[1],
        normal[2] + a * textRight[2] + b * textUp[2],
      ]);
    }
    const centre = projectPoint(basis, normal);
    // SVG matrix(a, b, c, d, e, f) maps text-local (x right, y down) to
    // (a x + c y + e, b x + d y + f); local x follows textRight and local
    // y (downward) follows -textUp, with the camera's up flipped for SVG.
    const rightX = dot(basis.right, textRight) * labelScale;
    const rightY = -dot(basis.up, textRight) * labelScale;
    const upX = dot(basis.right, textUp) * labelScale;
    const upY = -dot(basis.up, textUp) * labelScale;
    faces.push({
      face: definition.face,
      label: definition.label,
      points: corners.map((corner) => projectPoint(basis, corner)),
      labelTransform: `matrix(${[rightX, rightY, -upX, -upY, centre[0], centre[1]]
        .map((value) => String(round(value)))
        .join(" ")})`,
      facing,
    });
  }
  // The nearest face has the largest component toward the eye; paint it last.
  faces.sort((a, b) => a.facing - b.facing);
  return { faces };
}

const isometricDirections: readonly Vector3[] = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) =>
    [-1, 1].map((z): Vector3 => [x / Math.sqrt(3), y / Math.sqrt(3), z / Math.sqrt(3)]),
  ),
);

function withinTolerance(direction: Vector3, towardEye: Vector3, tolerance: number): boolean {
  // Both are unit vectors, so the dot product is the cosine of their angle.
  return dot(direction, towardEye) >= Math.cos(tolerance);
}

/**
 * Names the orientation: a face when the eye sits within `tolerance` of its
 * normal, `isometric` within tolerance of one of the eight corner directions
 * (the default view is exactly one), otherwise `oblique`.
 */
export function describeOrientation(
  yaw: number,
  pitch: number,
  tolerance = defaultOrientationToleranceRadians,
): ViewOrientation {
  const { towardEye } = orbitCameraBasis(yaw, pitch);
  for (const definition of viewCubeFaces) {
    if (withinTolerance(definition.normal, towardEye, tolerance)) return definition.face;
  }
  if (isometricDirections.some((direction) => withinTolerance(direction, towardEye, tolerance))) {
    return "isometric";
  }
  return "oblique";
}

/** Human-readable caption for the cube, capitalised like the face labels. */
export function orientationCaption(orientation: ViewOrientation): string {
  return orientation.charAt(0).toUpperCase() + orientation.slice(1);
}

export function isViewCubeFace(value: unknown): value is ViewCubeFace {
  return typeof value === "string" && viewCubeFaces.some((definition) => definition.face === value);
}

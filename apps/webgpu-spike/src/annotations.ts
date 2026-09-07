import type { WorkspaceAnnotation } from "@naru3d/workspace";

/**
 * Text notes anchored to picked surface points. The state machine mirrors the
 * distance measurement: `arm()` makes the next canvas click place an anchor,
 * the anchor waits for its text, and committing that text stores the note.
 * The Studio draws every note as an overlay label re-projected each frame and
 * persists the list through the workspace manifest (`naru.workspace.2`).
 */

export type AnnotationPoint = readonly [number, number, number];

export type AnnotationState =
  | { readonly kind: "idle" }
  | { readonly kind: "armed" }
  | { readonly kind: "pending"; readonly position: AnnotationPoint };

function assertFinitePoint(point: AnnotationPoint): AnnotationPoint {
  if (point.length !== 3 || point.some((value) => !Number.isFinite(value))) {
    throw new RangeError("An annotation anchor needs three finite coordinates.");
  }
  return [point[0], point[1], point[2]];
}

/** Trims and collapses internal whitespace; an empty result means "no note". */
export function normalizeAnnotationText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class AnnotationSet {
  private current: AnnotationState = { kind: "idle" };
  private readonly notes: WorkspaceAnnotation[] = [];
  private selectedIndex: number | undefined;

  state(): AnnotationState {
    return this.current;
  }

  /** True while a click on the canvas places an anchor instead of selecting. */
  active(): boolean {
    return this.current.kind !== "idle";
  }

  arm(): void {
    this.current = { kind: "armed" };
  }

  /** Leaves placement mode; a pending anchor is discarded, stored notes stay. */
  cancel(): void {
    this.current = { kind: "idle" };
  }

  toggle(): void {
    if (this.active()) {
      this.cancel();
    } else {
      this.arm();
    }
  }

  /** Records the picked anchor and waits for its text. */
  place(position: AnnotationPoint): AnnotationState {
    this.current = { kind: "pending", position: assertFinitePoint(position) };
    return this.current;
  }

  /**
   * Stores the pending anchor with its text and returns the note's index, or
   * undefined when nothing was pending or the text is blank. Either way the
   * set leaves placement mode.
   */
  commit(text: string): number | undefined {
    const pending = this.current;
    this.current = { kind: "idle" };
    const normalized = normalizeAnnotationText(text);
    if (pending.kind !== "pending" || normalized === "") {
      return undefined;
    }
    this.notes.push({ position: pending.position, text: normalized });
    this.selectedIndex = this.notes.length - 1;
    return this.selectedIndex;
  }

  list(): readonly WorkspaceAnnotation[] {
    return this.notes;
  }

  selected(): number | undefined {
    return this.selectedIndex;
  }

  select(index: number | undefined): void {
    this.selectedIndex =
      index !== undefined && Number.isInteger(index) && index >= 0 && index < this.notes.length
        ? index
        : undefined;
  }

  /** Removes the selected note, if any, and returns whether one was removed. */
  removeSelected(): boolean {
    if (this.selectedIndex === undefined) {
      return false;
    }
    this.notes.splice(this.selectedIndex, 1);
    this.selectedIndex = undefined;
    return true;
  }

  /** Replaces every note, in the given order, and clears the selection. */
  restore(annotations: readonly WorkspaceAnnotation[]): void {
    this.notes.length = 0;
    for (const annotation of annotations) {
      this.notes.push({
        position: assertFinitePoint(annotation.position),
        text: normalizeAnnotationText(annotation.text),
      });
    }
    this.selectedIndex = undefined;
    this.current = { kind: "idle" };
  }

  clear(): void {
    this.restore([]);
  }
}

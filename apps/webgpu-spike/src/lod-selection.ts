/**
 * Which geometry level the Studio draws for a shape that has both a declared
 * `reduced` level and its `target` tessellation (ADR-0025).
 *
 * Every reduced chunk declares the deviation its own geometry stays within, so
 * the decision is per chunk: a coarsely reduced shape returns to its exact
 * tessellation while a faithfully reduced one stays reduced in the same frame.
 * The Studio camera is orthographic, so one metres-per-pixel scale serves the
 * whole frame, but the bound each chunk divides by it is its own. Selection
 * never invents an error bound -- it only divides the bound the package
 * declares by the world size of a pixel.
 */
export type GeometryLevel = "reduced" | "target";

/** The little of a compiled chunk a substitution plan has to look at. */
export interface LevelChunk {
  readonly id: string;
  readonly prototypeIds: readonly string[];
  /** The deviation a reduced chunk declares, in metres; absent on target chunks. */
  readonly maxDeviationMeters?: number;
}

/**
 * Which reduced chunk stands in for which target chunk.
 *
 * The Studio keeps one scheduler over the target chunks -- ranking, demand
 * signatures, priorities, pinning, and eviction all stay keyed on the target
 * level -- and substitutes the level only when it fetches. The plan is the
 * whole of that substitution, and it is pure so the rule can be tested without
 * a package.
 */
export interface ReducedChunkPlan<TChunk extends LevelChunk = LevelChunk> {
  /** The reduced chunk that stands in for a target chunk, by target chunk id. */
  readonly substitutes: ReadonlyMap<string, TChunk>;
  /** The deviation each stand-in declares, in metres, by target chunk id. */
  readonly bounds: ReadonlyMap<string, number>;
  /** Target chunk ids that have no usable stand-in and are always drawn exactly. */
  readonly exactOnly: readonly string[];
}

/**
 * Pairs target chunks with the reduced chunks that cover exactly the same
 * prototypes.
 *
 * The match has to be the whole prototype set, not an overlap: a partial
 * stand-in would draw some of a chunk's shapes reduced and leave the rest
 * undrawn, and a stand-in carrying extra prototypes would charge the budget for
 * geometry another chunk is already accounted for. A stand-in that declares no
 * usable deviation is refused for the same reason: without a bound there is
 * nothing to project, and drawing it would be exactly the assumption this level
 * exists to avoid. Anything short of an exact, bounded pairing is reported as
 * exact-only rather than approximated, so an unusual chunking loses the reduced
 * level instead of misdrawing the scene.
 */
export function planReducedChunks<TChunk extends LevelChunk>(
  targetChunks: readonly TChunk[],
  reducedChunks: readonly TChunk[],
): ReducedChunkPlan<TChunk> {
  const reducedBySignature = new Map<string, TChunk>();
  // Two reduced chunks over the same prototypes make the stand-in ambiguous;
  // neither is chosen.
  const ambiguous = new Set<string>();
  for (const chunk of reducedChunks) {
    const signature = prototypeSignature(chunk.prototypeIds);
    if (reducedBySignature.has(signature)) {
      ambiguous.add(signature);
      continue;
    }
    reducedBySignature.set(signature, chunk);
  }
  const substitutes = new Map<string, TChunk>();
  const bounds = new Map<string, number>();
  const exactOnly: string[] = [];
  for (const chunk of targetChunks) {
    const signature = prototypeSignature(chunk.prototypeIds);
    const match = reducedBySignature.get(signature);
    const bound = match?.maxDeviationMeters;
    if (
      match === undefined ||
      ambiguous.has(signature) ||
      typeof bound !== "number" ||
      !Number.isFinite(bound) ||
      bound <= 0
    ) {
      exactOnly.push(chunk.id);
      continue;
    }
    substitutes.set(chunk.id, match);
    bounds.set(chunk.id, bound);
  }
  return { substitutes, bounds, exactOnly };
}

function prototypeSignature(prototypeIds: readonly string[]): string {
  return [...prototypeIds].sort((left, right) => left.localeCompare(right, "en")).join("\u0000");
}

/** A chunk a substitution plan can stand in for, and charge residency against. */
export interface PinnableChunk extends LevelChunk {
  readonly meshIndexes: readonly number[];
}

/**
 * The chunk to hold for a demanded target chunk: its reduced stand-in while the
 * selector draws that chunk reduced, the exact chunk otherwise.
 *
 * The level is asked for per chunk, so two chunks in the same frame can be drawn
 * at different levels -- which is the point of a package that declares a bound
 * per chunk rather than one for the whole scene.
 *
 * Pinning wins over the level. A selected occurrence is promoted to `target`
 * (ADR-0025 keeps the inspected shape exact, whatever the camera says), so a
 * chunk carrying any pinned target mesh is never substituted -- a later flip to
 * the reduced level cannot downgrade what the user is looking at.
 */
export function effectiveLevelChunk<TChunk extends PinnableChunk>(
  chunk: TChunk,
  levelFor: (chunkId: string) => GeometryLevel,
  plan: ReducedChunkPlan<TChunk>,
  isPinnedToTarget?: (meshIndexes: readonly number[]) => boolean,
): TChunk {
  if (levelFor(chunk.id) === "target") return chunk;
  if (isPinnedToTarget?.(chunk.meshIndexes) === true) return chunk;
  return plan.substitutes.get(chunk.id) ?? chunk;
}

/**
 * Screen-space error band, in pixels, that separates the two levels.
 *
 * `admitPixels` is the error at or below which `reduced` is drawn;
 * `replacePixels` is the error above which `target` replaces it. The gap
 * between them is deliberate hysteresis, so a camera resting on the boundary
 * cannot make the scene flip level every frame.
 */
export interface ReducedLodThresholds {
  readonly admitPixels: number;
  readonly replacePixels: number;
}

/** ADR-0025's stated defaults: reduced on at 1.0 px, off again past 1.5 px. */
export const defaultReducedLodThresholds: ReducedLodThresholds = {
  admitPixels: 1,
  replacePixels: 1.5,
};

/**
 * Settles a Studio threshold override, refusing a band that cannot hold.
 *
 * A non-positive or reversed band is a configuration error, not a value to
 * clamp: it would either pin the scene to one level or reintroduce the
 * per-frame flip the hysteresis exists to prevent.
 */
export function resolveReducedLodThresholds(
  admitPixels?: number,
  replacePixels?: number,
): ReducedLodThresholds {
  const admit = admitPixels ?? defaultReducedLodThresholds.admitPixels;
  const replace = replacePixels ?? defaultReducedLodThresholds.replacePixels;
  if (!Number.isFinite(admit) || admit <= 0) {
    throw new RangeError("lodAdmitPx must be a positive number of pixels.");
  }
  if (!Number.isFinite(replace) || replace <= 0) {
    throw new RangeError("lodReplacePx must be a positive number of pixels.");
  }
  if (replace < admit) {
    throw new RangeError("lodReplacePx must not be smaller than lodAdmitPx.");
  }
  return { admitPixels: admit, replacePixels: replace };
}

/**
 * Projects a declared world deviation onto the screen.
 *
 * Both arguments are metres; the quotient is pixels. The caller passes the
 * camera's own `metresPerPixel`, so the result carries the projection's
 * scale without this module knowing anything about the camera.
 */
export function projectedErrorPixels(
  maxDeviationMeters: number,
  metresPerPixel: number,
): number {
  if (!Number.isFinite(maxDeviationMeters) || maxDeviationMeters < 0) {
    throw new RangeError("A reduced level must declare a finite, non-negative deviation.");
  }
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) {
    throw new RangeError("Projected error needs a positive, finite metres-per-pixel scale.");
  }
  return maxDeviationMeters / metresPerPixel;
}

/** The measurement behind a level decision, for the HUD and for a record. */
export interface ReducedLodSelection {
  /**
   * The scene-wide level: `reduced` only when every substitutable chunk is
   * drawn reduced. A frame that mixes levels reports `target`, because that is
   * the level a viewer can rely on for the frame as a whole.
   */
  readonly level: GeometryLevel;
  /** Chunks currently drawn through their reduced stand-in. */
  readonly reducedChunkCount: number;
  /** Chunks that have a usable stand-in at all, drawn reduced or not. */
  readonly substitutableChunkCount: number;
  /** The largest deviation, in metres, among the chunks drawn reduced. */
  readonly maxDeviationMeters: number | undefined;
  /** The largest error, in pixels, any chunk drawn reduced projects to. */
  readonly projectedErrorPixels: number | undefined;
  /**
   * The largest error any substitutable chunk would project to if it were drawn
   * reduced, which is defined as soon as one measurement has landed -- so a view
   * that draws nothing reduced still records the scale it decided at.
   */
  readonly worstProjectedErrorPixels: number | undefined;
  readonly metresPerPixel: number | undefined;
}

/**
 * Hysteretic per-chunk level choice for a package that declares a reduced level.
 *
 * Every chunk starts on `target`: the exact tessellation is what the package
 * already proves, so a reduced level is something the view has to earn by
 * measurement rather than something assumed until disproved. Each chunk then
 * crosses the band on its own declared bound, so one camera scale can leave a
 * coarsely reduced shape exact while a faithfully reduced one is substituted.
 */
export class ReducedLodSelector {
  /** The resolved band, exposed so the Studio can publish it in a record. */
  readonly thresholds: ReducedLodThresholds;
  private readonly bounds: ReadonlyMap<string, number>;
  private readonly levels = new Map<string, GeometryLevel>();
  private lastMetresPerPixel: number | undefined;

  constructor(
    bounds: ReadonlyMap<string, number>,
    thresholds: ReducedLodThresholds = defaultReducedLodThresholds,
  ) {
    for (const [chunkId, deviation] of bounds) {
      if (!Number.isFinite(deviation) || deviation <= 0) {
        throw new RangeError(`Reduced chunk ${chunkId} must declare a finite, positive deviation.`);
      }
      this.levels.set(chunkId, "target");
    }
    this.bounds = bounds;
    this.thresholds = resolveReducedLodThresholds(thresholds.admitPixels, thresholds.replacePixels);
  }

  /** The level to draw one target chunk at; `target` for anything unsubstitutable. */
  levelFor(chunkId: string): GeometryLevel {
    return this.levels.get(chunkId) ?? "target";
  }

  /** The deviation a chunk's stand-in declares, in metres, or `undefined`. */
  deviationMeters(chunkId: string): number | undefined {
    return this.bounds.get(chunkId);
  }

  selection(): ReducedLodSelection {
    let reducedChunkCount = 0;
    let maxDeviationMeters: number | undefined;
    let worstDeviation: number | undefined;
    for (const [chunkId, deviation] of this.bounds) {
      if (worstDeviation === undefined || deviation > worstDeviation) worstDeviation = deviation;
      if (this.levels.get(chunkId) !== "reduced") continue;
      reducedChunkCount += 1;
      if (maxDeviationMeters === undefined || deviation > maxDeviationMeters) {
        maxDeviationMeters = deviation;
      }
    }
    const scale = this.lastMetresPerPixel;
    return {
      level: this.bounds.size > 0 && reducedChunkCount === this.bounds.size ? "reduced" : "target",
      reducedChunkCount,
      substitutableChunkCount: this.bounds.size,
      maxDeviationMeters,
      projectedErrorPixels:
        scale === undefined || maxDeviationMeters === undefined
          ? undefined
          : projectedErrorPixels(maxDeviationMeters, scale),
      worstProjectedErrorPixels:
        scale === undefined || worstDeviation === undefined
          ? undefined
          : projectedErrorPixels(worstDeviation, scale),
      metresPerPixel: scale,
    };
  }

  /**
   * Folds one camera measurement in and reports whether any chunk changed level.
   *
   * A non-positive or non-finite scale is the camera's "no viewport" sentinel:
   * nothing is drawn at that size, so it leaves every level and the last
   * measurement alone instead of dividing into a deceptively small error.
   */
  update(metresPerPixel: number): boolean {
    if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return false;
    this.lastMetresPerPixel = metresPerPixel;
    let changed = false;
    for (const [chunkId, deviation] of this.bounds) {
      const errorPixels = projectedErrorPixels(deviation, metresPerPixel);
      const current = this.levels.get(chunkId) ?? "target";
      const next: GeometryLevel =
        current === "target"
          ? errorPixels <= this.thresholds.admitPixels
            ? "reduced"
            : "target"
          : errorPixels > this.thresholds.replacePixels
            ? "target"
            : "reduced";
      if (next === current) continue;
      this.levels.set(chunkId, next);
      changed = true;
    }
    return changed;
  }
}

/**
 * Which geometry level the Studio draws for a shape that has both a declared
 * `reduced` level and its `target` tessellation (ADR-0025).
 *
 * The compiler states one deviation bound for the whole package, and the
 * Studio camera is orthographic, so the scale is uniform over the frame: the
 * decision is one measurement per frame for the whole scene, not per
 * prototype. Selection never invents an error bound -- it divides the bound
 * the package declares by the world size of a pixel.
 */
export type GeometryLevel = "reduced" | "target";

/** The little of a compiled chunk a substitution plan has to look at. */
export interface LevelChunk {
  readonly id: string;
  readonly prototypeIds: readonly string[];
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
 * geometry another chunk is already accounted for. Anything short of an exact
 * pairing is reported as exact-only rather than approximated, so an unusual
 * chunking loses the reduced level instead of misdrawing the scene.
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
  const exactOnly: string[] = [];
  for (const chunk of targetChunks) {
    const signature = prototypeSignature(chunk.prototypeIds);
    const match = reducedBySignature.get(signature);
    if (match === undefined || ambiguous.has(signature)) {
      exactOnly.push(chunk.id);
      continue;
    }
    substitutes.set(chunk.id, match);
  }
  return { substitutes, exactOnly };
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
 * selector draws the reduced level, the exact chunk otherwise.
 *
 * Pinning wins over the level. A selected occurrence is promoted to `target`
 * (ADR-0025 keeps the inspected shape exact, whatever the camera says), so a
 * chunk carrying any pinned target mesh is never substituted -- a later flip to
 * the reduced level cannot downgrade what the user is looking at.
 */
export function effectiveLevelChunk<TChunk extends PinnableChunk>(
  chunk: TChunk,
  level: GeometryLevel,
  plan: ReducedChunkPlan<TChunk>,
  isPinnedToTarget?: (meshIndexes: readonly number[]) => boolean,
): TChunk {
  if (level === "target") return chunk;
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
  readonly level: GeometryLevel;
  /** Pixels of error the declared bound projects to, or `undefined` before the first measurement. */
  readonly projectedErrorPixels: number | undefined;
  readonly metresPerPixel: number | undefined;
}

/**
 * Hysteretic level choice for a package that declares a reduced level.
 *
 * The selector starts on `target`: the exact tessellation is what the package
 * already proves, so a reduced level is something the view has to earn by
 * measurement rather than something assumed until disproved.
 */
export class ReducedLodSelector {
  /** The resolved band, exposed so the Studio can publish it in a record. */
  readonly thresholds: ReducedLodThresholds;
  private current: GeometryLevel = "target";
  private lastErrorPixels: number | undefined;
  private lastMetresPerPixel: number | undefined;

  constructor(
    private readonly maxDeviationMeters: number,
    thresholds: ReducedLodThresholds = defaultReducedLodThresholds,
  ) {
    if (!Number.isFinite(maxDeviationMeters) || maxDeviationMeters < 0) {
      throw new RangeError("A reduced level must declare a finite, non-negative deviation.");
    }
    this.thresholds = resolveReducedLodThresholds(
      thresholds.admitPixels,
      thresholds.replacePixels,
    );
  }

  /** The deviation the package declares, in metres, for the HUD to quote. */
  deviationMeters(): number {
    return this.maxDeviationMeters;
  }

  selection(): ReducedLodSelection {
    return {
      level: this.current,
      projectedErrorPixels: this.lastErrorPixels,
      metresPerPixel: this.lastMetresPerPixel,
    };
  }

  /**
   * Folds one camera measurement in and reports whether the level changed.
   *
   * A non-positive or non-finite scale is the camera's "no viewport" sentinel:
   * nothing is drawn at that size, so it leaves both the level and the last
   * measurement alone instead of dividing into a deceptively small error.
   */
  update(metresPerPixel: number): boolean {
    if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) return false;
    const errorPixels = projectedErrorPixels(this.maxDeviationMeters, metresPerPixel);
    this.lastErrorPixels = errorPixels;
    this.lastMetresPerPixel = metresPerPixel;
    const next: GeometryLevel =
      this.current === "target"
        ? errorPixels <= this.thresholds.admitPixels
          ? "reduced"
          : "target"
        : errorPixels > this.thresholds.replacePixels
          ? "target"
          : "reduced";
    if (next === this.current) return false;
    this.current = next;
    return true;
  }
}

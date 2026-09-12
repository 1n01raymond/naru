import type { CompiledHierarchy, DecodedCompiledScene } from "@naru3d/runtime-webgpu";

/**
 * A decoded scene as it crosses the Worker boundary. The compiled hierarchy is
 * document-scoped and identical for every decode of one scene session, so the
 * Worker posts it once with its initialization response and every decode omits
 * it instead of structured-cloning it again (the sixty5 hierarchy serializes to
 * ~71 MB and dominated per-admission latency).
 */
export type GeometryTransitScene = Omit<DecodedCompiledScene, "hierarchy"> &
  Partial<Pick<DecodedCompiledScene, "hierarchy">>;

/** Prepares a scene for postMessage, leaving the session hierarchy behind. */
export function transitSceneForResponse(scene: DecodedCompiledScene): GeometryTransitScene {
  const { hierarchy: _hierarchy, ...transit } = scene;
  return transit;
}

/**
 * Restores a full scene from a transit scene, using the hierarchy the Worker
 * posted when it parsed the document. Throws when a decode response arrives
 * before that hierarchy has been received.
 */
export function adoptTransitScene(
  transit: GeometryTransitScene,
  sessionHierarchy: CompiledHierarchy | undefined,
): DecodedCompiledScene {
  const hierarchy = transit.hierarchy ?? sessionHierarchy;
  if (!hierarchy) {
    throw new Error(
      "The geometry Worker omitted the scene hierarchy before it was cached.",
    );
  }
  return { ...transit, hierarchy };
}

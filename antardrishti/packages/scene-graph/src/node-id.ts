/**
 * ANTARDRISHTI — Stable Node IDs & Target Fingerprints
 *
 * Generates deterministic, stable node IDs from DOM position,
 * role, name hash, and ancestry. These IDs are used for:
 *   - action targeting (planner references node IDs)
 *   - freshness binding (reject stale/wrong-target actions)
 *   - visual grounding (map visual regions to DOM nodes)
 */

// ── Node ID generation ───────────────────────────────────────

let globalCounter = 0;

/**
 * Generate a stable node ID.
 * Deterministic within an observation cycle.
 */
export function generateNodeId(
  tag: string,
  role: string,
  index: number,
  frameId: number,
): string {
  return `node-${frameId}-${tag}-${role}-${index}`;
}

/**
 * Generate a simple incrementing node ID (for Phase 2 baseline).
 * Phase 3+ will use content-based stable IDs.
 */
export function generateSequentialNodeId(): string {
  return `node-${++globalCounter}`;
}

/** Reset the sequential counter (for new observations). */
export function resetNodeIdCounter(): void {
  globalCounter = 0;
}

// ── Target fingerprint ──────────────────────────────────────

/**
 * Target fingerprint for action resolution verification.
 * Verifies the planner's target reference matches the current DOM state.
 */
export interface TargetFingerprint {
  nodeId: string;
  role: string;
  nameHash: string;
  ancestryHash: string;
  bbox: { x: number; y: number; w: number; h: number };
  frameId: number;
  documentGeneration: string;
}

/**
 * Compute a stable target reference string.
 * Used to re-resolve a node after re-observation.
 */
export function computeStableTargetRef(
  tag: string,
  role: string,
  name: string,
  ancestry: string[],
  bbox: { x: number; y: number; w: number; h: number },
): string {
  // Simplified stable ref: tag-role-namePrefix-bboxApprox
  const namePrefix = name.substring(0, 20).replace(/\s+/g, '_');
  const bboxKey = `${Math.round(bbox.x / 10)}_${Math.round(bbox.y / 10)}`;
  return `${tag}:${role}:${namePrefix}:${bboxKey}`;
}

/**
 * Compute ancestry fingerprint from tag path.
 */
export function computeAncestryFingerprint(
  ancestorTags: string[],
): string {
  return ancestorTags.join('>');
}

/**
 * Fast string hash for name comparison.
 * NOT cryptographic — for structural comparison only.
 */
export function fastHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Create a target fingerprint for verifying action targets.
 */
export function createTargetFingerprint(
  nodeId: string,
  role: string,
  name: string,
  ancestorTags: string[],
  bbox: { x: number; y: number; w: number; h: number },
  frameId: number,
  documentGeneration: string,
): TargetFingerprint {
  return {
    nodeId,
    role,
    nameHash: fastHash(name),
    ancestryHash: fastHash(ancestorTags.join('>')),
    bbox,
    frameId,
    documentGeneration,
  };
}

/**
 * Verify a target fingerprint matches the current state.
 * Returns true only if ALL fields match within tolerance.
 */
export function verifyTargetFingerprint(
  expected: TargetFingerprint,
  current: TargetFingerprint,
  bboxTolerance = 10,
): boolean {
  if (expected.role !== current.role) return false;
  if (expected.nameHash !== current.nameHash) return false;
  if (expected.ancestryHash !== current.ancestryHash) return false;
  if (expected.frameId !== current.frameId) return false;
  if (expected.documentGeneration !== current.documentGeneration) return false;

  // BBox must be within tolerance (pixels may shift slightly)
  const dx = Math.abs(expected.bbox.x - current.bbox.x);
  const dy = Math.abs(expected.bbox.y - current.bbox.y);
  const dw = Math.abs(expected.bbox.w - current.bbox.w);
  const dh = Math.abs(expected.bbox.h - current.bbox.h);

  return dx <= bboxTolerance && dy <= bboxTolerance &&
         dw <= bboxTolerance && dh <= bboxTolerance;
}

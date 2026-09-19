/**
 * ANTARDRISHTI Protocol v2 — Observation Types
 *
 * CaptureStamp, ObservationId, and freshness bindings.
 * Every scene graph and action plan is bound to these values.
 * An action is rejected if ANY binding is stale or mismatched.
 */

/**
 * CaptureStamp uniquely identifies a screen capture moment.
 * hash = SHA-256 of all viewport-identifying fields at capture time.
 */
export interface CaptureStamp {
  hash: string;
  tabId: number;
  frameTreeGeneration: string;
  topOrigin: string;
  documentGeneration: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  zoom: number;
  scrollX: number;
  scrollY: number;
  capturedAt: string;
}

/** Unique observation identifier, generated per perception cycle. */
export type ObservationId = string & { readonly __brand: 'ObservationId' };

/**
 * Freshness binding. An action is rejected if ANY field is stale.
 */
export interface FreshnessBinding {
  sessionId: string;
  tabId: number;
  frameId: number;
  documentGeneration: string;
  viewportFingerprint: string;
  observationId: ObservationId;
  origin: string;
  createdAt: string;
}

/** Create a cryptographically random ObservationId. */
export function createObservationId(): ObservationId {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `obs-${hex}` as ObservationId;
}

/** Compute a CaptureStamp hash from its component fields. */
export async function computeCaptureHash(
  stamp: Omit<CaptureStamp, 'hash'>
): Promise<string> {
  const payload = JSON.stringify([
    stamp.tabId,
    stamp.frameTreeGeneration,
    stamp.topOrigin,
    stamp.documentGeneration,
    stamp.viewportWidth,
    stamp.viewportHeight,
    stamp.devicePixelRatio,
    stamp.zoom,
    stamp.scrollX,
    stamp.scrollY,
    stamp.capturedAt,
  ]);
  const encoded = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Create a viewport fingerprint for freshness checks. */
export function createViewportFingerprint(
  width: number,
  height: number,
  dpr: number,
  scrollX: number,
  scrollY: number,
  zoom: number
): string {
  return `${width}x${height}@${dpr}+${scrollX},${scrollY}z${zoom}`;
}

// ── P1-C: Target fingerprint ─────────────────────────────────

/**
 * Captures the identity-relevant properties of a target node at
 * observation time. Used to detect target replacement/mutation
 * between observation and execution.
 *
 * A stale fingerprint MUST reject execution even if:
 * - the nodeId is unchanged
 * - a CSS selector would still match
 * - the element occupies a similar position
 */
export interface TargetFingerprint {
  nodeId: string;
  role: string;
  name: string;
  /** Serialized parent ancestry path, e.g. "body>main>form>div" */
  ancestry: string;
  /** Bounding box at observation time */
  bbox: { x: number; y: number; w: number; h: number };
  /** Frame ID where the target was observed */
  frameId: number;
  /** Document generation at observation time */
  documentGeneration: string;
  /** Observation that produced this fingerprint */
  observationId: string;
}

/**
 * Create a TargetFingerprint from a scene node's properties.
 */
export function createTargetFingerprint(
  nodeId: string,
  role: string,
  name: string,
  ancestry: string,
  bbox: { x: number; y: number; w: number; h: number },
  frameId: number,
  documentGeneration: string,
  observationId: string,
): TargetFingerprint {
  return {
    nodeId,
    role,
    name,
    ancestry,
    bbox,
    frameId,
    documentGeneration,
    observationId,
  };
}

/**
 * Verify that a current target still matches the original fingerprint.
 * Returns null if valid, or an error string if stale.
 *
 * Bounding box is allowed a tolerance of ±5px per axis to account
 * for layout reflow without semantic change.
 */
export function verifyTargetFingerprint(
  original: TargetFingerprint,
  current: {
    role: string;
    name: string;
    ancestry: string;
    bbox: { x: number; y: number; w: number; h: number };
    frameId: number;
    documentGeneration: string;
  },
): string | null {
  if (current.documentGeneration !== original.documentGeneration) {
    return `documentGeneration mismatch: expected ${original.documentGeneration}, got ${current.documentGeneration}`;
  }
  if (current.frameId !== original.frameId) {
    return `frameId mismatch: expected ${original.frameId}, got ${current.frameId}`;
  }
  if (current.role !== original.role) {
    return `role changed: expected "${original.role}", got "${current.role}"`;
  }
  if (current.name !== original.name) {
    return `accessible name changed: expected "${original.name}", got "${current.name}"`;
  }
  if (current.ancestry !== original.ancestry) {
    return `ancestry changed: expected "${original.ancestry}", got "${current.ancestry}"`;
  }
  // Bounding box tolerance: ±5px per axis
  const BBox_TOLERANCE = 5;
  if (
    Math.abs(current.bbox.x - original.bbox.x) > BBox_TOLERANCE ||
    Math.abs(current.bbox.y - original.bbox.y) > BBox_TOLERANCE ||
    Math.abs(current.bbox.w - original.bbox.w) > BBox_TOLERANCE ||
    Math.abs(current.bbox.h - original.bbox.h) > BBox_TOLERANCE
  ) {
    return `bounding box moved materially`;
  }
  return null; // fingerprint matches
}

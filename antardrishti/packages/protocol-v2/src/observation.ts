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

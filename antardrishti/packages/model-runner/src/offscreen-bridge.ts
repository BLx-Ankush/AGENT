/**
 * ANTARDRISHTI -- Offscreen Inference Bridge
 *
 * Typed message protocol for the service-worker <-> offscreen-document
 * inference channel. No Chrome API dependency -- fully testable in Node.js.
 *
 * Full startup handshake (Phase 9, blocker #5 fix):
 *
 *   SERVICE WORKER                    OFFSCREEN DOCUMENT
 *   ──────────────────────────────    ───────────────────────────────
 *   createDocument()
 *                                     (script loads, listener registered)
 *                            <───     OFFSCREEN_READY { runtimeInstanceId }
 *   [Coordinator] Offscreen READY received
 *   INFERENCE_INIT           ───>     loadProductionModels()
 *                            <───     INFERENCE_INIT_RESULT { backend, initMs }
 *   [Coordinator] Perception ready
 *
 *   INFERENCE_RUN            ───>     decode PNG -> pipeline.run()
 *                            <───     INFERENCE_RESULT { result, timing }
 *
 *   INFERENCE_DISPOSE        ───>     disposeModels()
 *
 *   OFFSCREEN_PING           ───>     (if document already exists)
 *                            <───     OFFSCREEN_READY { runtimeInstanceId }
 *
 * OFFSCREEN_READY vs INFERENCE_READY:
 *   OFFSCREEN_READY = listener registered, ready to receive INFERENCE_INIT
 *   INFERENCE_READY = all 4 ONNX models loaded, inference can run
 *   These are SEPARATE states. Do NOT conflate them.
 *
 * ImageData transfer:
 *   PNG data URL (string) is sent as-is. Offscreen decodes via
 *   createImageBitmap() + OffscreenCanvas. Never serialized as bytes.
 *
 * Trust boundary:
 *   Offscreen document MUST NOT:
 *     - send planner requests
 *     - perform external network requests
 *     - redeem vault tokens
 *     - execute browser actions
 *   The service worker is the sole egress authority.
 */

import type {
  BackendRequest,
  CanvasRegionData,
} from './types';
import type { PerceptionResult } from './pipeline';

// -- Re-export for consumers ------------------------------------------------
export type { CanvasRegionData };

// -- Tile rectangle --------------------------------------------------------

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// -- Serialized PerceptionResult --------------------------------------------
// PerceptionResult contains only plain objects so structured-clone works.

export type SerializedPerceptionResult = PerceptionResult;

// ==========================================================================
// MESSAGE TYPES: OFFSCREEN -> SERVICE WORKER (sent first in handshake)
// ==========================================================================

/**
 * Sent by the offscreen document immediately after its message listener
 * is registered. Proves the listener is live before INFERENCE_INIT arrives.
 *
 * Also sent in response to OFFSCREEN_PING when the document already exists.
 *
 * runtimeInstanceId: unique per-load instance (crypto.randomUUID()).
 *   Allows the service worker to detect stale / reloaded documents.
 *
 * OFFSCREEN_READY !== inference ready.
 * The offscreen document is not yet initialized for inference at this point.
 */
export interface OffscreenReadyMessage {
  type: 'OFFSCREEN_READY';
  runtimeInstanceId: string;
}

/**
 * Response to INFERENCE_INIT. Contains selected backend and init timing.
 */
export interface InferenceInitResult {
  type: 'INFERENCE_INIT_RESULT';
  success: boolean;
  /** Actual selected backend (may differ from requested if GPU unavailable) */
  backend: string;
  /** Total model load time in ms */
  initMs: number;
  /** Optional failure reason */
  error?: string;
}

/**
 * Response to INFERENCE_RUN.
 *
 * Timing breakdown (amendment 4):
 *   transferDecodeMs  -- message arrival -> ImageData ready (PNG decode)
 *   inferenceMs       -- pure ORT inference time across all 4 models
 *   totalMs           -- total from message receipt to response sent
 */
export interface InferenceResult {
  type: 'INFERENCE_RESULT';
  result: SerializedPerceptionResult;
  backend: string;
  /** PNG decode + createImageBitmap time (ms). Separate from inference. */
  transferDecodeMs: number;
  /** Sum of ORT InferenceSession.run() times across all 4 models (ms). */
  inferenceMs: number;
  /** Total offscreen processing time (ms). */
  totalMs: number;
}

/**
 * Sent when the offscreen document encounters a fatal error.
 * Service worker must treat this as fail-closed.
 */
export interface InferenceErrorMessage {
  type: 'INFERENCE_ERROR';
  error: string;
  failClosed: true;
}

export type OffscreenToSwMessage =
  | OffscreenReadyMessage
  | InferenceInitResult
  | InferenceResult
  | InferenceErrorMessage;

// ==========================================================================
// MESSAGE TYPES: SERVICE WORKER -> OFFSCREEN
// ==========================================================================

/**
 * Sent once at startup. Offscreen loads all 4 models and responds
 * with INFERENCE_INIT_RESULT.
 * Only sent AFTER OFFSCREEN_READY is received.
 */
export interface InferenceInitMessage {
  type: 'INFERENCE_INIT';
  /** Backend preference from chrome.storage.local or 'auto' */
  requestedBackend: BackendRequest;
}

/**
 * Sent when the service worker suspects the offscreen document may already
 * exist (hasDocument = true) but doesn't know if its listener is ready.
 * Offscreen responds with OFFSCREEN_READY.
 */
export interface OffscreenPingMessage {
  type: 'OFFSCREEN_PING';
}

/**
 * Sent for each perception run. Offscreen decodes PNG, runs pipeline,
 * responds with INFERENCE_RESULT.
 */
export interface InferenceRunMessage {
  type: 'INFERENCE_RUN';
  /**
   * PNG data URL from captureVisibleTab (existing field).
   * Offscreen decodes via createImageBitmap() -> OffscreenCanvas -> ImageData.
   * Never serialized as RGBA byte array.
   */
  imageDataUrl: string;
  changedTiles: TileRect[];
  observationId: string;
  frameId: number;
  documentGeneration: string;
  canvasContext: CanvasRegionData;
  /** Width of the full capture (px) */
  captureWidth: number;
  /** Height of the full capture (px) */
  captureHeight: number;
}

/** Sent when service worker shuts down or extension is reloaded. */
export interface InferenceDisposeMessage {
  type: 'INFERENCE_DISPOSE';
}

export type SwToOffscreenMessage =
  | OffscreenPingMessage
  | InferenceInitMessage
  | InferenceRunMessage
  | InferenceDisposeMessage;

// -- Type guards -----------------------------------------------------------

export function isSwToOffscreenMessage(msg: unknown): msg is SwToOffscreenMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return (
    t === 'OFFSCREEN_PING' ||
    t === 'INFERENCE_INIT' ||
    t === 'INFERENCE_RUN' ||
    t === 'INFERENCE_DISPOSE'
  );
}

export function isOffscreenToSwMessage(msg: unknown): msg is OffscreenToSwMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return (
    t === 'OFFSCREEN_READY' ||
    t === 'INFERENCE_INIT_RESULT' ||
    t === 'INFERENCE_RESULT' ||
    t === 'INFERENCE_ERROR'
  );
}

export function isOffscreenReady(msg: unknown): msg is OffscreenReadyMessage {
  return typeof msg === 'object' && msg !== null && (msg as any).type === 'OFFSCREEN_READY';
}

export function isInferenceResult(msg: unknown): msg is InferenceResult {
  return typeof msg === 'object' && msg !== null && (msg as any).type === 'INFERENCE_RESULT';
}

export function isInferenceInitResult(msg: unknown): msg is InferenceInitResult {
  return typeof msg === 'object' && msg !== null && (msg as any).type === 'INFERENCE_INIT_RESULT';
}

export function isInferenceError(msg: unknown): msg is InferenceErrorMessage {
  return typeof msg === 'object' && msg !== null && (msg as any).type === 'INFERENCE_ERROR';
}

// -- Trust boundary helpers ------------------------------------------------

/**
 * Keys that MUST NOT appear in any INFERENCE_RESULT payload.
 * These belong to the service-worker control plane only.
 */
export const TRUST_BOUNDARY_FORBIDDEN_KEYS = [
  'plannerRequest',
  'plannerToken',
  'vaultToken',
  'plannerUrl',
  'actionGate',
  'egressVerifier',
] as const;

/**
 * Validates that an InferenceResult does not contain control-plane keys.
 * Used by service worker to assert trust boundary is intact.
 */
export function assertInferenceResultTrustBoundary(result: InferenceResult): void {
  const payload = JSON.stringify(result);
  for (const key of TRUST_BOUNDARY_FORBIDDEN_KEYS) {
    if (payload.includes('"' + key + '"')) {
      throw new Error(
        '[TrustBoundary] InferenceResult contains forbidden key: "' + key + '". ' +
        'Offscreen document may not contain control-plane data.',
      );
    }
  }
}

// -- Timeout helper --------------------------------------------------------

/**
 * Wraps a promise with a timeout. Rejects with the given message if the
 * promise does not settle within timeoutMs.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

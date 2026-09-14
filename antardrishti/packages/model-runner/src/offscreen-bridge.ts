/**
 * ANTARDRISHTI — Offscreen Inference Bridge
 *
 * Typed message protocol for the service-worker ↔ offscreen-document
 * inference channel. No Chrome API dependency — fully testable in Node.js.
 *
 * Message flow:
 *
 *   SERVICE WORKER                    OFFSCREEN DOCUMENT
 *   ─────────────────                 ──────────────────────────────
 *   INFERENCE_INIT           ───→     load models + ORT
 *                            ←───     INFERENCE_INIT_RESULT
 *
 *   INFERENCE_RUN            ───→     decode PNG → pipeline.run()
 *                            ←───     INFERENCE_RESULT
 *
 *   INFERENCE_DISPOSE        ───→     dispose models
 *
 * ImageData is NOT serialized as bytes. The service worker sends the
 * existing captureResult.imageDataUrl (PNG data URL string). The offscreen
 * document decodes it via createImageBitmap() + OffscreenCanvas. This
 * avoids the O(W×H×4) byte expansion that would exceed Chrome's 64 MiB
 * message size limit for high-resolution captures.
 *
 * Trust boundary:
 *   The offscreen document is a computation-only component. It MUST NOT:
 *     - send planner requests
 *     - perform external network requests
 *     - redeem vault tokens
 *     - execute browser actions
 *   The service worker is the sole egress authority.
 */

import type {
  BackendRequest,
  CanvasRegionData,
  FaceDetection,
  InferenceMetrics,
  OcrResult,
  SemanticRegion,
  TextRegion,
} from './types';
import type { PerceptionResult, VisualGrounding } from './pipeline';

// ── Re-export for consumers of this module ─────────────────────────────────
export type { CanvasRegionData };

// ── Tile rectangle ──────────────────────────────────────────────────────────

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Serialized PerceptionResult ─────────────────────────────────────────────
// PerceptionResult contains only plain objects (no TypedArrays, no class
// instances) so chrome.runtime.sendMessage can structured-clone it directly.

export type SerializedPerceptionResult = PerceptionResult;

// ── Message types: SERVICE WORKER → OFFSCREEN ──────────────────────────────

/**
 * Sent once at startup. Offscreen loads all 4 models and responds
 * with INFERENCE_INIT_RESULT.
 */
export interface InferenceInitMessage {
  type: 'INFERENCE_INIT';
  /** Backend preference from chrome.storage.local or 'auto' */
  requestedBackend: BackendRequest;
}

/**
 * Sent for each perception run. Offscreen decodes PNG, runs pipeline,
 * responds with INFERENCE_RESULT.
 */
export interface InferenceRunMessage {
  type: 'INFERENCE_RUN';
  /**
   * PNG data URL from captureVisibleTab (existing field).
   * Offscreen decodes via createImageBitmap() → OffscreenCanvas → ImageData.
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
  | InferenceInitMessage
  | InferenceRunMessage
  | InferenceDisposeMessage;

// ── Message types: OFFSCREEN → SERVICE WORKER ──────────────────────────────

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
 *   transferDecodeMs  — message arrival → ImageData ready (PNG decode)
 *   inferenceMs       — pure ORT inference time across all 4 models
 *   totalMs           — total from message receipt to response sent
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
  | InferenceInitResult
  | InferenceResult
  | InferenceErrorMessage;

// ── Type guards ─────────────────────────────────────────────────────────────

export function isSwToOffscreenMessage(msg: unknown): msg is SwToOffscreenMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return t === 'INFERENCE_INIT' || t === 'INFERENCE_RUN' || t === 'INFERENCE_DISPOSE';
}

export function isOffscreenToSwMessage(msg: unknown): msg is OffscreenToSwMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return (
    t === 'INFERENCE_INIT_RESULT' ||
    t === 'INFERENCE_RESULT' ||
    t === 'INFERENCE_ERROR'
  );
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

// ── Trust boundary helpers ───────────────────────────────────────────────────

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
    if (payload.includes(`"${key}"`)) {
      throw new Error(
        `[TrustBoundary] InferenceResult contains forbidden key: "${key}". ` +
        'Offscreen document may not contain control-plane data.',
      );
    }
  }
}

/**
 * ANTARDRISHTI -- Offscreen Inference Runtime
 *
 * Chrome MV3 Offscreen Document entry point.
 * Computation-only: receives messages from service worker, runs ONNX,
 * returns results. Service worker is the sole security/egress authority.
 *
 * STARTUP SEQUENCE (Phase 9 blocker #5 -- explicit handshake):
 *
 *   1. Script loads
 *   2. chrome.runtime.onMessage listener is registered     <-- critical order
 *   3. OFFSCREEN_READY sent immediately                    <-- listener IS live
 *   4. Service worker receives OFFSCREEN_READY
 *   5. Service worker sends INFERENCE_INIT
 *   6. loadProductionModels() runs in this offscreen context
 *   7. INFERENCE_INIT_RESULT sent back
 *   8. Production inference loop begins
 *
 * OFFSCREEN_READY != inference ready.
 * OFFSCREEN_READY only proves the message listener is registered.
 * Inference readiness is signaled by INFERENCE_INIT_RESULT.success=true.
 *
 * TRUST BOUNDARY:
 *   OK  Load ONNX Runtime Web (no import() restriction here)
 *   OK  Initialize 4 production model sessions
 *   OK  Decode PNG via OffscreenCanvas
 *   OK  Run PerceptionPipeline
 *   OK  Return serialized PerceptionResult
 *   NO  Planner requests
 *   NO  External network calls
 *   NO  Vault token redemption
 *   NO  Browser action execution
 */

import {
  isSwToOffscreenMessage,
  assertInferenceResultTrustBoundary,
} from '@antardrishti/model-runner/offscreen-bridge';
import type {
  InferenceRunMessage,
  InferenceResult,
  InferenceInitResult,
  OffscreenReadyMessage,
} from '@antardrishti/model-runner/offscreen-bridge';
import {
  loadProductionModels,
  disposeModels,
  PerceptionPipeline,
} from '@antardrishti/model-runner';
import type { LoadedModels } from '@antardrishti/model-runner';

// -- Runtime instance ID ---------------------------------------------------
// Unique per document load. Allows the SW to detect stale documents.
const RUNTIME_INSTANCE_ID: string = crypto.randomUUID();

// -- State -----------------------------------------------------------------

let _pipeline: PerceptionPipeline | null = null;
let _loadedModels: LoadedModels | null = null;
let _backend = 'unknown';
let _isReady = false;

// -- Helpers ---------------------------------------------------------------

function sendReady(): void {
  const msg: OffscreenReadyMessage = {
    type: 'OFFSCREEN_READY',
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
  };
  chrome.runtime.sendMessage(msg);
}

// -- Message handler -------------------------------------------------------
// CRITICAL: register listener BEFORE sending OFFSCREEN_READY.
// This guarantees INFERENCE_INIT arriving immediately after OFFSCREEN_READY
// is never dropped.

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (!isSwToOffscreenMessage(message)) {
    // Unknown message type -- log but do not crash
    const t = (message as any)?.type;
    if (t !== undefined) {
      console.warn('[InferenceRuntime] Ignored unknown message type:', t);
    }
    return false;
  }

  switch (message.type) {

    case 'OFFSCREEN_PING': {
      // SW is checking if this document's listener is alive.
      // Reply with OFFSCREEN_READY so SW can proceed.
      console.log('[InferenceRuntime] OFFSCREEN_PING received -- sending OFFSCREEN_READY');
      sendReady();
      return false;
    }

    case 'INFERENCE_INIT': {
      const requested = message.requestedBackend;
      initInference(requested).catch((err: any) => {
        console.error('[InferenceRuntime] Init failed:', err);
        const failResult: InferenceInitResult = {
          type: 'INFERENCE_INIT_RESULT',
          success: false,
          backend: 'unknown',
          initMs: 0,
          error: err?.message ?? String(err),
        };
        chrome.runtime.sendMessage(failResult);
      });
      return false;
    }

    case 'INFERENCE_RUN': {
      runInference(message).catch((err: any) => {
        console.error('[InferenceRuntime] Run failed:', err);
        chrome.runtime.sendMessage({
          type: 'INFERENCE_ERROR',
          error: err?.message ?? String(err),
          failClosed: true,
        });
      });
      return false;
    }

    case 'INFERENCE_DISPOSE': {
      if (_loadedModels) {
        disposeModels(_loadedModels);
        _loadedModels = null;
        _pipeline = null;
        _isReady = false;
        _backend = 'unknown';
        console.log('[InferenceRuntime] Models disposed');
      }
      return false;
    }

    default:
      return false;
  }
});

// -- Send OFFSCREEN_READY --------------------------------------------------
// Sent AFTER listener registration (above). This ordering is guaranteed by
// the JavaScript event loop -- the addListener call completes synchronously
// before the sendMessage below executes.

console.log('[InferenceRuntime] Offscreen document loaded -- instance=' + RUNTIME_INSTANCE_ID);
sendReady();

// -- Initialization --------------------------------------------------------

async function initInference(requestedBackend: string): Promise<void> {
  const t0 = performance.now();
  console.log('[InferenceRuntime] context=offscreen');
  console.log('[InferenceRuntime] requestedBackend=' + requestedBackend);

  // Offscreen documents support Workers + dynamic import() fully.
  // loadProductionModels() reads chrome.storage.local backend override,
  // detects GPU capability, and loads all 4 ORT InferenceSession instances.
  const models = await loadProductionModels();

  _backend = models.backend;
  console.log('[InferenceRuntime] selectedBackend=' + _backend);

  _pipeline = new PerceptionPipeline();
  _pipeline.registerOnnxModels(models);
  _loadedModels = models;
  _isReady = true;

  const initMs = Math.round(performance.now() - t0);
  console.log('[InferenceRuntime] All 4 models ready in ' + initMs + 'ms');

  const result: InferenceInitResult = {
    type: 'INFERENCE_INIT_RESULT',
    success: true,
    backend: _backend,
    initMs,
  };
  chrome.runtime.sendMessage(result);
}

// -- PNG decode ------------------------------------------------------------

async function decodeImageDataUrl(
  imageDataUrl: string,
  width: number,
  height: number,
): Promise<{ imageData: ImageData; decodeMs: number }> {
  const t0 = performance.now();
  const resp = await fetch(imageDataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(width || bitmap.width, height || bitmap.height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { imageData, decodeMs: Math.round(performance.now() - t0) };
}

// -- Inference run ---------------------------------------------------------

async function runInference(msg: InferenceRunMessage): Promise<void> {
  const t0 = performance.now();

  if (!_isReady || !_pipeline) {
    chrome.runtime.sendMessage({
      type: 'INFERENCE_ERROR',
      error: 'Offscreen inference runtime not initialized (INFERENCE_INIT not yet complete)',
      failClosed: true,
    });
    return;
  }

  try {
    const { imageData, decodeMs } = await decodeImageDataUrl(
      msg.imageDataUrl, msg.captureWidth, msg.captureHeight,
    );
    console.log('[InferenceRuntime] PNG decoded: ' +
      imageData.width + 'x' + imageData.height + ' decodeMs=' + decodeMs);

    const inferenceStart = performance.now();
    const perceptionResult = await _pipeline.run(
      imageData,
      msg.changedTiles,
      msg.observationId,
      msg.frameId,
      msg.documentGeneration,
      msg.canvasContext,
    );
    const inferenceMs = Math.round(performance.now() - inferenceStart);
    const totalMs = Math.round(performance.now() - t0);

    console.log('[InferenceRuntime] Inference complete: inferenceMs=' +
      inferenceMs + ' totalMs=' + totalMs);

    const result: InferenceResult = {
      type: 'INFERENCE_RESULT',
      result: perceptionResult,
      backend: _backend,
      transferDecodeMs: decodeMs,
      inferenceMs,
      totalMs,
    };
    assertInferenceResultTrustBoundary(result);
    chrome.runtime.sendMessage(result);
  } catch (err: any) {
    console.error('[InferenceRuntime] Inference failed:', err);
    chrome.runtime.sendMessage({
      type: 'INFERENCE_ERROR',
      error: err?.message ?? String(err),
      failClosed: true,
    });
  }
}

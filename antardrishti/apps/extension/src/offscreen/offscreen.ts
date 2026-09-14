/**
 * ANTARDRISHTI -- Offscreen Inference Runtime
 *
 * Entry point for the Chrome MV3 Offscreen Document.
 * Runs ONNX inference locally. Service worker is the sole security authority.
 *
 * TRUST BOUNDARY:
 *   OK  Load ONNX Runtime Web (no import() restriction in offscreen context)
 *   OK  Initialize 4 production model sessions
 *   OK  Decode PNG captures via OffscreenCanvas
 *   OK  Run PerceptionPipeline
 *   OK  Return serialized PerceptionResult to service worker
 *   NO  Planner requests / external network / vault / browser actions
 *
 * Message protocol:
 *   INFERENCE_INIT    -> load models -> INFERENCE_INIT_RESULT
 *   INFERENCE_RUN     -> decode PNG -> pipeline.run() -> INFERENCE_RESULT
 *   INFERENCE_DISPOSE -> dispose models
 */

import {
  isSwToOffscreenMessage,
  assertInferenceResultTrustBoundary,
} from '@antardrishti/model-runner/offscreen-bridge';
import type {
  InferenceRunMessage,
  InferenceResult,
  InferenceInitResult,
} from '@antardrishti/model-runner/offscreen-bridge';
import {
  loadProductionModels,
  disposeModels,
  PerceptionPipeline,
} from '@antardrishti/model-runner';
import type { LoadedModels } from '@antardrishti/model-runner';

// -- State -------------------------------------------------------------------

let _pipeline: PerceptionPipeline | null = null;
let _loadedModels: LoadedModels | null = null;
let _backend = 'unknown';
let _isReady = false;

// -- Initialization ----------------------------------------------------------

async function initInference(requestedBackend: string): Promise<void> {
  const t0 = performance.now();
  console.log('[InferenceRuntime] context=offscreen');
  console.log('[InferenceRuntime] requestedBackend=' + requestedBackend);

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

// -- PNG -> ImageData decode --------------------------------------------------

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

// -- Inference run -----------------------------------------------------------

async function runInference(msg: InferenceRunMessage): Promise<void> {
  const t0 = performance.now();

  if (!_isReady || !_pipeline) {
    chrome.runtime.sendMessage({ type: 'INFERENCE_ERROR', error: 'Runtime not initialized', failClosed: true });
    return;
  }

  try {
    const { imageData, decodeMs } = await decodeImageDataUrl(
      msg.imageDataUrl, msg.captureWidth, msg.captureHeight,
    );
    console.log('[InferenceRuntime] PNG decoded: ' + imageData.width + 'x' + imageData.height + ' in ' + decodeMs + 'ms');

    const inferenceStart = performance.now();
    const perceptionResult = await _pipeline.run(
      imageData, msg.changedTiles, msg.observationId,
      msg.frameId, msg.documentGeneration, msg.canvasContext,
    );
    const inferenceMs = Math.round(performance.now() - inferenceStart);
    const totalMs = Math.round(performance.now() - t0);

    console.log('[InferenceRuntime] Inference complete: inferenceMs=' + inferenceMs + ' totalMs=' + totalMs);

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
    chrome.runtime.sendMessage({ type: 'INFERENCE_ERROR', error: err?.message ?? String(err), failClosed: true });
  }
}

// -- Message handler ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (!isSwToOffscreenMessage(message)) {
    console.warn('[InferenceRuntime] Rejected unknown message type:', (message as any)?.type);
    return false;
  }

  switch (message.type) {
    case 'INFERENCE_INIT': {
      initInference(message.requestedBackend).catch((err: any) => {
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
        chrome.runtime.sendMessage({ type: 'INFERENCE_ERROR', error: err?.message ?? String(err), failClosed: true });
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

console.log('[InferenceRuntime] Offscreen document loaded -- awaiting INFERENCE_INIT');

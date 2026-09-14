/**
 * ANTARDRISHTI — Pinned Model Manifests
 *
 * Production model definitions with verified SHA-256 integrity hashes.
 * Models are downloaded from open-source repositories and bundled with the extension.
 *
 * Generated: 2026-09-12T15:40:21Z
 * Verified: all 4 models downloaded and hash-verified via scripts/download-models.py
 *
 * Licenses:
 *   PP-OCRv4 det/rec: Apache-2.0 (PaddlePaddle)
 *   BlazeFace: Apache-2.0 (Google MediaPipe)
 *   OmniParser icon_detect: MIT (Microsoft)
 *
 * Model attribution:
 *   text-detector: webnn/PP-OCRv4-ONNX on HuggingFace (PaddlePaddle source)
 *   ocr-recognizer: webnn/PP-OCRv4-ONNX on HuggingFace (PaddlePaddle source)
 *   face-detector: garavv/blazeface-onnx on HuggingFace (Google MediaPipe source)
 *   ui-region-detector: onnx-community/OmniParser-icon_detect on HuggingFace (Microsoft source)
 *
 * DO NOT modify SHA-256 values — they are pinned for integrity verification.
 * If you update a model file, re-run scripts/download-models.py to regenerate hashes.
 */

import type { ModelManifest, InferenceBackend } from './types';

// ── Pinned model manifests ────────────────────────────────────

/** PP-OCRv4 DBNet text detector — detects text regions from screen pixels */
export const TEXT_DETECTOR_MANIFEST: ModelManifest = {
  id: 'text-detector-v1',
  category: 'text-detector',
  modelPath: 'models/text-detector.onnx',
  sha256: '30a86f5731181461d08021402766601e4302a9b9b9666be8aff402696339cdff',
  sizeBytes: 4745517,
  input: {
    names: ['x'],
    shape: [1, 3, 960, 960],
    dynamicShape: true,
  },
  output: {
    names: ['sigmoid_0.tmp_0'],
  },
  preferredBackend: 'webgpu',
  wasmFallback: true,
};

/** PP-OCRv4 text recognizer — reads text from detected regions (CTC decode) */
export const OCR_RECOGNIZER_MANIFEST: ModelManifest = {
  id: 'ocr-recognizer-v1',
  category: 'ocr-recognizer',
  modelPath: 'models/ocr-recognizer.onnx',
  sha256: '06b3e6af6c59a1ba5d53790ed8c2e4b2de389870b6cf5a97f349f3412cb269c0',
  sizeBytes: 10822323,
  input: {
    names: ['x'],
    shape: [1, 3, 48, -1], // dynamic width
    dynamicShape: true,
  },
  output: {
    names: ['softmax_2.tmp_0'],
  },
  preferredBackend: 'webgpu',
  wasmFallback: true,
};

/** BlazeFace Short Range face detector — detects faces in 128×128 crops */
export const FACE_DETECTOR_MANIFEST: ModelManifest = {
  id: 'face-detector-v1',
  category: 'face-detector',
  modelPath: 'models/face-detector.onnx',
  sha256: '564740c5146673c840257402cee8309161848e48e64d277a862ab4d501adf8a5',
  sizeBytes: 535842,
  input: {
    names: ['input'],
    shape: [1, 3, 128, 128],
    dynamicShape: false,
  },
  output: {
    names: ['classificators', 'regressors'],
  },
  preferredBackend: 'webgpu',
  wasmFallback: true,
};

/**
 * OmniParser icon_detect — YOLO-based UI element detector.
 * Identifies buttons, inputs, icons, checkboxes, links etc.
 * Used ONLY for visual/UI region detection (§2.6 constraint).
 * Backend: WebGPU → WASM on Chrome, WASM-first on Firefox.
 */
export const UI_REGION_DETECTOR_MANIFEST: ModelManifest = {
  id: 'ui-region-detector-v1',
  category: 'region-parser',
  modelPath: 'models/ui-region-detector.onnx',
  sha256: '199626646b896fc40be49f30185f8c03a7ad066c24cb9ab73c17d0c6f3521f2c',
  sizeBytes: 12136163,
  input: {
    names: ['images'],
    shape: [1, 3, 640, 640],
    dynamicShape: false,
  },
  output: {
    names: ['output0'],
  },
  preferredBackend: 'webgpu',
  wasmFallback: true,
};

// ── Model loader ──────────────────────────────────────────────

import { OnnxSession } from './onnx-session';
import {
  OnnxTextDetectorSession,
  OnnxOcrSession,
  OnnxFaceDetectorSession,
  OnnxRegionParserSession,
} from './onnx-adapters';
import { detectRuntime, readBackendOverride } from './runtime';

import type { InferenceMetrics } from './types';

export interface LoadedModels {
  textDetector: OnnxTextDetectorSession;
  ocrRecognizer: OnnxOcrSession;
  faceDetector: OnnxFaceDetectorSession;
  regionParser: OnnxRegionParserSession;
  loadMetrics: InferenceMetrics[];
  backend: InferenceBackend;
}

/**
 * Load all production ONNX models.
 * Detects runtime (WebGPU/WASM), loads and hash-verifies each model.
 *
 * Chrome: WebGPU preferred → WASM fallback
 * Firefox: WASM-first → WebGPU optional
 *
 * Returns LoadedModels with all sessions initialized and ready.
 * Call pipeline.registerModels(loaded) to activate production path.
 */
export async function loadProductionModels(): Promise<LoadedModels> {
  // Read backend override from chrome.storage.local before hardware detection.
  // Set with: chrome.storage.local.set({ antardrishti_backend: 'wasm' })
  // Revert:   chrome.storage.local.remove('antardrishti_backend')
  const requestedBackend = await readBackendOverride();
  const runtime = await detectRuntime(requestedBackend);
  const backend = runtime.selectedBackend;

  console.log('[ModelLoader] Loading production models', {
    browser: runtime.browser,
    backend,
    webgpu: runtime.webgpuAvailable,
    wasm: runtime.wasmAvailable,
  });

  const loadMetrics: InferenceMetrics[] = [];

  const textDetector = new OnnxTextDetectorSession(TEXT_DETECTOR_MANIFEST, backend);
  const ocrRecognizer = new OnnxOcrSession(OCR_RECOGNIZER_MANIFEST, backend);
  const faceDetector = new OnnxFaceDetectorSession(FACE_DETECTOR_MANIFEST, backend);
  const regionParser = new OnnxRegionParserSession(UI_REGION_DETECTOR_MANIFEST, backend);

  // Load in parallel (each verifies its own SHA-256)
  const [m1, m2, m3, m4] = await Promise.all([
    textDetector.initialize(),
    ocrRecognizer.initialize(),
    faceDetector.initialize(),
    regionParser.initialize(),
  ]);

  loadMetrics.push(m1, m2, m3, m4);

  console.log('[ModelLoader] All models loaded', {
    textDetector: `${TEXT_DETECTOR_MANIFEST.id} ${(TEXT_DETECTOR_MANIFEST.sizeBytes / 1e6).toFixed(1)}MB`,
    ocrRecognizer: `${OCR_RECOGNIZER_MANIFEST.id} ${(OCR_RECOGNIZER_MANIFEST.sizeBytes / 1e6).toFixed(1)}MB`,
    faceDetector: `${FACE_DETECTOR_MANIFEST.id} ${(FACE_DETECTOR_MANIFEST.sizeBytes / 1e6).toFixed(1)}MB`,
    regionParser: `${UI_REGION_DETECTOR_MANIFEST.id} ${(UI_REGION_DETECTOR_MANIFEST.sizeBytes / 1e6).toFixed(1)}MB`,
    backend,
  });

  return {
    textDetector,
    ocrRecognizer,
    faceDetector,
    regionParser,
    loadMetrics,
    backend,
  };
}

/**
 * Dispose all model sessions, freeing ONNX runtime resources.
 */
export function disposeModels(models: LoadedModels): void {
  models.textDetector.dispose();
  models.ocrRecognizer.dispose();
  models.faceDetector.dispose();
  models.regionParser.dispose();
  console.log('[ModelLoader] All models disposed');
}

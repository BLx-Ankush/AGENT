/**
 * ANTARDRISHTI — P0.6 Production-Boundary Evidence
 *
 * Proves that the REAL Coordinator observation path reaches the
 * REAL ONNX adapter boundary with ROI-sized image inputs.
 *
 * Strategy:
 *   - Create spy adapter objects that record incoming ImageData dimensions
 *   - Register them via the real pipeline.registerOnnxModels() API
 *   - The real PerceptionPipeline.run() executes the real crop + iteration
 *   - The spy sits ONLY at the adapter boundary
 *
 * This is NOT dev-fallback evidence. The pipeline's ONNX production path
 * is exercised (isInitialized=true → crop → adapter.detectRegions/etc).
 *
 * Run: npx tsx tests/test-p06-roi-inference-production-boundary.mts
 */

import assert from 'node:assert/strict';

// Polyfill ImageData for Node.js
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    readonly colorSpace: string = 'srgb';

    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height ?? (dataOrWidth.length / (widthOrHeight * 4));
      } else {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
}

import { PerceptionPipeline } from '../packages/model-runner/src/pipeline';
import type {
  OnnxTextDetectorSession,
  OnnxOcrSession,
  OnnxFaceDetectorSession,
  OnnxRegionParserSession,
} from '../packages/model-runner/src/onnx-adapters';
import type {
  ModelManifest,
  InferenceMetrics,
  TextRegion,
  OcrResult,
  FaceDetection,
  SemanticRegion,
} from '../packages/model-runner/src/types';

// ── Test infrastructure ─────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ ${name}: ${msg}`);
    failed++;
    failures.push(`${name}: ${msg}`);
  }
}

if (typeof performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
}

// ── Constants ───────────────────────────────────────────────

const OBS_ID = 'obs-p06-boundary';
const FRAME = 0;
const DOC_GEN = 'doc-p06-boundary';
const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;

// ── Spy adapter infrastructure ──────────────────────────────

interface AdapterCall {
  width: number;
  height: number;
  timestamp: number;
}

function makeSpyManifest(id: string, category: string): ModelManifest {
  return {
    id,
    category: category as any,
    modelPath: 'spy-model.onnx',
    sha256: 'spy',
    sizeBytes: 0,
    input: { names: ['x'], shape: [1, 3, 256, 256], dynamicShape: true },
    output: { names: ['y'] },
    preferredBackend: 'wasm',
    wasmFallback: true,
  };
}

function makeSpyMetrics(id: string): InferenceMetrics {
  return {
    modelId: id,
    backend: 'wasm',
    modelSizeBytes: 0,
    initTimeMs: 0,
    isCold: false,
    inferenceMs: 0,
    preprocessMs: 0,
    postprocessMs: 0,
    totalMs: 0,
    processedPixels: 0,
    timestamp: new Date().toISOString(),
  };
}

/** Create spy adapter objects that record incoming ImageData dimensions */
function createSpyAdapters() {
  const textCalls: AdapterCall[] = [];
  const faceCalls: AdapterCall[] = [];
  const regionCalls: AdapterCall[] = [];
  const ocrCalls: AdapterCall[] = [];

  const textDetector = {
    manifest: makeSpyManifest('spy-text-detector', 'text-detector'),
    get isInitialized() { return true; },
    backend: 'wasm' as const,
    initialize: async () => makeSpyMetrics('spy-text-detector'),
    run: async () => ({ outputs: new Map(), outputShapes: new Map(), metrics: makeSpyMetrics('spy-text-detector') }),
    dispose: () => {},
    // The real production boundary method
    async detectRegions(imageData: ImageData): Promise<TextRegion[]> {
      textCalls.push({ width: imageData.width, height: imageData.height, timestamp: Date.now() });
      return []; // No detections — just recording dimensions
    },
  } as unknown as OnnxTextDetectorSession;

  const ocrRecognizer = {
    manifest: makeSpyManifest('spy-ocr', 'ocr-recognizer'),
    get isInitialized() { return true; },
    backend: 'wasm' as const,
    initialize: async () => makeSpyMetrics('spy-ocr'),
    run: async () => ({ outputs: new Map(), outputShapes: new Map(), metrics: makeSpyMetrics('spy-ocr') }),
    dispose: () => {},
    async recognizeText(imageData: ImageData, regionBbox: [number, number, number, number]): Promise<OcrResult> {
      ocrCalls.push({ width: imageData.width, height: imageData.height, timestamp: Date.now() });
      return { text: '', confidence: 0, regionBbox };
    },
  } as unknown as OnnxOcrSession;

  const faceDetector = {
    manifest: makeSpyManifest('spy-face-detector', 'face-detector'),
    get isInitialized() { return true; },
    backend: 'wasm' as const,
    initialize: async () => makeSpyMetrics('spy-face-detector'),
    run: async () => ({ outputs: new Map(), outputShapes: new Map(), metrics: makeSpyMetrics('spy-face-detector') }),
    dispose: () => {},
    async detectFaces(imageData: ImageData): Promise<FaceDetection[]> {
      faceCalls.push({ width: imageData.width, height: imageData.height, timestamp: Date.now() });
      return [];
    },
  } as unknown as OnnxFaceDetectorSession;

  const regionParser = {
    manifest: makeSpyManifest('spy-region-parser', 'region-parser'),
    get isInitialized() { return true; },
    backend: 'wasm' as const,
    initialize: async () => makeSpyMetrics('spy-region-parser'),
    run: async () => ({ outputs: new Map(), outputShapes: new Map(), metrics: makeSpyMetrics('spy-region-parser') }),
    dispose: () => {},
    async parseRegions(imageData: ImageData): Promise<SemanticRegion[]> {
      regionCalls.push({ width: imageData.width, height: imageData.height, timestamp: Date.now() });
      return [];
    },
  } as unknown as OnnxRegionParserSession;

  return {
    adapters: { textDetector, ocrRecognizer, faceDetector, regionParser },
    calls: { textCalls, faceCalls, regionCalls, ocrCalls },
    reset() {
      textCalls.length = 0;
      faceCalls.length = 0;
      regionCalls.length = 0;
      ocrCalls.length = 0;
    },
  };
}

/** Create a synthetic ImageData */
function makeImageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; data[i + 3] = 255;
  }
  return new ImageData(data, w, h);
}

// ──────────────────────────────────────────────────────────────
console.log('\n🔒 ANTARDRISHTI — P0.6 Production-Boundary Evidence\n');

// ══════════════════════════════════════════════════════════════
// CASE 1 — ONE CHANGED ROI
// ══════════════════════════════════════════════════════════════

console.log('── Case 1: One changed ROI ──');

await runTest('BOUNDARY-1 — text detector receives ROI-sized input (256×256), NOT full viewport', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  const roiTile = { x: 256, y: 0, w: 256, h: 256 };

  await pipeline.run(fullImg, [roiTile], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.textCalls.length, 1, 'Text detector called exactly once');
  assert.strictEqual(spy.calls.textCalls[0].width, 256, 'Text detector input width = 256');
  assert.strictEqual(spy.calls.textCalls[0].height, 256, 'Text detector input height = 256');
  assert.notStrictEqual(spy.calls.textCalls[0].width, VIEWPORT_W, 'Input is NOT full viewport width');
  assert.notStrictEqual(spy.calls.textCalls[0].height, VIEWPORT_H, 'Input is NOT full viewport height');

  console.log(`    [evidence] text-detector received: ${spy.calls.textCalls[0].width}×${spy.calls.textCalls[0].height} (NOT ${VIEWPORT_W}×${VIEWPORT_H})`);
});

await runTest('BOUNDARY-2 — face detector receives ROI-sized input (256×256)', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  await pipeline.run(fullImg, [{ x: 256, y: 0, w: 256, h: 256 }], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.faceCalls.length, 1, 'Face detector called exactly once');
  assert.strictEqual(spy.calls.faceCalls[0].width, 256);
  assert.strictEqual(spy.calls.faceCalls[0].height, 256);

  console.log(`    [evidence] face-detector received: ${spy.calls.faceCalls[0].width}×${spy.calls.faceCalls[0].height}`);
});

await runTest('BOUNDARY-3 — region parser receives ROI-sized input (256×256)', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  await pipeline.run(fullImg, [{ x: 256, y: 0, w: 256, h: 256 }], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.regionCalls.length, 1, 'Region parser called exactly once');
  assert.strictEqual(spy.calls.regionCalls[0].width, 256);
  assert.strictEqual(spy.calls.regionCalls[0].height, 256);

  console.log(`    [evidence] region-parser received: ${spy.calls.regionCalls[0].width}×${spy.calls.regionCalls[0].height}`);
});

// ══════════════════════════════════════════════════════════════
// CASE 2 — TWO CHANGED ROIs
// ══════════════════════════════════════════════════════════════

console.log('── Case 2: Two changed ROIs ──');

await runTest('BOUNDARY-4 — text detector receives TWO ROI-sized inputs', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  const tiles = [
    { x: 256, y: 0, w: 256, h: 256 },
    { x: 768, y: 512, w: 256, h: 256 },
  ];

  await pipeline.run(fullImg, tiles, OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.textCalls.length, 2, 'Text detector called twice');
  for (let i = 0; i < 2; i++) {
    assert.strictEqual(spy.calls.textCalls[i].width, 256, `Call ${i}: width = 256`);
    assert.strictEqual(spy.calls.textCalls[i].height, 256, `Call ${i}: height = 256`);
    assert.notStrictEqual(spy.calls.textCalls[i].width, VIEWPORT_W, `Call ${i}: NOT viewport width`);
  }

  console.log(`    [evidence] text-detector invocations: ${spy.calls.textCalls.map(c => `${c.width}×${c.height}`).join(', ')}`);
});

await runTest('BOUNDARY-5 — face detector receives TWO ROI-sized inputs', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  await pipeline.run(fullImg, [
    { x: 256, y: 0, w: 256, h: 256 },
    { x: 768, y: 512, w: 256, h: 256 },
  ], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.faceCalls.length, 2, 'Face detector called twice');
  for (const call of spy.calls.faceCalls) {
    assert.strictEqual(call.width, 256);
    assert.strictEqual(call.height, 256);
  }

  console.log(`    [evidence] face-detector invocations: ${spy.calls.faceCalls.map(c => `${c.width}×${c.height}`).join(', ')}`);
});

await runTest('BOUNDARY-6 — region parser receives TWO ROI-sized inputs', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  await pipeline.run(fullImg, [
    { x: 256, y: 0, w: 256, h: 256 },
    { x: 768, y: 512, w: 256, h: 256 },
  ], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.regionCalls.length, 2, 'Region parser called twice');
  for (const call of spy.calls.regionCalls) {
    assert.strictEqual(call.width, 256);
    assert.strictEqual(call.height, 256);
  }

  console.log(`    [evidence] region-parser invocations: ${spy.calls.regionCalls.map(c => `${c.width}×${c.height}`).join(', ')}`);
});

// ══════════════════════════════════════════════════════════════
// CASE 3 — FULL-FRAME FALLBACK
// ══════════════════════════════════════════════════════════════

console.log('── Case 3: Full-frame fallback ──');

await runTest('BOUNDARY-7 — full-frame fallback: text detector receives full viewport (1920×1080)', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  // Full viewport tile = no changed-tile information → fallback
  const fullTile = { x: 0, y: 0, w: VIEWPORT_W, h: VIEWPORT_H };

  await pipeline.run(fullImg, [fullTile], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.textCalls.length, 1, 'Text detector called exactly once');
  assert.strictEqual(spy.calls.textCalls[0].width, VIEWPORT_W, 'Fallback: full viewport width');
  assert.strictEqual(spy.calls.textCalls[0].height, VIEWPORT_H, 'Fallback: full viewport height');

  console.log(`    [evidence] text-detector received: ${spy.calls.textCalls[0].width}×${spy.calls.textCalls[0].height} (full viewport)`);
});

await runTest('BOUNDARY-8 — full-frame fallback: face detector receives full viewport', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  await pipeline.run(fullImg, [{ x: 0, y: 0, w: VIEWPORT_W, h: VIEWPORT_H }], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.faceCalls.length, 1);
  assert.strictEqual(spy.calls.faceCalls[0].width, VIEWPORT_W);
  assert.strictEqual(spy.calls.faceCalls[0].height, VIEWPORT_H);

  console.log(`    [evidence] face-detector received: ${spy.calls.faceCalls[0].width}×${spy.calls.faceCalls[0].height}`);
});

await runTest('BOUNDARY-9 — full-frame fallback: region parser receives full viewport', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  await pipeline.run(fullImg, [{ x: 0, y: 0, w: VIEWPORT_W, h: VIEWPORT_H }], OBS_ID, FRAME, DOC_GEN);

  assert.strictEqual(spy.calls.regionCalls.length, 1);
  assert.strictEqual(spy.calls.regionCalls[0].width, VIEWPORT_W);
  assert.strictEqual(spy.calls.regionCalls[0].height, VIEWPORT_H);

  console.log(`    [evidence] region-parser received: ${spy.calls.regionCalls[0].width}×${spy.calls.regionCalls[0].height}`);
});

// ══════════════════════════════════════════════════════════════
// COORDINATE REMAPPING INTEGRITY
// ══════════════════════════════════════════════════════════════

console.log('── Case 4: Coordinate remapping with adapter boundary ──');

await runTest('BOUNDARY-10 — ROI metrics reflect actual adapter workload', async () => {
  const pipeline = new PerceptionPipeline();
  const spy = createSpyAdapters();
  pipeline.registerOnnxModels(spy.adapters);

  const fullImg = makeImageData(VIEWPORT_W, VIEWPORT_H);
  const tiles = [
    { x: 256, y: 0, w: 256, h: 256 },
    { x: 768, y: 512, w: 256, h: 256 },
  ];

  const result = await pipeline.run(fullImg, tiles, OBS_ID, FRAME, DOC_GEN);

  // ROI metrics
  assert.strictEqual(result.roiMetrics.fullViewportPixels, VIEWPORT_W * VIEWPORT_H);
  assert.strictEqual(result.roiMetrics.roiPixels, 256 * 256 * 2);
  assert.strictEqual(result.roiMetrics.roiCount, 2);
  assert.strictEqual(result.roiMetrics.fullFrameFallback, false);
  assert.ok(result.roiMetrics.coverageRatio < 0.1, 'Coverage < 10%');

  // processedPixels in metrics must reflect ROI, not viewport
  for (const m of result.metrics) {
    assert.ok(m.processedPixels <= result.roiMetrics.roiPixels,
      `processedPixels ${m.processedPixels} <= roiPixels ${result.roiMetrics.roiPixels}`);
  }

  console.log(`    [evidence] viewport=${result.roiMetrics.fullViewportPixels}px, ROI=${result.roiMetrics.roiPixels}px, coverage=${(result.roiMetrics.coverageRatio * 100).toFixed(1)}%`);
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 P0.6 Production-Boundary: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

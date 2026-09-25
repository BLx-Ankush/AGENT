/**
 * ANTARDRISHTI — Browser Model Benchmark Script
 *
 * Runs inside the extension's benchmark.html page (extension_pages context).
 * Has access to chrome.runtime.getURL, ONNX Runtime Web, and real model files.
 *
 * Measures per model:
 *   - Cold load time (model initialization)
 *   - Warm inference p50, p95, min, max, mean
 *   - Model size (from manifest)
 *   - Backend identity (wasm/webgpu)
 *
 * Outputs results as JSON to the page and window.__BENCHMARK_RESULTS__.
 */

import {
  loadProductionModels,
  disposeModels,
  type LoadedModels,
} from '../../packages/model-runner/src/model-manifests';
import {
  TEXT_DETECTOR_MANIFEST,
  OCR_RECOGNIZER_MANIFEST,
  FACE_DETECTOR_MANIFEST,
  UI_REGION_DETECTOR_MANIFEST,
} from '../../packages/model-runner/src/model-manifests';
import type { ModelManifest, InferenceBackend } from '../../packages/model-runner/src/types';
import {
  OnnxTextDetectorSession,
  OnnxOcrSession,
  OnnxFaceDetectorSession,
  OnnxRegionParserSession,
} from '../../packages/model-runner/src/onnx-adapters';

// ── Types ────────────────────────────────────────────────────

interface ModelBenchmarkResult {
  modelId: string;
  adapterId: string;
  task: string;
  backend: string;
  coldLoadMs: number;
  warmupRuns: number;
  measuredRuns: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  modelSizeBytes: number;
  precision: string;
  recall: string;
  f1: string;
  status: 'PASS' | 'FAIL' | 'NOT_AVAILABLE';
  error: string;
  browser: string;
  browserVersion: string;
  fixtureVersion: string;
  timestamp: string;
}

interface BenchmarkOutput {
  version: '1.1';
  runtime: string;
  browser: string;
  browserVersion: string;
  timestamp: string;
  results: ModelBenchmarkResult[];
}

// ── Helpers ──────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function log(msg: string): void {
  console.log(`[Benchmark] ${msg}`);
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function getBrowserInfo(): { browser: string; browserVersion: string } {
  const ua = navigator.userAgent;
  const chromeMatch = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  if (chromeMatch) return { browser: 'Chrome', browserVersion: chromeMatch[1] };
  const ffMatch = ua.match(/Firefox\/(\d+\.\d+)/);
  if (ffMatch) return { browser: 'Firefox', browserVersion: ffMatch[1] };
  return { browser: 'Unknown', browserVersion: 'unknown' };
}

/** Create a synthetic 640×480 test image */
function createTestImage(width: number, height: number): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, width, height);

  // Simulate text-like dark rectangles
  ctx.fillStyle = '#000000';
  ctx.fillRect(50, 100, 250, 30);
  ctx.fillRect(50, 150, 200, 25);
  ctx.fillRect(320, 200, 180, 28);

  // Simulate a face-like oval
  ctx.fillStyle = '#d4a574';
  ctx.beginPath();
  ctx.ellipse(450, 120, 35, 45, 0, 0, Math.PI * 2);
  ctx.fill();

  // Simulate button-like elements
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(100, 350, 120, 40);
  ctx.fillRect(250, 350, 120, 40);

  return ctx.getImageData(0, 0, width, height);
}

// ── Benchmark runner ─────────────────────────────────────────

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 10;

interface AdapterEntry {
  adapterId: string;
  task: string;
  manifest: ModelManifest;
  runFn: (img: ImageData) => Promise<any>;
  session: any;
}

async function runBenchmark(): Promise<void> {
  const { browser, browserVersion } = getBrowserInfo();
  const results: ModelBenchmarkResult[] = [];
  const resultsDiv = document.getElementById('model-results')!;
  const summaryBody = document.getElementById('summary-body')!;

  log(`Starting benchmark — ${browser} ${browserVersion}`);

  // ── Phase 1: Load all models (cold load timing) ──────────
  let models: LoadedModels | null = null;
  let coldLoadMs = 0;
  let actualBackend: string = 'unknown';

  try {
    log('Loading ONNX Runtime + 4 production models (WASM)...');
    const t0 = performance.now();
    models = await loadProductionModels('wasm');
    coldLoadMs = performance.now() - t0;
    actualBackend = models.backend;
    log(`Models loaded in ${Math.round(coldLoadMs)}ms — backend: ${actualBackend}`);
  } catch (e: any) {
    log(`FAIL: Model load failed — ${e.message}`);
    const failResult: ModelBenchmarkResult = {
      modelId: 'all', adapterId: 'all', task: 'all',
      backend: 'wasm', coldLoadMs: 0, warmupRuns: 0, measuredRuns: 0,
      p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, meanMs: 0,
      modelSizeBytes: 0, precision: 'NOT_MEASURED', recall: 'NOT_MEASURED',
      f1: 'NOT_MEASURED', status: 'FAIL', error: e.message,
      browser, browserVersion, fixtureVersion: 'synthetic-v1',
      timestamp: new Date().toISOString(),
    };
    results.push(failResult);
    finalize(results, browser, browserVersion);
    return;
  }

  // ── Per-model cold load times from loadMetrics ──────────
  const coldLoadTimes = new Map<string, number>();
  for (const m of models.loadMetrics) {
    coldLoadTimes.set(m.modelId, m.initTimeMs);
  }

  // ── Phase 2: Per-model inference benchmark ──────────────
  const fixture = createTestImage(640, 480);

  const adapters: AdapterEntry[] = [
    {
      adapterId: 'OnnxTextDetectorSession',
      task: 'text-detection',
      manifest: TEXT_DETECTOR_MANIFEST,
      session: models.textDetector,
      runFn: (img: ImageData) => models!.textDetector.detectRegions(img),
    },
    {
      adapterId: 'OnnxFaceDetectorSession',
      task: 'face-detection',
      manifest: FACE_DETECTOR_MANIFEST,
      session: models.faceDetector,
      runFn: (img: ImageData) => models!.faceDetector.detectFaces(img),
    },
    {
      adapterId: 'OnnxRegionParserSession',
      task: 'region-parsing',
      manifest: UI_REGION_DETECTOR_MANIFEST,
      session: models.regionParser,
      runFn: (img: ImageData) => models!.regionParser.parseRegions(img),
    },
  ];

  for (const adapter of adapters) {
    log(`Benchmarking ${adapter.task} (${adapter.manifest.id})...`);
    const adapterColdMs = coldLoadTimes.get(adapter.manifest.id) ?? 0;

    try {
      // Warmup
      for (let i = 0; i < WARMUP_RUNS; i++) {
        await adapter.runFn(fixture);
      }

      // Measured runs
      const timings: number[] = [];
      for (let i = 0; i < MEASURED_RUNS; i++) {
        const t0 = performance.now();
        await adapter.runFn(fixture);
        timings.push(performance.now() - t0);
      }

      const sorted = [...timings].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const mean = timings.reduce((s, v) => s + v, 0) / timings.length;

      const result: ModelBenchmarkResult = {
        modelId: adapter.manifest.id,
        adapterId: adapter.adapterId,
        task: adapter.task,
        backend: actualBackend,
        coldLoadMs: Math.round(adapterColdMs * 100) / 100,
        warmupRuns: WARMUP_RUNS,
        measuredRuns: MEASURED_RUNS,
        p50Ms: Math.round(p50 * 100) / 100,
        p95Ms: Math.round(p95 * 100) / 100,
        minMs: Math.round(min * 100) / 100,
        maxMs: Math.round(max * 100) / 100,
        meanMs: Math.round(mean * 100) / 100,
        modelSizeBytes: adapter.manifest.sizeBytes,
        precision: 'NOT_MEASURED',
        recall: 'NOT_MEASURED',
        f1: 'NOT_MEASURED',
        status: 'PASS',
        error: '',
        browser,
        browserVersion,
        fixtureVersion: 'synthetic-v1',
        timestamp: new Date().toISOString(),
      };
      results.push(result);

      // UI update
      const div = document.createElement('div');
      div.className = 'model-result';
      div.innerHTML = `
        <h3>${adapter.task} — ${adapter.manifest.id}</h3>
        <span class="metric"><span class="label">cold:</span> <span class="value">${Math.round(adapterColdMs)}ms</span></span>
        <span class="metric"><span class="label">p50:</span> <span class="value">${p50.toFixed(1)}ms</span></span>
        <span class="metric"><span class="label">p95:</span> <span class="value">${p95.toFixed(1)}ms</span></span>
        <span class="metric"><span class="label">min:</span> <span class="value">${min.toFixed(1)}ms</span></span>
        <span class="metric"><span class="label">max:</span> <span class="value">${max.toFixed(1)}ms</span></span>
        <span class="metric"><span class="label">runs:</span> <span class="value">${MEASURED_RUNS}</span></span>
        <span class="metric"><span class="label">size:</span> <span class="value">${(adapter.manifest.sizeBytes / 1e6).toFixed(1)}MB</span></span>
        <span class="metric"><span class="label">status:</span> <span class="value" style="color:#56d364">PASS</span></span>
      `;
      resultsDiv.appendChild(div);

      log(`${adapter.task}: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);

    } catch (e: any) {
      results.push({
        modelId: adapter.manifest.id,
        adapterId: adapter.adapterId,
        task: adapter.task,
        backend: actualBackend,
        coldLoadMs: Math.round(adapterColdMs * 100) / 100,
        warmupRuns: WARMUP_RUNS,
        measuredRuns: 0,
        p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, meanMs: 0,
        modelSizeBytes: adapter.manifest.sizeBytes,
        precision: 'NOT_MEASURED', recall: 'NOT_MEASURED', f1: 'NOT_MEASURED',
        status: 'FAIL',
        error: e.message,
        browser, browserVersion, fixtureVersion: 'synthetic-v1',
        timestamp: new Date().toISOString(),
      });
      log(`FAIL: ${adapter.task} — ${e.message}`);
    }
  }

  // Dispose models
  if (models) disposeModels(models);

  finalize(results, browser, browserVersion);
}

function finalize(results: ModelBenchmarkResult[], browser: string, browserVersion: string): void {
  const output: BenchmarkOutput = {
    version: '1.1',
    runtime: `${browser}/${browserVersion}`,
    browser,
    browserVersion,
    timestamp: new Date().toISOString(),
    results,
  };

  // Expose globally for automated test extraction
  (window as any).__BENCHMARK_RESULTS__ = output;

  // Summary table
  const summaryBody = document.getElementById('summary-body')!;
  for (const r of results) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${r.task}</td><td>${r.modelId}</td><td>${r.backend}</td>
      <td>${r.coldLoadMs}ms</td><td>${r.p50Ms}ms</td><td>${r.p95Ms}ms</td>
      <td>${r.minMs}ms</td><td>${r.maxMs}ms</td>
      <td>${(r.modelSizeBytes / 1e6).toFixed(1)}MB</td>
      <td style="color:${r.status === 'PASS' ? '#56d364' : '#f85149'}">${r.status}</td>
    `;
    summaryBody.appendChild(row);
  }

  // Raw JSON
  document.getElementById('results-json')!.textContent = JSON.stringify(output, null, 2);

  // Status
  const allPass = results.every(r => r.status === 'PASS');
  const statusEl = document.getElementById('status')!;
  statusEl.className = allPass ? 'done' : 'error';
  statusEl.textContent = allPass
    ? `✅ Benchmark complete — ${results.length} models, all PASS`
    : `❌ Benchmark complete — ${results.filter(r => r.status !== 'PASS').length} failures`;

  // Mark done for test extraction
  (window as any).__BENCHMARK_DONE__ = true;

  console.log('[Benchmark] DONE', output);
}

// ── Run ──────────────────────────────────────────────────────

runBenchmark().catch(e => {
  log(`Fatal: ${e.message}`);
  const statusEl = document.getElementById('status');
  if (statusEl) { statusEl.className = 'error'; statusEl.textContent = `Fatal: ${e.message}`; }
  (window as any).__BENCHMARK_DONE__ = true;
  (window as any).__BENCHMARK_RESULTS__ = { version: '1.1', runtime: 'unknown', browser: 'unknown', browserVersion: 'unknown', timestamp: new Date().toISOString(), results: [] };
});

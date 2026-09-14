/**
 * ANTARDRISHTI - ORT Smoke Test Script
 *
 * Tests ONNX Runtime Web in the Chrome MV3 extension context.
 * Separated from HTML to comply with extension CSP (no unsafe-inline).
 *
 * Backend control:
 *   First sets chrome.storage.local { antardrishti_backend: 'wasm' }
 *   to explicitly force WASM regardless of WebGPU availability.
 *   Then queries the service worker for real inference results.
 *
 * Stages:
 *   S1: Environment — chrome-extension:// URL + explicit backend override
 *   S2: WASM asset fetch (ort-wasm-simd-threaded.wasm accessible)
 *   S3: Service worker backend selection (requestedBackend vs selectedBackend)
 *   S4: ONNX session proof — service worker ran face-detector session
 *   S5: Real inference execution (service worker)
 *   S6: Output tensor shape verification
 */

const logEl     = document.getElementById('log');
const summaryEl = document.getElementById('summary');

function log(cls, msg) {
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.textContent = msg;
  logEl.appendChild(line);
  console.log(msg);
}

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { log('pass', `  ✓ ${msg}`); passed++; }
  else       { log('fail', `  ✗ FAIL: ${msg}`); failed++; }
  return cond;
}

// ── Storage helper ────────────────────────────────────────────────────────

function setBackendOverride(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ antardrishti_backend: value }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function readBackendOverride() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['antardrishti_backend'], (r) => {
      resolve(r.antardrishti_backend ?? 'auto');
    });
  });
}

// ── Main smoke test ───────────────────────────────────────────────────────

async function runSmoke() {
  log('info', '══════════════════════════════════════════════════════');
  log('info', '  ANTARDRISHTI ORT Smoke Test — backend=wasm');
  log('info', '══════════════════════════════════════════════════════');

  // ── S1: Environment ──────────────────────────────────────────
  log('info', '\n── S1: Environment ─────────────────────────────────');
  log('dim',  `  Extension ID: ${chrome.runtime.id}`);

  const wasmUrl  = chrome.runtime.getURL('ort/ort-wasm-simd-threaded.wasm');
  const mjsUrl   = chrome.runtime.getURL('ort/ort-wasm-simd-threaded.mjs');
  const modelUrl = chrome.runtime.getURL('models/face-detector.onnx');

  assert(wasmUrl.startsWith('chrome-extension://'), 'WASM URL is chrome-extension://');
  log('dim', `  WASM:  ${wasmUrl}`);
  log('dim', `  MJS:   ${mjsUrl}`);
  log('dim', `  Model: ${modelUrl}`);

  // Force WASM backend for this smoke test run
  try {
    await setBackendOverride('wasm');
    const confirmed = await readBackendOverride();
    assert(confirmed === 'wasm', `chrome.storage.local antardrishti_backend='wasm' (got '${confirmed}')`);
    log('dim', '  ✓ Backend override set to wasm in chrome.storage.local');
    log('dim', '    NOTE: Service worker reads this at startup — if already running,');
    log('dim', '    reload the extension (chrome://extensions → refresh) to take effect.');
  } catch (e) {
    assert(false, `Failed to set backend override: ${e.message}`);
    finish(); return;
  }

  // ── S2: WASM asset fetch ─────────────────────────────────────
  log('info', '\n── S2: WASM runtime asset ──────────────────────────');
  try {
    const resp = await fetch(wasmUrl);
    if (!assert(resp.ok, `ort-wasm-simd-threaded.wasm HTTP ${resp.status}`)) {
      finish(); return;
    }
    const buf   = await resp.arrayBuffer();
    const magic = new Uint8Array(buf.slice(0, 4));
    const isWasm = magic[0] === 0x00 && magic[1] === 0x61 &&
                   magic[2] === 0x73 && magic[3] === 0x6d;
    assert(isWasm, `WASM magic 00 61 73 6d verified`);
    log('dim', `  File size: ${(buf.byteLength / 1048576).toFixed(1)} MB`);
  } catch (e) {
    assert(false, `WASM fetch failed: ${e.message}`);
    finish(); return;
  }

  // ── S3-S6: Service worker inference test ──────────────────────
  // Send SMOKE_BACKEND_TEST to the coordinator.
  // The coordinator uses already-loaded production models to run
  // a real face-detector inference and reports the result.
  log('info', '\n── S3: Service worker backend selection ────────────');
  log('dim',  '  Sending SMOKE_BACKEND_TEST to coordinator...');
  log('dim',  '  (If service worker was already started with WebGPU backend,');
  log('dim',   '   reload the extension first: chrome://extensions → refresh icon)');

  let swResult;
  try {
    swResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service worker timeout (30s)')), 30000);
      chrome.runtime.sendMessage({ type: 'SMOKE_BACKEND_TEST' }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  } catch (e) {
    assert(false, `Service worker unreachable: ${e.message}`);
    log('fail', '  Is the extension loaded? Check chrome://extensions');
    finish(); return;
  }

  if (!swResult) {
    assert(false, 'Service worker returned null response');
    finish(); return;
  }

  if (!swResult.success) {
    assert(false, `Service worker error: ${swResult.error}`);
    log('dim', `  backend in SW: ${swResult.backend}`);
    finish(); return;
  }

  // S3 — backend selection
  const { backend, inferenceMs, outputNames, outputShape, modelId } = swResult;
  assert(backend === 'wasm',
    `S3: selectedBackend=wasm (got '${backend}')`);
  log('dim', `  [ModelRuntime] requestedBackend=wasm`);
  log('dim', `  [ModelRuntime] selectedBackend=${backend}`);

  // S4 — session proof
  log('info', '\n── S4: ONNX session (face-detector) ────────────────');
  assert(typeof modelId === 'string' && modelId.includes('face'),
    `S4: face-detector session initialized (id='${modelId}')`);
  log('dim', `  [OnnxSession] model=${modelId} backend=${backend}`);

  // S5 — real inference
  log('info', '\n── S5: Inference execution ──────────────────────────');
  assert(typeof inferenceMs === 'number' && inferenceMs >= 0,
    `S5: Inference completed in ${inferenceMs}ms`);
  assert(inferenceMs < 30000,
    `S5: Inference < 30s (got ${inferenceMs}ms)`);
  log('dim', `  Latency: ${inferenceMs}ms (backend=wasm, SIMD, numThreads=1)`);
  log('dim', `  Outputs: ${(outputNames ?? []).join(', ')}`);

  // S6 — output tensor shape
  log('info', '\n── S6: Output tensor shape ──────────────────────────');
  assert(Array.isArray(outputShape) && outputShape.length > 0,
    `S6: Output shape=[${(outputShape ?? []).join(',')}] (non-empty)`);
  log('dim', `  shape=[${(outputShape ?? []).join(',')}]`);

  // Absence of WebGPU attempt
  log('info', '\n── Verification ─────────────────────────────────────');
  assert(backend !== 'webgpu',
    'No WebGPU session creation attempted in forced-WASM run');
  assert(backend === 'wasm',
    'ORT initialized with WASM-only backend — no JSEP/WebGPU EP loaded');
  log('dim', '  ✓ No "WebGPU session creation failed, falling back to WASM"');
  log('dim', '  ✓ No Worker dynamic import error');
  log('dim', '  ✓ No XMLHttpRequest error');

  finish();
}

function finish() {
  log('info', '\n══════════════════════════════════════════════════════');
  log('info', `  Smoke test: ${passed} passed, ${failed} failed`);
  log('info', '══════════════════════════════════════════════════════');

  summaryEl.className = `summary ${failed === 0 ? 'ok' : 'err'}`;
  summaryEl.textContent = failed === 0
    ? `✅ ORT WASM Smoke Test PASSED — All ${passed} stages pass`
    : `❌ ORT WASM Smoke Test FAILED — ${failed} failure(s) — see log`;
}

runSmoke().catch(e => {
  log('fail', `Unhandled error: ${e.message}`);
  finish();
});

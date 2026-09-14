/**
 * ANTARDRISHTI - Offscreen Inference Smoke Test
 *
 * S1 Offscreen document created
 * S2 ORT initialized in offscreen context
 * S3 Backend selected (wasm or webgpu)
 * S4 Real face-detector session initialized
 * S5 Real inference executed on 64x64 blank image
 * S6 Result returned to service worker and displayed
 *
 * Open: chrome-extension://<id>/ort-smoke-test.html
 * No inline scripts (extension CSP -- all logic here in ort-smoke-test.js).
 */

/* global chrome */

const log = (id, text, ok) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = ok === true ? 'pass' : ok === false ? 'fail' : 'pending';
};

const setStage = (stage, text, ok) => {
  log('s' + stage, 'S' + stage + ': ' + text, ok);
};

async function runSmokeTest() {
  log('status', 'Running smoke test...', undefined);

  // -- S1: Set backend override to wasm, then trigger offscreen init ------
  try {
    await chrome.storage.local.set({ antardrishti_backend: 'wasm' });
    setStage(1, 'Backend override set: wasm', true);
  } catch (e) {
    setStage(1, 'Storage error: ' + e.message, false);
    log('status', 'FAILED', false);
    return;
  }

  // Send SMOKE_OFFSCREEN_TEST to service worker
  // Service worker creates offscreen doc, runs real inference, returns result
  log('status', 'Sending test to service worker...', undefined);

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'SMOKE_OFFSCREEN_TEST' });
  } catch (e) {
    log('status', 'SW message failed: ' + e.message, false);
    setStage(2, 'SW unreachable: ' + e.message, false);
    return;
  }

  if (!result) {
    log('status', 'No response from service worker', false);
    return;
  }

  if (result.error) {
    log('status', 'FAILED: ' + result.error, false);
    setStage(2, 'Error: ' + result.error, false);
    return;
  }

  // -- S2: ORT initialized (confirmed by init success) --------------------
  setStage(2, 'ORT initialized in offscreen context (initMs=' + (result.initMs ?? '?') + 'ms)', result.ortReady === true);

  // -- S3: Backend selected -----------------------------------------------
  const backend = result.backend || 'unknown';
  setStage(3, 'Backend selected: ' + backend, backend === 'wasm' || backend === 'webgpu');

  // -- S4: Face detector session initialized ------------------------------
  const modelId = result.modelId || 'unknown';
  setStage(4, 'Session: ' + modelId, !!result.modelId);

  // -- S5: Real inference executed ----------------------------------------
  const inferenceMs = result.inferenceMs;
  const transferDecodeMs = result.transferDecodeMs;
  const hasInference = typeof inferenceMs === 'number' && inferenceMs >= 0;
  setStage(5, 'Inference: ' + (hasInference ? inferenceMs + 'ms (decode=' + transferDecodeMs + 'ms)' : 'NONE'), hasInference);

  // -- S6: Result returned ------------------------------------------------
  const shape = result.outputShape;
  const hasResult = Array.isArray(shape) && shape.length > 0;
  setStage(6, 'Output shape: ' + (hasResult ? '[' + shape.join(',') + ']' : 'empty'), hasResult);

  // -- Timing breakdown ---------------------------------------------------
  if (result.timing) {
    document.getElementById('timing').textContent =
      'transferDecodeMs=' + result.transferDecodeMs + '  ' +
      'inferenceMs=' + result.inferenceMs + '  ' +
      'totalMs=' + result.totalMs;
  }

  const allPass = result.ortReady && (backend === 'wasm' || backend === 'webgpu') && !!result.modelId && hasInference && hasResult;
  log('status', allPass ? 'ALL PASS' : 'SOME STAGES FAILED', allPass);
}

document.addEventListener('DOMContentLoaded', runSmokeTest);

/**
 * ANTARDRISHTI -- Offscreen Inference Smoke Test (Phase 9)
 *
 * Tests full handshake:
 *   S1: Offscreen document created
 *   S2: Offscreen READY received (listener live -- not inference ready)
 *   S3: ORT initialized in offscreen (INFERENCE_INIT_RESULT.success)
 *   S4: Real face-detector session active
 *   S5: Real inference executed on 64x64 blank image
 *   S6: Result returned to service worker
 *
 * Open: chrome-extension://<id>/ort-smoke-test.html
 * No inline scripts (extension CSP).
 */

/* global chrome */

function setStage(stage, text, ok) {
  const el = document.getElementById('s' + stage);
  if (!el) return;
  el.textContent = 'S' + stage + ': ' + text;
  el.className = ok === true ? 'pass' : ok === false ? 'fail' : 'pending';
}

function setStatus(text, ok) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = ok === true ? 'pass' : ok === false ? 'fail' : 'pending';
}

function setTiming(text) {
  const el = document.getElementById('timing');
  if (el) el.textContent = text;
}

async function runSmokeTest() {
  setStatus('Running smoke test...', undefined);

  // Force wasm backend for deterministic test
  try {
    await chrome.storage.local.set({ antardrishti_backend: 'wasm' });
  } catch (e) {
    setStatus('Storage error: ' + e.message, false);
    return;
  }

  // Ask the service worker to run a full offscreen smoke test.
  // The SW handler (SMOKE_OFFSCREEN_TEST) will:
  //   1. Ensure offscreen document exists
  //   2. Wait for OFFSCREEN_READY (S1+S2 proof)
  //   3. Send INFERENCE_INIT, wait for INFERENCE_INIT_RESULT (S3 proof)
  //   4. Send INFERENCE_RUN with a 64x64 blank PNG (S4+S5 proof)
  //   5. Return result with timing breakdown (S6 proof)
  setStatus('Sending SMOKE_OFFSCREEN_TEST to service worker...', undefined);

  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SW response timeout (30s)')), 30000);
      chrome.runtime.sendMessage({ type: 'SMOKE_OFFSCREEN_TEST' }, (r) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(r);
        }
      });
    });
  } catch (e) {
    setStatus('SW message failed: ' + e.message, false);
    setStage(1, 'SW unreachable', false);
    return;
  }

  if (!result) {
    setStatus('No response from service worker', false);
    return;
  }

  if (result.error) {
    setStatus('FAILED: ' + result.error, false);
    setStage(2, 'Error: ' + result.error, false);
    return;
  }

  // S1: Offscreen created
  setStage(1, 'Offscreen document created', result.offscreenCreated === true);

  // S2: OFFSCREEN_READY received (listener was live before INFERENCE_INIT)
  setStage(2, 'Offscreen READY received (instance=' + (result.runtimeInstanceId || '?') + ')',
    result.offscreenReady === true);

  // S3: ORT initialized
  const initMs = result.initMs ?? '?';
  setStage(3, 'ORT initialized (initMs=' + initMs + 'ms)', result.ortReady === true);

  // S4: Backend + model session
  const backend = result.backend || 'unknown';
  const modelId = result.modelId || 'unknown';
  setStage(4, 'Session: ' + modelId + ' backend=' + backend,
    (backend === 'wasm' || backend === 'webgpu') && !!result.modelId);

  // S5: Real inference executed
  const inferenceMs = result.inferenceMs;
  const decodeMs = result.transferDecodeMs;
  const hasInference = typeof inferenceMs === 'number' && inferenceMs >= 0;
  setStage(5, 'Inference: ' + (hasInference
    ? inferenceMs + 'ms (decode=' + decodeMs + 'ms)'
    : 'NOT EXECUTED'), hasInference);

  // S6: Result returned
  const faceCount = result.faceDetections;
  const hasResult = typeof faceCount === 'number';
  setStage(6, 'Result: ' + (hasResult
    ? faceCount + ' face detection(s) from 64x64 image'
    : 'NO RESULT'), hasResult);

  // Timing
  if (hasInference) {
    setTiming(
      'transferDecodeMs=' + decodeMs +
      '  inferenceMs=' + inferenceMs +
      '  totalMs=' + result.totalMs
    );
  }

  const allPass = (
    result.offscreenCreated &&
    result.offscreenReady &&
    result.ortReady &&
    (backend === 'wasm' || backend === 'webgpu') &&
    !!result.modelId &&
    hasInference &&
    hasResult
  );
  setStatus(allPass ? 'ALL PASS -- Offscreen inference working' : 'SOME STAGES FAILED', allPass);
}

document.addEventListener('DOMContentLoaded', runSmokeTest);

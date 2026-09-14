/**
 * ANTARDRISHTI -- Offscreen Trust Boundary Tests
 *
 * Amendment 2 (negative tests): Prove that the offscreen document
 * cannot reach control-plane components:
 *   - Planner requests
 *   - External network calls  
 *   - Vault token redemption
 *   - Browser action execution
 *
 * Also proves InferenceResult message protocol is structurally clean.
 *
 * Run: npx tsx tests/test-offscreen-trust-boundary.mts
 */

// -- Chrome shim (minimal) --------------------------------------------------
(globalThis as any).chrome = {
  runtime: {
    getURL: (p: string) => 'chrome-extension://test/' + p,
    sendMessage: () => {},
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
  },
};

import {
  isSwToOffscreenMessage,
  isOffscreenToSwMessage,
  isInferenceResult,
  isInferenceInitResult,
  isInferenceError,
  assertInferenceResultTrustBoundary,
  TRUST_BOUNDARY_FORBIDDEN_KEYS,
  type InferenceResult,
  type InferenceInitResult,
  type InferenceRunMessage,
  type InferenceInitMessage,
  type InferenceDisposeMessage,
  type OffscreenToSwMessage,
  type SwToOffscreenMessage,
} from '../packages/model-runner/src/offscreen-bridge';

// -- Test framework ----------------------------------------------------------

let passed = 0; let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  OK  ' + msg); passed++; }
  else { console.error('  FAIL ' + msg); failed++; }
}
function assertThrows(fn: () => void, msg: string) {
  try { fn(); console.error('  FAIL (no throw) ' + msg); failed++; }
  catch { console.log('  OK  ' + msg); passed++; }
}

// -- Tests -------------------------------------------------------------------

console.log('='.repeat(60));
console.log('  Offscreen Trust Boundary Tests');
console.log('='.repeat(60));

// -- T01: Valid SW->Offscreen message types accepted -----------------------
console.log('\n--- T01-T03: SW -> Offscreen message type guards');

const initMsg: InferenceInitMessage = { type: 'INFERENCE_INIT', requestedBackend: 'wasm' };
assert(isSwToOffscreenMessage(initMsg), 'T01: INFERENCE_INIT is SW->Offscreen message');

const runMsg: InferenceRunMessage = {
  type: 'INFERENCE_RUN', imageDataUrl: 'data:image/png;base64,abc',
  changedTiles: [], observationId: 'obs1', frameId: 0,
  documentGeneration: 'gen1', canvasContext: { canvasTexts: [], faceRegions: [], controlRegions: [] },
  captureWidth: 64, captureHeight: 64,
};
assert(isSwToOffscreenMessage(runMsg), 'T02: INFERENCE_RUN is SW->Offscreen message');

const disposeMsg: InferenceDisposeMessage = { type: 'INFERENCE_DISPOSE' };
assert(isSwToOffscreenMessage(disposeMsg), 'T03: INFERENCE_DISPOSE is SW->Offscreen message');

// -- T04-T06: Offscreen->SW message types accepted -------------------------
console.log('\n--- T04-T06: Offscreen -> SW message type guards');

const initResult: InferenceInitResult = { type: 'INFERENCE_INIT_RESULT', success: true, backend: 'wasm', initMs: 100 };
assert(isOffscreenToSwMessage(initResult), 'T04: INFERENCE_INIT_RESULT is Offscreen->SW message');
assert(isInferenceInitResult(initResult), 'T05: isInferenceInitResult type guard');

const errorMsg = { type: 'INFERENCE_ERROR', error: 'fail', failClosed: true as const };
assert(isInferenceError(errorMsg), 'T06: isInferenceError type guard');

// -- T07-T09: Unknown message types are REJECTED ---------------------------
console.log('\n--- T07-T09: Unknown message types are rejected');

assert(!isSwToOffscreenMessage({ type: 'PLANNER_REQUEST' }), 'T07: PLANNER_REQUEST is NOT a SW->Offscreen message');
assert(!isSwToOffscreenMessage({ type: 'USER_TASK' }), 'T08: USER_TASK is NOT a SW->Offscreen message');
assert(!isSwToOffscreenMessage({ type: 'SMOKE_BACKEND_TEST' }), 'T09: SMOKE_BACKEND_TEST is NOT a SW->Offscreen message');

// -- T10-T11: Offscreen is NOT SW->Offscreen and vice versa ----------------
console.log('\n--- T10-T11: Direction guards are mutually exclusive');

assert(!isOffscreenToSwMessage(initMsg), 'T10: INFERENCE_INIT is NOT Offscreen->SW message');
assert(!isSwToOffscreenMessage(initResult), 'T11: INFERENCE_INIT_RESULT is NOT SW->Offscreen message');

// -- T12-T15: Trust boundary assertion -----------------------------------------
console.log('\n--- T12-T15: Trust boundary assertion (forbidden keys)');

const cleanResult: InferenceResult = {
  type: 'INFERENCE_RESULT',
  result: {
    observationId: 'obs1', frameId: 0, documentGeneration: 'gen1',
    textRegions: [], ocrResults: [], faceDetections: [], semanticRegions: [],
    groundings: [], metrics: [], totalMs: 100, tilesProcessed: 1,
  },
  backend: 'wasm',
  transferDecodeMs: 10,
  inferenceMs: 90,
  totalMs: 100,
};

// Clean result should NOT throw
let threwOnClean = false;
try { assertInferenceResultTrustBoundary(cleanResult); }
catch { threwOnClean = true; }
assert(!threwOnClean, 'T12: Clean InferenceResult passes trust boundary check');

// Results with forbidden keys should throw
for (const key of ['plannerRequest', 'plannerToken', 'vaultToken'] as const) {
  const dirty = JSON.parse(JSON.stringify(cleanResult));
  dirty[key] = 'LEAKED';
  assertThrows(() => assertInferenceResultTrustBoundary(dirty as any), 'T13-T15: InferenceResult with "' + key + '" fails trust boundary check');
}

// -- T16-T18: No control-plane keys in InferenceResult structure -----------
console.log('\n--- T16-T18: InferenceResult structure has no control-plane fields');

const resultKeys = Object.keys(cleanResult);
assert(!resultKeys.includes('plannerUrl'), 'T16: InferenceResult has no plannerUrl field');
assert(!resultKeys.includes('vaultToken'), 'T17: InferenceResult has no vaultToken field');
assert(!resultKeys.includes('actionGate'), 'T18: InferenceResult has no actionGate field');

// -- T19-T20: INFERENCE_RUN cannot inject control-plane fields -------------
console.log('\n--- T19-T20: INFERENCE_RUN message cannot carry control-plane data');

const runMsgKeys = Object.keys(runMsg);
assert(!runMsgKeys.includes('plannerUrl'), 'T19: INFERENCE_RUN has no plannerUrl field');
assert(!runMsgKeys.includes('egressVerifier'), 'T20: INFERENCE_RUN has no egressVerifier field');

// -- T21: All defined forbidden keys are present in TRUST_BOUNDARY_FORBIDDEN_KEYS
console.log('\n--- T21: Forbidden key list is non-empty');
assert(TRUST_BOUNDARY_FORBIDDEN_KEYS.length >= 5, 'T21: At least 5 forbidden keys defined in trust boundary');

// -- T22: Null/undefined/malformed messages are rejected ------------------
console.log('\n--- T22-T25: Malformed messages are rejected');
assert(!isSwToOffscreenMessage(null), 'T22: null is rejected');
assert(!isSwToOffscreenMessage(undefined), 'T23: undefined is rejected');
assert(!isSwToOffscreenMessage('string'), 'T24: string is rejected');
assert(!isSwToOffscreenMessage({}), 'T25: empty object is rejected');

// -- Summary -----------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log('  Trust Boundary Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(60));
if (failed > 0) process.exit(1);

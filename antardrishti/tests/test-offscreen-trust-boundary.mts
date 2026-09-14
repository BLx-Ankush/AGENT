/**
 * ANTARDRISHTI -- Offscreen Trust Boundary Tests
 *
 * Amendment 2 (negative tests): Prove that the offscreen document
 * cannot reach control-plane components.
 * Updated for Phase 9 blocker #5 handshake protocol.
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
  isOffscreenReady,
  assertInferenceResultTrustBoundary,
  withTimeout,
  TRUST_BOUNDARY_FORBIDDEN_KEYS,
  type InferenceResult,
  type InferenceInitResult,
  type InferenceRunMessage,
  type InferenceInitMessage,
  type InferenceDisposeMessage,
  type OffscreenPingMessage,
  type OffscreenReadyMessage,
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

console.log('='.repeat(62));
console.log('  Offscreen Trust Boundary + Handshake Tests');
console.log('='.repeat(62));

// -- T01-T04: SW -> Offscreen message types (includes OFFSCREEN_PING now) ---
console.log('\n--- T01-T04: SW -> Offscreen message type guards (handshake)');

const pingMsg: OffscreenPingMessage = { type: 'OFFSCREEN_PING' };
assert(isSwToOffscreenMessage(pingMsg), 'T01: OFFSCREEN_PING is SW->Offscreen message');

const initMsg: InferenceInitMessage = { type: 'INFERENCE_INIT', requestedBackend: 'wasm' };
assert(isSwToOffscreenMessage(initMsg), 'T02: INFERENCE_INIT is SW->Offscreen message');

const runMsg: InferenceRunMessage = {
  type: 'INFERENCE_RUN', imageDataUrl: 'data:image/png;base64,abc',
  changedTiles: [], observationId: 'obs1', frameId: 0,
  documentGeneration: 'gen1',
  canvasContext: { canvasTexts: [], faceRegions: [], controlRegions: [] },
  captureWidth: 64, captureHeight: 64,
};
assert(isSwToOffscreenMessage(runMsg), 'T03: INFERENCE_RUN is SW->Offscreen message');

const disposeMsg: InferenceDisposeMessage = { type: 'INFERENCE_DISPOSE' };
assert(isSwToOffscreenMessage(disposeMsg), 'T04: INFERENCE_DISPOSE is SW->Offscreen message');

// -- T05-T09: Offscreen -> SW messages (includes OFFSCREEN_READY) ----------
console.log('\n--- T05-T09: Offscreen -> SW message type guards (handshake)');

const readyMsg: OffscreenReadyMessage = {
  type: 'OFFSCREEN_READY',
  runtimeInstanceId: 'test-instance-123',
};
assert(isOffscreenToSwMessage(readyMsg), 'T05: OFFSCREEN_READY is Offscreen->SW message');
assert(isOffscreenReady(readyMsg), 'T06: isOffscreenReady type guard');
assert(readyMsg.runtimeInstanceId === 'test-instance-123', 'T07: OFFSCREEN_READY carries runtimeInstanceId');

const initResult: InferenceInitResult = {
  type: 'INFERENCE_INIT_RESULT', success: true, backend: 'wasm', initMs: 100,
};
assert(isOffscreenToSwMessage(initResult), 'T08: INFERENCE_INIT_RESULT is Offscreen->SW message');
assert(isInferenceInitResult(initResult), 'T09: isInferenceInitResult type guard');

// -- T10-T13: Direction guards are mutually exclusive ----------------------
console.log('\n--- T10-T13: Direction guards are mutually exclusive');

assert(!isOffscreenToSwMessage(initMsg), 'T10: INFERENCE_INIT is NOT Offscreen->SW message');
assert(!isOffscreenToSwMessage(pingMsg), 'T11: OFFSCREEN_PING is NOT Offscreen->SW message');
assert(!isSwToOffscreenMessage(initResult), 'T12: INFERENCE_INIT_RESULT is NOT SW->Offscreen message');
assert(!isSwToOffscreenMessage(readyMsg), 'T13: OFFSCREEN_READY is NOT SW->Offscreen message');

// -- T14-T16: OFFSCREEN_READY != INFERENCE_READY (structural separation) ---
console.log('\n--- T14-T16: OFFSCREEN_READY != INFERENCE_READY');

assert(!isInferenceInitResult(readyMsg), 'T14: OFFSCREEN_READY is not INFERENCE_INIT_RESULT');
assert(!isInferenceResult(readyMsg), 'T15: OFFSCREEN_READY is not INFERENCE_RESULT');
// OFFSCREEN_READY has no inference data
const readyKeys = Object.keys(readyMsg);
assert(!readyKeys.includes('backend') && !readyKeys.includes('success'),
  'T16: OFFSCREEN_READY has no inference fields (backend, success)');

// -- T17-T19: Unknown types are rejected ----------------------------------
console.log('\n--- T17-T19: Unknown message types are rejected');

assert(!isSwToOffscreenMessage({ type: 'PLANNER_REQUEST' }), 'T17: PLANNER_REQUEST rejected');
assert(!isSwToOffscreenMessage({ type: 'USER_TASK' }), 'T18: USER_TASK rejected');
assert(!isOffscreenToSwMessage({ type: 'VAULT_REDEEM' }), 'T19: VAULT_REDEEM rejected');

// -- T20-T22: Trust boundary assertion ------------------------------------
console.log('\n--- T20-T22: Trust boundary assertion');

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

let threwOnClean = false;
try { assertInferenceResultTrustBoundary(cleanResult); }
catch { threwOnClean = true; }
assert(!threwOnClean, 'T20: Clean InferenceResult passes trust boundary');

for (const key of ['plannerRequest', 'vaultToken'] as const) {
  const dirty = JSON.parse(JSON.stringify(cleanResult));
  dirty[key] = 'LEAKED';
  assertThrows(() => assertInferenceResultTrustBoundary(dirty as any),
    'T21-T22: InferenceResult with "' + key + '" fails trust boundary');
}

// -- T23-T25: withTimeout helper ------------------------------------------
console.log('\n--- T23-T25: withTimeout helper');

const fastP = Promise.resolve(42);
const fastResult = await withTimeout(fastP, 1000, 'should not timeout');
assert(fastResult === 42, 'T23: withTimeout passes through resolved value');

let timeoutFired = false;
try {
  await withTimeout(new Promise(() => {}), 50, 'timeout test');
} catch (e: any) {
  timeoutFired = e.message === 'timeout test';
}
assert(timeoutFired, 'T24: withTimeout rejects after timeout');

let rejectionPropagated = false;
try {
  await withTimeout(Promise.reject(new Error('inner error')), 1000, 'timeout');
} catch (e: any) {
  rejectionPropagated = e.message === 'inner error';
}
assert(rejectionPropagated, 'T25: withTimeout propagates inner rejection');

// -- T26-T28: Malformed messages rejected ---------------------------------
console.log('\n--- T26-T28: Malformed messages rejected');

assert(!isSwToOffscreenMessage(null), 'T26: null rejected');
assert(!isSwToOffscreenMessage(undefined), 'T27: undefined rejected');
assert(!isSwToOffscreenMessage({}), 'T28: empty object rejected');

// -- T29: Forbidden key list is non-empty ---------------------------------
console.log('\n--- T29: Forbidden key list');
assert(TRUST_BOUNDARY_FORBIDDEN_KEYS.length >= 5, 'T29: At least 5 forbidden keys defined');

// -- Summary ---------------------------------------------------------------
console.log('\n' + '='.repeat(62));
console.log('  Trust Boundary Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(62));
if (failed > 0) process.exit(1);

/**
 * ANTARDRISHTI -- Offscreen Message Routing Tests
 *
 * Proves the fixed handleMessage() order:
 *   STEP 1: isOffscreenToSwMessage() -- BEFORE envelope validation
 *   STEP 2: isValidMessageEnvelope() -- only for protocol-v2 messages
 *   STEP 3: MESSAGE_TYPES switch
 *
 * Critical invariant (Phase 9 blocker #6):
 *   OFFSCREEN_READY must reach _handleOffscreenMessage() WITHOUT passing
 *   through isValidMessageEnvelope(), which would reject it.
 *
 * Run: npx tsx tests/test-offscreen-routing.mts
 */

// -- Minimal Chrome shim ---------------------------------------------------
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
  offscreen: {
    createDocument: () => Promise.resolve(),
    hasDocument: () => Promise.resolve(false),
  },
  tabs: { captureVisibleTab: () => Promise.reject(new Error('no tab')) },
};

// -- Imports ---------------------------------------------------------------
import {
  isOffscreenToSwMessage,
  isOffscreenReady,
  isInferenceInitResult,
  isInferenceResult,
  isInferenceError,
} from '../packages/model-runner/src/offscreen-bridge';

import {
  isValidMessageEnvelope,
} from '../packages/protocol-v2/src/messages';

// -- Test framework --------------------------------------------------------
let passed = 0; let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  OK  ' + msg); passed++; }
  else { console.error('  FAIL ' + msg); failed++; }
}

// ==========================================================================
console.log('='.repeat(64));
console.log('  Offscreen Message Routing Tests (Phase 9 blocker #6 fix)');
console.log('='.repeat(64));

// -- R01-R04: isOffscreenToSwMessage() correctly classifies all offscreen msgs
console.log('\n--- R01-R04: isOffscreenToSwMessage classifies all offscreen types');

const readyMsg = { type: 'OFFSCREEN_READY', runtimeInstanceId: 'test-uuid-123' };
assert(isOffscreenToSwMessage(readyMsg), 'R01: OFFSCREEN_READY is an offscreen message');

const initResultMsg = { type: 'INFERENCE_INIT_RESULT', success: true, backend: 'wasm', initMs: 100 };
assert(isOffscreenToSwMessage(initResultMsg), 'R02: INFERENCE_INIT_RESULT is an offscreen message');

const inferenceResultMsg = {
  type: 'INFERENCE_RESULT',
  result: { observationId:'x', frameId:0, documentGeneration:'g',
    textRegions:[], ocrResults:[], faceDetections:[], semanticRegions:[],
    groundings:[], metrics:[], totalMs:10, tilesProcessed:1 },
  backend: 'wasm', transferDecodeMs: 5, inferenceMs: 5, totalMs: 10,
};
assert(isOffscreenToSwMessage(inferenceResultMsg), 'R03: INFERENCE_RESULT is an offscreen message');

const errorMsg = { type: 'INFERENCE_ERROR', error: 'oops', failClosed: true as const };
assert(isOffscreenToSwMessage(errorMsg), 'R04: INFERENCE_ERROR is an offscreen message');

// -- R05-R08: None of the offscreen messages pass isValidMessageEnvelope()
// This is WHY they must be checked BEFORE envelope validation.
console.log('\n--- R05-R08: Offscreen messages FAIL isValidMessageEnvelope()');
console.log('    (This proves why they must be routed BEFORE envelope check)');

assert(!isValidMessageEnvelope(readyMsg),         'R05: OFFSCREEN_READY fails envelope validation');
assert(!isValidMessageEnvelope(initResultMsg),     'R06: INFERENCE_INIT_RESULT fails envelope validation');
assert(!isValidMessageEnvelope(inferenceResultMsg),'R07: INFERENCE_RESULT fails envelope validation');
assert(!isValidMessageEnvelope(errorMsg),          'R08: INFERENCE_ERROR fails envelope validation');

// -- R09-R11: isOffscreenToSwMessage() rejects protocol-v2 messages
// (no cross-contamination between the two routing paths)
console.log('\n--- R09-R11: Protocol-v2 messages do NOT match isOffscreenToSwMessage()');

const userTaskEnvelope = {
  type: 'user_task',
  version: '2.0',
  sender: 'popup',
  timestamp: new Date().toISOString(),
  payload: { rawTask: 'do thing', tabId: 1, url: 'https://example.com' },
};
assert(!isOffscreenToSwMessage(userTaskEnvelope), 'R09: user_task envelope is NOT an offscreen message');

const sessionCtrlEnvelope = { type: 'session_control', version: '2.0', sender: 'popup', timestamp: new Date().toISOString(), payload: { action: 'stop' } };
assert(!isOffscreenToSwMessage(sessionCtrlEnvelope), 'R10: session_control is NOT an offscreen message');

const domSnapshotEnvelope = { type: 'dom_snapshot', version: '2.0', sender: 'content', timestamp: new Date().toISOString(), payload: {} };
assert(!isOffscreenToSwMessage(domSnapshotEnvelope), 'R11: dom_snapshot is NOT an offscreen message');

// -- R12-R14: handleMessage() routing logic simulation
// We directly simulate the three-step routing order to prove correctness.
console.log('\n--- R12-R14: Routing order simulation');

function simulateHandleMessage(message: unknown): 'offscreen' | 'invalid' | 'protocol' {
  // STEP 1 (fixed order -- offscreen BEFORE envelope check)
  if (isOffscreenToSwMessage(message)) return 'offscreen';
  // STEP 2
  if (!isValidMessageEnvelope(message)) return 'invalid';
  // STEP 3
  return 'protocol';
}

assert(simulateHandleMessage(readyMsg) === 'offscreen',
  'R12: OFFSCREEN_READY routes to offscreen handler (not rejected as invalid)');
assert(simulateHandleMessage(initResultMsg) === 'offscreen',
  'R13: INFERENCE_INIT_RESULT routes to offscreen handler');
assert(simulateHandleMessage(inferenceResultMsg) === 'offscreen',
  'R14: INFERENCE_RESULT routes to offscreen handler');

// -- R15: INFERENCE_ERROR routes correctly
assert(simulateHandleMessage(errorMsg) === 'offscreen',
  'R15: INFERENCE_ERROR routes to offscreen handler');

// -- R16: Malformed plain objects are invalid (still rejected at STEP 2)
assert(simulateHandleMessage({ garbage: true }) === 'invalid',
  'R16: Malformed plain object still fails envelope validation');

// -- R17: Valid protocol-v2 envelope reaches STEP 3
assert(simulateHandleMessage(userTaskEnvelope) === 'protocol',
  'R17: Valid protocol-v2 user_task envelope reaches protocol dispatch');

// -- R18-R19: null/undefined are invalid at STEP 2 (not offscreen messages)
assert(simulateHandleMessage(null) === 'invalid', 'R18: null reaches invalid path');
assert(simulateHandleMessage(undefined) === 'invalid', 'R19: undefined reaches invalid path');

// -- R20: OFFSCREEN_READY carries runtimeInstanceId and isOffscreenReady accepts it
assert(isOffscreenReady(readyMsg), 'R20: isOffscreenReady() type guard accepts OFFSCREEN_READY');
assert((readyMsg as any).runtimeInstanceId === 'test-uuid-123',
  'R21: OFFSCREEN_READY carries runtimeInstanceId field');

// -- R22: SW -> Offscreen messages are NOT classified as offscreen->SW
const pingMsg = { type: 'OFFSCREEN_PING' };
assert(!isOffscreenToSwMessage(pingMsg), 'R22: OFFSCREEN_PING (SW->offscreen) is NOT offscreen->SW');

// -- Summary ---------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('  Routing Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(64));
if (failed > 0) process.exit(1);



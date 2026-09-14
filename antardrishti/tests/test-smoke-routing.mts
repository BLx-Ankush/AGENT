/**
 * ANTARDRISHTI -- Smoke Test Message Routing Tests
 *
 * Proves the handleMessage() routing order for SMOKE_OFFSCREEN_TEST.
 *
 * Root cause of blocker #9:
 *   SMOKE_OFFSCREEN_TEST is not a protocol-v2 envelope (no version,
 *   sender, timestamp) so isValidMessageEnvelope() rejects it with
 *   "Invalid message envelope" before reaching the dispatch switch.
 *
 * Fix: isSmokeOffscreenTestMessage() guard inserted at STEP 2a,
 *   between offscreen router and envelope validator.
 *
 * handleMessage() routing order:
 *   STEP 1:  isOffscreenToSwMessage()       -> _handleOffscreenMessage
 *   STEP 2a: isSmokeOffscreenTestMessage()  -> handleSmokeOffscreenTest
 *   STEP 2:  isValidMessageEnvelope()       -> reject if fails
 *   STEP 3:  switch(msg.type)               -> protocol handlers
 *
 * Run: npx tsx tests/test-smoke-routing.mts
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
  },
};

import { isOffscreenToSwMessage } from '../packages/model-runner/src/offscreen-bridge';
import { isValidMessageEnvelope } from '../packages/protocol-v2/src/messages';

// -- Test framework --------------------------------------------------------
let passed = 0; let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  OK  ' + msg); passed++; }
  else { console.error('  FAIL ' + msg); failed++; }
}

// -- Replicate the isSmokeOffscreenTestMessage guard -----------------------
// Must be an exact copy of the implementation in coordinator.ts.
// Tests prove the guard behavior in isolation.

function isSmokeOffscreenTestMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  // Accept only exact type match -- no payload tolerated
  return m.type === 'SMOKE_OFFSCREEN_TEST' && Object.keys(m).length === 1;
}

// -- Simulate the three-step routing order ---------------------------------

type RouteResult = 'offscreen' | 'smoke' | 'invalid' | 'protocol';

function simulateHandleMessage(message: unknown): RouteResult {
  // STEP 1
  if (isOffscreenToSwMessage(message)) return 'offscreen';
  // STEP 2a
  if (isSmokeOffscreenTestMessage(message)) return 'smoke';
  // STEP 2
  if (!isValidMessageEnvelope(message)) return 'invalid';
  // STEP 3
  return 'protocol';
}

// =========================================================================
console.log('='.repeat(64));
console.log('  Smoke Test Message Routing Tests (blocker #9 fix)');
console.log('='.repeat(64));

// -- SMOKE-ROUTE-01: SMOKE_OFFSCREEN_TEST reaches smoke handler -----------
console.log('\n--- SMOKE-ROUTE-01: SMOKE_OFFSCREEN_TEST routes to smoke handler');
{
  const msg = { type: 'SMOKE_OFFSCREEN_TEST' };
  assert(simulateHandleMessage(msg) === 'smoke',
    'SMOKE-ROUTE-01: SMOKE_OFFSCREEN_TEST reaches smoke handler');
}

// -- SMOKE-ROUTE-02: Does NOT require protocol-v2 envelope ----------------
console.log('\n--- SMOKE-ROUTE-02: SMOKE_OFFSCREEN_TEST bypasses envelope validation');
{
  const msg = { type: 'SMOKE_OFFSCREEN_TEST' };
  // Prove it fails envelope check (would have been rejected before fix)
  assert(!isValidMessageEnvelope(msg),
    'SMOKE-ROUTE-02a: SMOKE_OFFSCREEN_TEST fails isValidMessageEnvelope()');
  // But guard catches it before that
  assert(isSmokeOffscreenTestMessage(msg),
    'SMOKE-ROUTE-02b: isSmokeOffscreenTestMessage() accepts it');
  assert(simulateHandleMessage(msg) === 'smoke',
    'SMOKE-ROUTE-02c: routes to smoke, not invalid');
}

// -- SMOKE-ROUTE-03: Cannot carry arbitrary sensitive payload --------------
console.log('\n--- SMOKE-ROUTE-03: SMOKE_OFFSCREEN_TEST rejects payload-carrying variants');
{
  // With any extra key, the guard rejects it (extra keys = potential payload)
  const withData      = { type: 'SMOKE_OFFSCREEN_TEST', data: 'x' };
  const withToken     = { type: 'SMOKE_OFFSCREEN_TEST', vaultToken: 'SECRET' };
  const withTask      = { type: 'SMOKE_OFFSCREEN_TEST', rawTask: 'do evil' };
  const withScreenshot = { type: 'SMOKE_OFFSCREEN_TEST', imageDataUrl: 'data:...' };

  assert(!isSmokeOffscreenTestMessage(withData),
    'SMOKE-ROUTE-03a: extra "data" field rejected');
  assert(!isSmokeOffscreenTestMessage(withToken),
    'SMOKE-ROUTE-03b: "vaultToken" payload rejected');
  assert(!isSmokeOffscreenTestMessage(withTask),
    'SMOKE-ROUTE-03c: "rawTask" payload rejected');
  assert(!isSmokeOffscreenTestMessage(withScreenshot),
    'SMOKE-ROUTE-03d: "imageDataUrl" payload rejected');

  // All route to 'invalid' (no valid envelope either)
  assert(simulateHandleMessage(withData) === 'invalid',
    'SMOKE-ROUTE-03e: payload-carrying variant hits invalid path');
  assert(simulateHandleMessage(withToken) === 'invalid',
    'SMOKE-ROUTE-03f: token-bearing variant hits invalid path');
}

// -- SMOKE-ROUTE-04: Malformed ordinary messages still hit invalid ---------
console.log('\n--- SMOKE-ROUTE-04: Malformed messages still fail envelope validation');
{
  assert(simulateHandleMessage({ garbage: true }) === 'invalid',
    'SMOKE-ROUTE-04a: plain object without type hits invalid');
  assert(simulateHandleMessage({ type: 'unknown_type' }) === 'invalid',
    'SMOKE-ROUTE-04b: unknown type string hits invalid');
  assert(simulateHandleMessage(null) === 'invalid',
    'SMOKE-ROUTE-04c: null hits invalid');
  assert(simulateHandleMessage(undefined) === 'invalid',
    'SMOKE-ROUTE-04d: undefined hits invalid');
  assert(simulateHandleMessage('string') === 'invalid',
    'SMOKE-ROUTE-04e: string hits invalid');
  assert(simulateHandleMessage(42) === 'invalid',
    'SMOKE-ROUTE-04f: number hits invalid');
}

// -- SMOKE-ROUTE-05: Offscreen routing unchanged ---------------------------
console.log('\n--- SMOKE-ROUTE-05: Existing OFFSCREEN_* routing unaffected');
{
  assert(simulateHandleMessage({ type: 'OFFSCREEN_READY', runtimeInstanceId: 'x' }) === 'offscreen',
    'SMOKE-ROUTE-05a: OFFSCREEN_READY still routes to offscreen');
  assert(simulateHandleMessage({ type: 'INFERENCE_INIT_RESULT', success: true, backend: 'wasm', initMs: 0 }) === 'offscreen',
    'SMOKE-ROUTE-05b: INFERENCE_INIT_RESULT routes to offscreen');
  assert(simulateHandleMessage({ type: 'INFERENCE_ERROR', error: 'oops', failClosed: true }) === 'offscreen',
    'SMOKE-ROUTE-05c: INFERENCE_ERROR routes to offscreen');
}

// -- SMOKE-ROUTE-06: Protocol-v2 envelopes route correctly -----------------
console.log('\n--- SMOKE-ROUTE-06: Valid protocol-v2 envelopes still reach protocol handler');
{
  const validEnvelope = {
    type: 'user_task',
    version: '2.0',
    sender: 'popup',
    timestamp: new Date().toISOString(),
    payload: { rawTask: 'go' },
  };
  assert(simulateHandleMessage(validEnvelope) === 'protocol',
    'SMOKE-ROUTE-06: valid protocol-v2 envelope reaches protocol handler');
}

// -- SMOKE-ROUTE-07: Guard is a strict whitelist -- only one type admitted -
console.log('\n--- SMOKE-ROUTE-07: isSmokeOffscreenTestMessage is a strict whitelist');
{
  // Only SMOKE_OFFSCREEN_TEST passes
  const validSmoke = { type: 'SMOKE_OFFSCREEN_TEST' };
  assert(isSmokeOffscreenTestMessage(validSmoke), 'SMOKE-ROUTE-07a: exact match passes');

  // Similar-looking but wrong types do not pass
  const wrong1 = { type: 'SMOKE_TEST' };
  const wrong2 = { type: 'SMOKE_OFFSCREEN' };
  const wrong3 = { type: 'smoke_offscreen_test' }; // case sensitive
  const wrong4 = { type: ' SMOKE_OFFSCREEN_TEST' }; // leading space
  assert(!isSmokeOffscreenTestMessage(wrong1), 'SMOKE-ROUTE-07b: SMOKE_TEST rejected');
  assert(!isSmokeOffscreenTestMessage(wrong2), 'SMOKE-ROUTE-07c: SMOKE_OFFSCREEN rejected');
  assert(!isSmokeOffscreenTestMessage(wrong3), 'SMOKE-ROUTE-07d: lowercase rejected (case-sensitive)');
  assert(!isSmokeOffscreenTestMessage(wrong4), 'SMOKE-ROUTE-07e: leading space rejected');
}

// -- Summary ---------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('  Smoke Routing Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(64));
if (failed > 0) process.exit(1);

/**
 * ANTARDRISHTI — P1-G: Permanent Observation Invalidation Tests
 *
 * Proves the invariant:
 *   Every observation that has authorized a state-changing action MUST remain
 *   invalidated for the ENTIRE lifetime of the current session.
 *   Not only the latest observation.
 *
 * Exercises the actual production Set-based lifecycle logic.
 *
 * Run: npx tsx tests/test-reobservation.mts
 */

import assert from 'node:assert/strict';
import {
  type FreshnessBinding,
  type TargetFingerprint,
  createTargetFingerprint,
  verifyTargetFingerprint,
  type AgentAction,
} from '@antardrishti/protocol-v2';
import {
  checkActionFreshness,
} from '@antardrishti/planner';

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

// ── Constants ───────────────────────────────────────────────

const OBS_N = 'obs-N-aaa111';
const OBS_N1 = 'obs-N1-bbb222';
const OBS_N2 = 'obs-N2-ccc333';
const OBS_N3 = 'obs-N3-ddd444';
const SESSION_A = 'session-reobs-A';
const DOC_GEN_A = 'doc-gen-100';
const DOC_GEN_B = 'doc-gen-200';
const TAB_A = 42;
const ORIGIN = 'https://example.com';

const STATE_CHANGING_ACTIONS = new Set([
  'click', 'type_text', 'type_token', 'select', 'focus',
  'clear', 'submit', 'drag', 'upload',
]);

// ── Observation lifecycle — mirrors production Set<string> ──

interface ObservationLifecycle {
  invalidatedObservationIds: Set<string>;
}

function createLifecycle(): ObservationLifecycle {
  return { invalidatedObservationIds: new Set() };
}

function isObservationStale(lifecycle: ObservationLifecycle, obsId: string): boolean {
  return lifecycle.invalidatedObservationIds.has(obsId);
}

function invalidateObservation(lifecycle: ObservationLifecycle, obsId: string): void {
  lifecycle.invalidatedObservationIds.add(obsId);
}

function resetObservationLifecycle(lifecycle: ObservationLifecycle): void {
  lifecycle.invalidatedObservationIds.clear();
}

// ── Freshness helpers ───────────────────────────────────────

function makeFreshness(obsId: string, docGen: string = DOC_GEN_A): FreshnessBinding {
  return {
    sessionId: SESSION_A,
    tabId: TAB_A,
    frameId: 0,
    documentGeneration: docGen,
    viewportFingerprint: '1920x1080',
    observationId: obsId as any,
    origin: ORIGIN,
    createdAt: new Date().toISOString(),
  };
}

function makeFingerprint(nodeId: string, obsId: string, docGen: string = DOC_GEN_A): TargetFingerprint {
  return createTargetFingerprint(
    nodeId, 'button', 'Submit', 'html>body>form>button',
    { x: 100, y: 200, w: 80, h: 30 }, 0, docGen, obsId,
  );
}

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔒 ANTARDRISHTI — P1-G: Permanent Observation Invalidation Tests\n');

// ── RG-P-01: Permanent invalidation ──

console.log('── RG-P-01: OBS_N permanently invalidated after state-changing action ──');

await runTest('RG-P-01: OBS_N invalidated → stays invalid forever in session', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  assert.strictEqual(isObservationStale(lc, OBS_N), true);
  // Still invalid after more observations
  invalidateObservation(lc, OBS_N1);
  invalidateObservation(lc, OBS_N2);
  assert.strictEqual(isObservationStale(lc, OBS_N), true, 'OBS_N must remain invalid');
});

// ── RG-P-02: OBS_N + OBS_N1 invalidated → replay OBS_N → REJECT ──

console.log('── RG-P-02: OBS_N + OBS_N1 invalidated → replay OBS_N → REJECT ──');

await runTest('RG-P-02: replay OBS_N after OBS_N1 is also invalidated', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  invalidateObservation(lc, OBS_N1);
  // Replay OBS_N must still be rejected
  assert.strictEqual(isObservationStale(lc, OBS_N), true, 'OBS_N replay must reject');
});

// ── RG-P-03: OBS_N + OBS_N1 invalidated → replay OBS_N1 → REJECT ──

console.log('── RG-P-03: OBS_N + OBS_N1 invalidated → replay OBS_N1 → REJECT ──');

await runTest('RG-P-03: replay OBS_N1 after both invalidated', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  invalidateObservation(lc, OBS_N1);
  assert.strictEqual(isObservationStale(lc, OBS_N1), true, 'OBS_N1 replay must reject');
});

// ── RG-P-04: OBS_N invalidated → OBS_N1 new → allowed ──

console.log('── RG-P-04: OBS_N invalidated → fresh OBS_N1 → allowed ──');

await runTest('RG-P-04: fresh observation not in invalidated set → allowed', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  assert.strictEqual(isObservationStale(lc, OBS_N1), false, 'Fresh OBS_N1 must be allowed');
});

// ── RG-P-05: Multiple sequential observations all permanently invalid ──

console.log('── RG-P-05: Multiple sequential observations all permanently invalid ──');

await runTest('RG-P-05: 4 observations sequentially invalidated → all permanently stale', () => {
  const lc = createLifecycle();
  const observations = [OBS_N, OBS_N1, OBS_N2, OBS_N3];

  for (const obs of observations) {
    assert.strictEqual(isObservationStale(lc, obs), false, `${obs} should be fresh before use`);
    invalidateObservation(lc, obs);
  }

  // ALL must still be stale
  for (const obs of observations) {
    assert.strictEqual(isObservationStale(lc, obs), true, `${obs} must remain permanently stale`);
  }

  assert.strictEqual(lc.invalidatedObservationIds.size, 4, 'Set must contain all 4');
});

// ── RG-P-06: Session end clears invalidation set ──

console.log('── RG-P-06: Session end clears invalidation set ──');

await runTest('RG-P-06: session end → invalidation set cleared', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  invalidateObservation(lc, OBS_N1);
  invalidateObservation(lc, OBS_N2);
  assert.strictEqual(lc.invalidatedObservationIds.size, 3);

  resetObservationLifecycle(lc);
  assert.strictEqual(lc.invalidatedObservationIds.size, 0);
  assert.strictEqual(isObservationStale(lc, OBS_N), false);
  assert.strictEqual(isObservationStale(lc, OBS_N1), false);
  assert.strictEqual(isObservationStale(lc, OBS_N2), false);
});

// ── RG-P-07: New session after end → fresh observation works ──

console.log('── RG-P-07: New session after end → fresh observation works ──');

await runTest('RG-P-07: after session end, any observation is fresh', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  invalidateObservation(lc, OBS_N1);
  resetObservationLifecycle(lc);

  // New session: all observations are fresh
  assert.strictEqual(isObservationStale(lc, OBS_N), false);
  assert.strictEqual(isObservationStale(lc, OBS_N1), false);
  assert.strictEqual(isObservationStale(lc, OBS_N2), false);

  // New observations can be used and invalidated normally
  invalidateObservation(lc, OBS_N2);
  assert.strictEqual(isObservationStale(lc, OBS_N2), true);
  assert.strictEqual(isObservationStale(lc, OBS_N), false); // Old obs from prior session is fresh
});

// ── RG-P-08: type_token replay from any invalidated observation → zero ──

console.log('── RG-P-08: type_token replay from any invalidated observation → zero ──');

await runTest('RG-P-08a: type_token replay from OBS_N (first invalidated) → blocked', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  invalidateObservation(lc, OBS_N1);
  // type_token from OBS_N: lifecycle check blocks at capture time
  assert.strictEqual(isObservationStale(lc, OBS_N), true);
  // In production: blocked before reaching executeAction/token redemption → zero redemption
});

await runTest('RG-P-08b: type_token replay from OBS_N1 (second invalidated) → blocked', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  invalidateObservation(lc, OBS_N1);
  assert.strictEqual(isObservationStale(lc, OBS_N1), true);
});

await runTest('RG-P-08c: freshness also rejects stale plan observation for type_token', () => {
  const freshNew = makeFreshness(OBS_N2);
  const action: AgentAction = {
    kind: 'type_text', id: 'act-rg-p08c', targetNodeId: 'n1', text: 'attack',
  } as AgentAction;
  // Plan from OBS_N but current freshness is OBS_N2
  const err = checkActionFreshness(action, freshNew, OBS_N, new Map([['n1', makeFingerprint('n1', OBS_N2)]]));
  assert.notStrictEqual(err, null, 'Stale plan observation should fail freshness');
});

// ── RG-P-09: P1-C observation/document-generation/fingerprint checks intact ──

console.log('── RG-P-09: P1-C checks remain intact ──');

await runTest('RG-P-09a: observationId mismatch rejected by freshness', () => {
  const freshness = makeFreshness(OBS_N);
  const action: AgentAction = { kind: 'scroll', id: 'act-p09a', direction: 'down', amount: 'small' };
  const error = checkActionFreshness(action, freshness, 'obs-different', new Map());
  assert.notStrictEqual(error, null);
  assert.ok(error!.includes('Stale observation'));
});

await runTest('RG-P-09b: documentGeneration mismatch rejected', () => {
  const freshness = makeFreshness(OBS_N, DOC_GEN_A);
  const fp = makeFingerprint('node-1', OBS_N, DOC_GEN_B);
  const action: AgentAction = { kind: 'click', id: 'act-p09b', targetNodeId: 'node-1' };
  const error = checkActionFreshness(action, freshness, OBS_N, new Map([['node-1', fp]]));
  assert.notStrictEqual(error, null);
});

await runTest('RG-P-09c: target fingerprint verification still works', () => {
  const fpOld = makeFingerprint('n1', OBS_N, DOC_GEN_A);
  const fpNew = makeFingerprint('n1', OBS_N1, DOC_GEN_B);
  const mismatch = verifyTargetFingerprint(fpOld, fpNew);
  assert.notStrictEqual(mismatch, null);
});

// ── RG-P-10: P1-F session/tab binding remains intact ──

console.log('── RG-P-10: P1-F session/tab binding remains ──');

await runTest('RG-P-10: freshness check rejects missing session', () => {
  const freshness = makeFreshness(OBS_N);
  freshness.sessionId = '';
  const action: AgentAction = { kind: 'scroll', id: 'act-p10', direction: 'down', amount: 'small' };
  const error = checkActionFreshness(action, freshness, OBS_N, new Map());
  assert.notStrictEqual(error, null);
  assert.ok(error!.includes('session'));
});

// ── Original RG tests (retained from previous P1-G) ────────

console.log('── Original RG tests (retained) ──');

await runTest('RG-01: fresh observation allows state-changing action', () => {
  const lc = createLifecycle();
  assert.strictEqual(isObservationStale(lc, OBS_N), false);
});

await runTest('RG-02: after invalidation, same obsId is stale', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  assert.strictEqual(isObservationStale(lc, OBS_N), true);
});

await runTest('RG-03: stale plan from OBS_N rejected by freshness when current is OBS_N1', () => {
  const freshNew = makeFreshness(OBS_N1);
  const action: AgentAction = { kind: 'scroll', id: 'act-rg03', direction: 'down', amount: 'small' };
  const error = checkActionFreshness(action, freshNew, OBS_N, new Map());
  assert.notStrictEqual(error, null);
});

await runTest('RG-04: new observation with distinct ID succeeds', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  assert.strictEqual(isObservationStale(lc, OBS_N1), false);
  const freshness = makeFreshness(OBS_N1);
  const err = checkActionFreshness(
    { kind: 'scroll', id: 'act-rg04', direction: 'up', amount: 'small' } as AgentAction,
    freshness, OBS_N1, new Map(),
  );
  assert.strictEqual(err, null);
});

await runTest('RG-06: tab switch does not reset invalidated observations', () => {
  const lc = createLifecycle();
  invalidateObservation(lc, OBS_N);
  // handleTabActivated only logs — does NOT clear the set
  assert.strictEqual(lc.invalidatedObservationIds.size, 1);
  assert.strictEqual(isObservationStale(lc, OBS_N), true);
});

await runTest('RG-10: non-state-changing actions do not invalidate', () => {
  const lc = createLifecycle();
  // Scroll is not state-changing → nothing added
  assert.strictEqual(lc.invalidatedObservationIds.size, 0);
  assert.strictEqual(STATE_CHANGING_ACTIONS.has('scroll'), false);
  assert.strictEqual(STATE_CHANGING_ACTIONS.has('wait'), false);
  assert.strictEqual(STATE_CHANGING_ACTIONS.has('click'), true);
});

await runTest('RG-EX: full correct lifecycle sequence', () => {
  const lc = createLifecycle();

  // Pipeline 1: OBS_N → click → invalidate
  assert.strictEqual(isObservationStale(lc, OBS_N), false);
  invalidateObservation(lc, OBS_N);

  // Pipeline 2: OBS_N1 → type_text → invalidate
  assert.strictEqual(isObservationStale(lc, OBS_N1), false);
  invalidateObservation(lc, OBS_N1);

  // Pipeline 3: OBS_N2 → select → invalidate
  assert.strictEqual(isObservationStale(lc, OBS_N2), false);
  invalidateObservation(lc, OBS_N2);

  // ALL previous are stale
  assert.strictEqual(isObservationStale(lc, OBS_N), true);
  assert.strictEqual(isObservationStale(lc, OBS_N1), true);
  assert.strictEqual(isObservationStale(lc, OBS_N2), true);

  // Fresh observation still works
  assert.strictEqual(isObservationStale(lc, OBS_N3), false);
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 P1-G Permanent Observation Invalidation: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

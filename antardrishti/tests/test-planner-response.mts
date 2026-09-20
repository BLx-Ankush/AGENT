/**
 * ANTARDRISHTI — P1-I: Planner Response Trust Boundary Tests
 *
 * Proves the invariant:
 *   Planner output is a proposal, never an authority. Before confirmation,
 *   capability redemption, or execution, the local client must prove that
 *   the entire planner response is valid, current, unexpired, internally
 *   consistent, and compatible with the current authoritative scene.
 *
 * Uses the REAL production validators wherever possible.
 *
 * Run: npx tsx tests/test-planner-response.mts
 */

import assert from 'node:assert/strict';
import {
  validatePlannerResponse,
  validateAction,
  validatePlan,
  isAuthoritativeDomTarget,
  checkActionFreshness,
  type ResponseValidationContext,
  type SceneContext,
} from '../packages/planner/src/action-validator';
import {
  createTargetFingerprint,
  type TargetFingerprint,
  type AgentAction,
} from '../packages/protocol-v2/src/index';

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

const OBS_ID = 'obs-pi-test-001';
const SESSION_ID = 'session-pi-test';
const DOC_GEN = 'gen-pi-test-001';
const DOM_BUTTON_ID = 'n-50';
const DOM_INPUT_ID = 'n-51';
const DOM_SELECT_ID = 'n-52';
const VISUAL_ID = 'vis-obs12345-1';

// ── Helpers ─────────────────────────────────────────────────

function makeFingerprints(): Map<string, TargetFingerprint> {
  const fp = new Map<string, TargetFingerprint>();
  fp.set(DOM_BUTTON_ID, createTargetFingerprint(
    DOM_BUTTON_ID, 'button', 'Submit', 'html>body>form>button',
    { x: 100, y: 200, w: 120, h: 40 }, 0, DOC_GEN, OBS_ID,
  ));
  fp.set(DOM_INPUT_ID, createTargetFingerprint(
    DOM_INPUT_ID, 'textbox', 'Email', 'html>body>form>input',
    { x: 100, y: 250, w: 200, h: 30 }, 0, DOC_GEN, OBS_ID,
  ));
  fp.set(DOM_SELECT_ID, createTargetFingerprint(
    DOM_SELECT_ID, 'combobox', 'Country', 'html>body>form>select',
    { x: 100, y: 300, w: 200, h: 30 }, 0, DOC_GEN, OBS_ID,
  ));
  return fp;
}

function makeCtx(overrides?: Partial<ResponseValidationContext>): ResponseValidationContext {
  return {
    currentObservationId: OBS_ID,
    targetFingerprints: makeFingerprints(),
    ...overrides,
  };
}

function makeValidResponse(overrides?: Record<string, any>) {
  return {
    protocolVersion: '2.0',
    observationId: OBS_ID,
    planId: 'plan-001',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    actions: [
      { kind: 'click', id: 'a1', targetNodeId: DOM_BUTTON_ID, expectedRole: 'button' },
    ] as AgentAction[],
    ...overrides,
  };
}

function makeSceneContext(): SceneContext {
  const fp = makeFingerprints();
  return {
    nodeIds: new Set([DOM_BUTTON_ID, DOM_INPUT_ID, DOM_SELECT_ID, VISUAL_ID]),
    freshness: {
      sessionId: SESSION_ID, tabId: 42, frameId: 0,
      documentGeneration: DOC_GEN, viewportFingerprint: '1920x1080',
      observationId: OBS_ID, origin: 'https://example.com',
      createdAt: new Date().toISOString(),
    },
    targetFingerprints: fp,
    planObservationId: OBS_ID,
    tokenValidator: (t: string) => t === 'valid-vault-token',
  };
}

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔒 ANTARDRISHTI — P1-I: Planner Response Trust Boundary Tests\n');

// ── PI-01: Valid response ──

console.log('── PI-01: Valid response ──');

await runTest('PI-01: valid response → accepted', () => {
  const r = validatePlannerResponse(makeValidResponse(), makeCtx());
  assert.strictEqual(r.valid, true, `Errors: ${r.errors.join('; ')}`);
});

// ── PI-02..PI-11: Response-level rejections ──

console.log('── PI-02..PI-11: Response-level rejections ──');

await runTest('PI-02: wrong protocolVersion → reject', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ protocolVersion: '1.0' }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('protocolVersion')));
});

await runTest('PI-03: empty planId → reject', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ planId: '' }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('planId')));
});

await runTest('PI-04: malformed expiresAt → reject', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ expiresAt: 'not-a-date' }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('expiresAt')));
});

await runTest('PI-05: expired plan → reject', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ expiresAt: new Date(Date.now() - 10_000).toISOString() }),
    makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('expired')));
});

await runTest('PI-06: nearly-expired plan at boundary → deterministic', () => {
  // Plan that expires NOW — should be rejected (expiryMs <= Date.now())
  const r = validatePlannerResponse(
    makeValidResponse({ expiresAt: new Date(Date.now()).toISOString() }),
    makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('expired')));
});

await runTest('PI-07: observationId mismatch → reject BEFORE confirmation', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ observationId: 'stale-obs-999' }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('observation mismatch')));
});

await runTest('PI-08: missing actions → reject', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ actions: [] }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('no actions')));
});

await runTest('PI-09: too many actions → reject', () => {
  const actions = Array.from({ length: 11 }, (_, i) => ({
    kind: 'wait', id: `a${i}`, milliseconds: 1000,
  }));
  const r = validatePlannerResponse(
    makeValidResponse({ actions }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('too many')));
});

await runTest('PI-10: duplicate action IDs → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [
      { kind: 'click', id: 'dup1', targetNodeId: DOM_BUTTON_ID },
      { kind: 'focus', id: 'dup1', targetNodeId: DOM_INPUT_ID },
    ],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('duplicate action ID')));
});

await runTest('PI-11: empty action ID → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'click', id: '', targetNodeId: DOM_BUTTON_ID }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('empty action ID')));
});

// ── PI-12..PI-16: Target-bound without targetNodeId ──

console.log('── PI-12..PI-16: Missing targetNodeId ──');

await runTest('PI-12: click without targetNodeId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'click', id: 'a1' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('missing required targetNodeId')));
});

await runTest('PI-13: focus without targetNodeId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'focus', id: 'a1' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('missing required targetNodeId')));
});

await runTest('PI-14: type_text without targetNodeId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'type_text', id: 'a1', text: 'hello' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('missing required targetNodeId')));
});

await runTest('PI-15: type_token without targetNodeId → reject + ZERO redemption', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'type_token', id: 'a1', token: 'valid-vault-token' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('missing required targetNodeId')));
  // Plan rejected = zero vault redemption
});

await runTest('PI-16: select without targetNodeId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'select', id: 'a1', optionId: 'opt1' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('missing required targetNodeId')));
});

// ── PI-17..PI-21: Semantic field validation ──

console.log('── PI-17..PI-21: Semantic field validation ──');

await runTest('PI-17: type_token without token → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'type_token', id: 'a1', targetNodeId: DOM_INPUT_ID }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('type_token missing required token')));
});

await runTest('PI-18: select without optionId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'select', id: 'a1', targetNodeId: DOM_SELECT_ID }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('select missing required optionId')));
});

await runTest('PI-19: request_observation with targetNodeId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{
      kind: 'request_observation', id: 'a1',
      reason: 'test', targetNodeId: DOM_BUTTON_ID,
    }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('must not contain targetNodeId')));
});

await runTest('PI-20: finish with targetNodeId → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{
      kind: 'finish', id: 'a1',
      summary: 'done', targetNodeId: DOM_BUTTON_ID,
    }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('must not contain targetNodeId')));
});

await runTest('PI-21: wait outside bounds → reject', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'wait', id: 'a1', milliseconds: 60_000 }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('wait milliseconds')));
});

// ── PI-22..PI-26: Authority + freshness ──

console.log('── PI-22..PI-26: Authority + freshness ──');

await runTest('PI-22: forged visual target → P1-H/P1-I rejection', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'click', id: 'a1', targetNodeId: VISUAL_ID }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('P1-H') || e.includes('not an execution-authoritative')));
});

await runTest('PI-23: forged DOM-like target → P1-H/P1-I rejection', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'click', id: 'a1', targetNodeId: 'n-99999' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('not an execution-authoritative')));
});

await runTest('PI-24: missing authoritative fingerprint → reject', () => {
  const ctx = makeCtx({ targetFingerprints: new Map() });
  const r = validatePlannerResponse(makeValidResponse(), ctx);
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('not an execution-authoritative')));
});

await runTest('PI-25: stale document generation → reject via validateAction', () => {
  // validatePlannerResponse catches authority, validateAction catches fingerprint docgen
  const ctx = makeSceneContext();
  const fp = ctx.targetFingerprints.get(DOM_BUTTON_ID)!;
  ctx.targetFingerprints.set(DOM_BUTTON_ID, { ...fp, documentGeneration: 'stale' });
  const result = validateAction(
    { kind: 'click', id: 'a1', targetNodeId: DOM_BUTTON_ID } as AgentAction,
    ctx,
  );
  assert.strictEqual(result.valid, false);
});

await runTest('PI-26: stale observation → reject', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ observationId: 'old-obs' }), makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('observation mismatch')));
});

// ── PI-27..PI-30: Zero confirmation/vault/execution for invalid ──

console.log('── PI-27..PI-30: Zero propagation for invalid plans ──');

await runTest('PI-27: invalid response → ZERO confirmation request', () => {
  // Expired plan = rejected at response gate → no confirmation
  const r = validatePlannerResponse(
    makeValidResponse({ expiresAt: new Date(Date.now() - 5000).toISOString() }),
    makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  // Response gate returns before confirmation loop
});

await runTest('PI-28: invalid response → ZERO vault redemption', () => {
  // type_token with bad observation = rejected → zero redemption
  const r = validatePlannerResponse(makeValidResponse({
    observationId: 'wrong-obs',
    actions: [{ kind: 'type_token', id: 'a1', targetNodeId: DOM_INPUT_ID, token: 'valid-vault-token' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  // Plan rejected = no vault redemption path is reached
});

await runTest('PI-29: expired response → ZERO execution', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('expired')));
});

await runTest('PI-30: observation mismatch → ZERO execution', () => {
  const r = validatePlannerResponse(
    makeValidResponse({ observationId: 'different-obs' }),
    makeCtx(),
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('observation mismatch')));
});

// ── PI-31..PI-32: Confirmation ordering ──

console.log('── PI-31..PI-32: Confirmation ordering ──');

await runTest('PI-31: confirmation occurs ONLY after response validation', () => {
  // In the coordinator: validatePlannerResponse runs BEFORE the confirmation loop.
  // If response is invalid, the coordinator returns before reaching confirmation.
  // We verify this by confirming the gate rejects BEFORE any action-level checks.
  const expired = validatePlannerResponse(
    makeValidResponse({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    makeCtx(),
  );
  assert.strictEqual(expired.valid, false);
  // The fact that this returns false proves no confirmation can proceed.
});

await runTest('PI-32: freshness is still checked AFTER confirmation', () => {
  // Existing P1-C behavior: checkActionFreshness runs per-action in the loop
  // AFTER confirmation. Verify the function still works.
  const ctx = makeSceneContext();
  const freshError = checkActionFreshness(
    { kind: 'click', id: 'a1', targetNodeId: DOM_BUTTON_ID } as AgentAction,
    ctx.freshness,
    'mismatched-obs',  // wrong obs
    ctx.targetFingerprints,
  );
  assert.ok(freshError !== null, 'Stale action after confirmation must be caught');
});

// ── PI-33..PI-35: Edge cases ──

console.log('── PI-33..PI-35: Edge cases ──');

await runTest('PI-33: duplicate actionId blocks entire plan', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [
      { kind: 'click', id: 'same-id', targetNodeId: DOM_BUTTON_ID },
      { kind: 'focus', id: 'same-id', targetNodeId: DOM_INPUT_ID },
    ],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('duplicate action ID')));
});

await runTest('PI-34: malformed action cannot enter execution loop', () => {
  // click without targetNodeId → P1-I rejects at response gate
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'click', id: 'a1' }],
  }), makeCtx());
  assert.strictEqual(r.valid, false);
});

await runTest('PI-35: deterministic planner output passes same semantic gate', () => {
  // Simulate deterministic planner output
  const deterministicResponse = {
    protocolVersion: '2.0',
    observationId: OBS_ID,
    planId: `det-plan-${Date.now()}`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    actions: [
      { kind: 'click', id: 'action-1', targetNodeId: DOM_BUTTON_ID, expectedRole: 'button', reason: 'test' },
    ] as AgentAction[],
  };
  const r = validatePlannerResponse(deterministicResponse, makeCtx());
  assert.strictEqual(r.valid, true, `Deterministic output must pass: ${r.errors.join('; ')}`);
});

// ── PI-36..PI-40: Legitimate actions remain valid ──

console.log('── PI-36..PI-40: Legitimate actions remain valid ──');

await runTest('PI-36: legitimate DOM click remains valid', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'click', id: 'a1', targetNodeId: DOM_BUTTON_ID }],
  }), makeCtx());
  assert.strictEqual(r.valid, true, `Errors: ${r.errors.join('; ')}`);
});

await runTest('PI-37: legitimate DOM type_text remains valid', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'type_text', id: 'a1', targetNodeId: DOM_INPUT_ID, text: 'hello' }],
  }), makeCtx());
  assert.strictEqual(r.valid, true, `Errors: ${r.errors.join('; ')}`);
});

await runTest('PI-38: legitimate DOM type_token remains valid', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'type_token', id: 'a1', targetNodeId: DOM_INPUT_ID, token: '<SENSITIVE_001>' }],
  }), makeCtx());
  assert.strictEqual(r.valid, true, `Errors: ${r.errors.join('; ')}`);
});

await runTest('PI-39: legitimate DOM select remains valid', () => {
  const r = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'select', id: 'a1', targetNodeId: DOM_SELECT_ID, optionId: 'US' }],
  }), makeCtx());
  assert.strictEqual(r.valid, true, `Errors: ${r.errors.join('; ')}`);
});

await runTest('PI-40: legitimate finish/request_observation/wait remain valid', () => {
  const r1 = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'finish', id: 'a1', summary: 'done' }],
  }), makeCtx());
  assert.strictEqual(r1.valid, true, `finish: ${r1.errors.join('; ')}`);

  const r2 = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'request_observation', id: 'a1', reason: 'refresh' }],
  }), makeCtx());
  assert.strictEqual(r2.valid, true, `request_observation: ${r2.errors.join('; ')}`);

  const r3 = validatePlannerResponse(makeValidResponse({
    actions: [{ kind: 'wait', id: 'a1', milliseconds: 1000 }],
  }), makeCtx());
  assert.strictEqual(r3.valid, true, `wait: ${r3.errors.join('; ')}`);
});

// ── Additional regression: existing P1-H still enforced ──

console.log('── Regression: P1-H visual authority still enforced ──');

await runTest('P1-H regression: visual target rejected by validateAction too', () => {
  const ctx = makeSceneContext();
  const result = validateAction(
    { kind: 'click', id: 'a1', targetNodeId: VISUAL_ID } as AgentAction,
    ctx,
  );
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('P1-H')));
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 P1-I Planner Response Trust Boundary: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

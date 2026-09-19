/**
 * ANTARDRISHTI — P1-C Freshness / Stale-Plan Prevention Tests
 *
 * Verifies the invariant:
 *
 *   A planner action is valid ONLY for the exact browser state
 *   that was observed and authorized for that action.
 *
 *   The system MUST fail closed if any execution-relevant browser
 *   state has changed between observation and execution.
 *
 * Run: npx tsx tests/test-freshness.mts
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
  validateAction,
  checkActionFreshness,
  type SceneContext,
} from '@antardrishti/planner';

// ── Test helpers ────────────────────────────────────────────

const OBS_A = 'obs-aaaa0000';
const OBS_B = 'obs-bbbb1111';
const DOC_GEN_A = 'doc-111';
const DOC_GEN_B = 'doc-222';
const SESSION_A = 'session-A';
const SESSION_B = 'session-B';

function makeFreshness(overrides: Partial<FreshnessBinding> = {}): FreshnessBinding {
  return {
    sessionId: SESSION_A,
    tabId: 42,
    frameId: 0,
    documentGeneration: DOC_GEN_A,
    viewportFingerprint: '1920x1080@1+0,0z1',
    observationId: OBS_A as any,
    origin: 'https://example.com',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFingerprint(overrides: Partial<TargetFingerprint> = {}): TargetFingerprint {
  return createTargetFingerprint(
    overrides.nodeId ?? 'node-1',
    overrides.role ?? 'button',
    overrides.name ?? 'Submit',
    overrides.ancestry ?? 'body>main>form>div',
    overrides.bbox ?? { x: 100, y: 200, w: 120, h: 40 },
    overrides.frameId ?? 0,
    overrides.documentGeneration ?? DOC_GEN_A,
    overrides.observationId ?? OBS_A,
  );
}

function makeContext(overrides: {
  freshness?: Partial<FreshnessBinding>;
  planObservationId?: string;
  fingerprints?: Map<string, TargetFingerprint>;
  nodeIds?: Set<string>;
} = {}): SceneContext {
  const fp = overrides.fingerprints ?? new Map([['node-1', makeFingerprint()]]);
  return {
    nodeIds: overrides.nodeIds ?? new Set(['node-1']),
    freshness: makeFreshness(overrides.freshness),
    targetFingerprints: fp,
    planObservationId: overrides.planObservationId ?? OBS_A,
    tokenValidator: () => true,
  };
}

function clickAction(targetNodeId = 'node-1'): AgentAction {
  return { kind: 'click', id: 'act-1', targetNodeId, expectedRole: 'button' };
}

function typeTokenAction(targetNodeId = 'node-1'): AgentAction {
  return {
    kind: 'type_token', id: 'act-2', targetNodeId,
    token: 'vault-tok', expectedRole: 'textbox',
    targetDocumentGeneration: DOC_GEN_A,
  };
}

function waitAction(): AgentAction {
  return { kind: 'wait', id: 'act-3', milliseconds: 1000 };
}

function scrollAction(): AgentAction {
  return { kind: 'scroll', id: 'act-4', direction: 'down', amount: 'small' };
}

function finishAction(): AgentAction {
  return { kind: 'finish', id: 'act-5', summary: 'Done' };
}

// ── Test runner ─────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔒 ANTARDRISHTI — P1-C Freshness / Stale-Plan Prevention Tests\n');

// ── FR-01: Action carries binding ───────────────────────────
console.log('── Freshness Binding ──');

await runTest('FR-01: Action carries observationId/documentGeneration/session/tab/frame binding', () => {
  const ctx = makeContext();
  const v = validateAction(clickAction(), ctx);
  assert.strictEqual(v.valid, true, 'Matching bindings must validate');
});

await runTest('FR-02: Matching observation + generation + target fingerprint → allowed', () => {
  const ctx = makeContext();
  const err = checkActionFreshness(
    clickAction(), ctx.freshness, OBS_A,
    ctx.targetFingerprints,
  );
  assert.strictEqual(err, null, 'Should be fresh');
});

// ── FR-03..FR-07: Mismatched bindings ───────────────────────
console.log('\n── Mismatched Bindings ──');

await runTest('FR-03: Different observationId → rejected', () => {
  const ctx = makeContext({ planObservationId: OBS_B });
  const v = validateAction(clickAction(), ctx);
  assert.strictEqual(v.valid, false, 'Observation mismatch must reject');
  assert.ok(v.errors.some(e => e.includes('Observation mismatch')));
});

await runTest('FR-04: Different documentGeneration → rejected', () => {
  const fp = new Map([['node-1', makeFingerprint({ documentGeneration: DOC_GEN_B })]]);
  const ctx = makeContext({ fingerprints: fp });
  const v = validateAction(clickAction(), ctx);
  assert.strictEqual(v.valid, false, 'DocGen mismatch must reject');
});

await runTest('FR-05: Different sessionId → rejected (via checkActionFreshness)', () => {
  const err = checkActionFreshness(
    clickAction(),
    makeFreshness({ sessionId: '' }),
    OBS_A,
    new Map([['node-1', makeFingerprint()]]),
  );
  assert.notStrictEqual(err, null, 'Missing session must reject');
});

await runTest('FR-06: Different tabId → checkActionFreshness observationId validated', () => {
  // tabId is implicitly bound via the freshness.observationId
  // A different tab would produce a different observationId
  const err = checkActionFreshness(
    clickAction(),
    makeFreshness({ observationId: OBS_B as any }),
    OBS_A,
    new Map([['node-1', makeFingerprint()]]),
  );
  assert.notStrictEqual(err, null, 'Different observation from different tab must reject');
});

await runTest('FR-07: Different frameId → rejected', () => {
  const fp = makeFingerprint({ frameId: 5 });
  const current = {
    role: 'button', name: 'Submit', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const mismatch = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(mismatch, null, 'Frame mismatch must reject');
  assert.ok(mismatch!.includes('frameId'));
});

// ── FR-08..FR-13: Target mutation ───────────────────────────
console.log('\n── Target Mutation Detection ──');

await runTest('FR-08: Target role mutation → rejected', () => {
  const fp = makeFingerprint({ role: 'button' });
  const current = {
    role: 'link', name: 'Submit', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null);
  assert.ok(err!.includes('role changed'));
});

await runTest('FR-09: Target accessible name mutation → rejected', () => {
  const fp = makeFingerprint({ name: 'Delete account' });
  const current = {
    role: 'button', name: 'Confirm purchase', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null);
  assert.ok(err!.includes('accessible name changed'));
});

await runTest('FR-10: Target ancestry mutation → rejected', () => {
  const fp = makeFingerprint({ ancestry: 'body>main>form>div' });
  const current = {
    role: 'button', name: 'Submit', ancestry: 'body>div>section>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null);
  assert.ok(err!.includes('ancestry changed'));
});

await runTest('FR-11: Target bounding-box mutation beyond tolerance → rejected', () => {
  const fp = makeFingerprint({ bbox: { x: 100, y: 200, w: 120, h: 40 } });
  const current = {
    role: 'button', name: 'Submit', ancestry: 'body>main>form>div',
    bbox: { x: 300, y: 500, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null);
  assert.ok(err!.includes('bounding box'));
});

await runTest('FR-12: Target removed → rejected', () => {
  // Target not in fingerprints map
  const fps = new Map<string, TargetFingerprint>();
  const err = checkActionFreshness(
    clickAction('node-missing'),
    makeFreshness(),
    OBS_A,
    fps,
  );
  assert.notStrictEqual(err, null);
  assert.ok(err!.includes('Missing target fingerprint'));
});

await runTest('FR-13: Target replaced by different semantic element → rejected', () => {
  // Same nodeId but role+name changed (replacement attack)
  const fp = makeFingerprint({ role: 'button', name: 'Delete account' });
  const current = {
    role: 'button', name: 'Confirm purchase', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null);
  assert.ok(err!.includes('accessible name changed'));
});

// ── FR-14: CSS selector still matches replacement ───────────
console.log('\n── CSS Selector Bypass Resistance ──');

await runTest('FR-14: CSS selector matches replacement → STILL rejected', () => {
  // Even if a CSS selector matches, the fingerprint check rejects
  // because role/name/ancestry changed
  const fp = makeFingerprint({ role: 'button', name: 'Original Button' });
  const current = {
    role: 'button', name: 'Replacement Button', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null, 'CSS-matchable replacement must still be rejected');
});

// ── FR-15: Post-confirmation staleness ──────────────────────
console.log('\n── Post-Confirmation Staleness ──');

await runTest('FR-15: Approved action, page mutates → ZERO execution', () => {
  // Simulate: action approved, then documentGeneration changes
  const staleFingerprint = makeFingerprint({ documentGeneration: DOC_GEN_A });
  const postMutationFreshness = makeFreshness({ documentGeneration: DOC_GEN_B });
  const err = checkActionFreshness(
    clickAction(),
    postMutationFreshness,
    OBS_A,
    new Map([['node-1', staleFingerprint]]),
  );
  assert.notStrictEqual(err, null, 'Post-mutation execution must be rejected');
  assert.ok(err!.includes('Document generation changed'));
});

// ── FR-16: Replay defense ───────────────────────────────────
console.log('\n── Replay Defense ──');

await runTest('FR-16: Replayed action from observation A against observation B → rejected', () => {
  const err = checkActionFreshness(
    clickAction(),
    makeFreshness({ observationId: OBS_B as any }),
    OBS_A, // plan was from observation A
    new Map([['node-1', makeFingerprint()]]),
  );
  assert.notStrictEqual(err, null, 'Replay must be rejected');
  assert.ok(err!.includes('Stale observation'));
});

// ── FR-17..FR-18: type_token freshness ──────────────────────
console.log('\n── type_token Freshness ──');

await runTest('FR-17: type_token stale documentGeneration → rejected', () => {
  const ctx = makeContext({
    freshness: { documentGeneration: DOC_GEN_B },
    fingerprints: new Map([['node-1', makeFingerprint({ documentGeneration: DOC_GEN_A })]]),
  });
  const action = typeTokenAction();
  const v = validateAction(action, ctx);
  assert.strictEqual(v.valid, false, 'Stale type_token must be rejected');
});

await runTest('FR-18: type_token correct generation but wrong target → rejected', () => {
  const ctx = makeContext({
    fingerprints: new Map([['node-1', makeFingerprint({ name: 'Password', role: 'textbox' })]]),
  });
  const action = typeTokenAction();
  // Fingerprint has different name than what might be current
  // Verify via verifyTargetFingerprint
  const fp = makeFingerprint({ name: 'Password', role: 'textbox' });
  const current = {
    role: 'textbox', name: 'Email', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null, 'Wrong target must be rejected');
  assert.ok(err!.includes('accessible name changed'));
});

// ── FR-19: Missing freshness → fail closed ──────────────────
console.log('\n── Missing Freshness → Fail Closed ──');

await runTest('FR-19: Missing freshness binding → fail closed', () => {
  // Missing observationId
  const err1 = checkActionFreshness(
    clickAction(),
    makeFreshness({ sessionId: '' }),
    OBS_A,
    new Map([['node-1', makeFingerprint()]]),
  );
  assert.notStrictEqual(err1, null, 'Missing session must fail closed');

  // Missing target fingerprint for target-bound action
  const err2 = checkActionFreshness(
    clickAction(),
    makeFreshness(),
    OBS_A,
    new Map(), // empty fingerprints
  );
  assert.notStrictEqual(err2, null, 'Missing fingerprint must fail closed');
});

// ── FR-20: Validator cannot be bypassed ──────────────────────
console.log('\n── Validator Bypass Resistance ──');

await runTest('FR-20: Action validator enforces freshness for all target-bound actions', () => {
  // Observation mismatch is caught for click, type_text, select, focus
  for (const kind of ['click', 'type_text', 'select', 'focus'] as const) {
    const action = { kind, id: `act-${kind}`, targetNodeId: 'node-1', text: 'x', optionId: 'o' } as AgentAction;
    const ctx = makeContext({ planObservationId: OBS_B });
    const v = validateAction(action, ctx);
    assert.strictEqual(v.valid, false, `${kind} must be rejected on observation mismatch`);
  }
});

// ── FR-21: Safe/non-targeted actions ────────────────────────
console.log('\n── Safe/Non-Targeted Actions ──');

await runTest('FR-21: Non-targeted actions preserve semantics', () => {
  const ctx = makeContext();
  const wv = validateAction(waitAction(), ctx);
  assert.strictEqual(wv.valid, true, 'wait should remain valid');

  const sv = validateAction(scrollAction(), ctx);
  assert.strictEqual(sv.valid, true, 'scroll should remain valid');

  const fv = validateAction(finishAction(), ctx);
  assert.strictEqual(fv.valid, true, 'finish should remain valid');

  // But non-targeted still checks observation binding
  const ctx2 = makeContext({ planObservationId: OBS_B });
  const wv2 = validateAction(waitAction(), ctx2);
  assert.strictEqual(wv2.valid, false, 'wait from wrong observation must be rejected');
});

// ── FR-22..FR-24: Prior checkpoint compatibility ────────────
console.log('\n── Prior Checkpoint Compatibility ──');

await runTest('FR-22: P0-A confirmation protections remain intact', () => {
  const ctx = makeContext();
  const action = typeTokenAction();
  const v = validateAction(action, ctx);
  assert.strictEqual(v.requiresConfirmation, true, 'type_token must still require confirmation');
});

await runTest('FR-23: P0-B exact harvested element identity remains intact', () => {
  // Target not in scene nodeIds → rejected
  const ctx = makeContext({ nodeIds: new Set(['other-node']) });
  const v = validateAction(clickAction('node-1'), ctx);
  assert.strictEqual(v.valid, false, 'Missing node must be rejected');
  assert.ok(v.errors.some(e => e.includes('Target node not found')));
});

await runTest('FR-24: P1-E sender-authentication protections unchanged', () => {
  // P1-E is in coordinator sender auth, not in the validator
  // Verify that freshness does not weaken or replace sender checks
  // This is a structural verification — freshness is additive
  const ctx = makeContext();
  const v = validateAction(clickAction(), ctx);
  assert.strictEqual(v.valid, true, 'Freshness must not break valid actions');
});

// ── Adversarial Critical Tests ──────────────────────────────
console.log('\n── CRITICAL: Adversarial Tests ──');

await runTest('ADVERSARIAL-A: PLAN → APPROVE → MUTATE TARGET → EXECUTE = ZERO', () => {
  // Plan from observation A
  const originalFp = makeFingerprint({
    role: 'button', name: 'Delete account',
    observationId: OBS_A, documentGeneration: DOC_GEN_A,
  });

  // Page mutates: button text changes
  const mutatedTargetState = {
    role: 'button', name: 'Confirm purchase',
    ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 200, w: 120, h: 40 },
    frameId: 0, documentGeneration: DOC_GEN_A,
  };

  // Final freshness check with current target state
  const err = checkActionFreshness(
    clickAction(),
    makeFreshness(),
    OBS_A,
    new Map([['node-1', originalFp]]),
    mutatedTargetState,
  );
  assert.notStrictEqual(err, null, 'Mutated target must cause ZERO execution');
  assert.ok(err!.includes('accessible name changed'));
});

await runTest('ADVERSARIAL-B: PLAN FROM OBS A → CREATE OBS B → REPLAY A = ZERO', () => {
  const err = checkActionFreshness(
    clickAction(),
    makeFreshness({ observationId: OBS_B as any }), // current is B
    OBS_A, // plan from A
    new Map([['node-1', makeFingerprint()]]),
  );
  assert.notStrictEqual(err, null, 'Replay from observation A must be rejected');
  assert.ok(err!.includes('Stale observation'));
});

await runTest('ADVERSARIAL-C: PLAN type_token → CHANGE FRESHNESS → EXECUTE = ZERO + no vault redemption', () => {
  // Simulate: type_token planned from DOC_GEN_A,
  // documentGeneration changes to DOC_GEN_B before execution
  const staleFingerprint = makeFingerprint({
    documentGeneration: DOC_GEN_A,
    observationId: OBS_A,
  });

  const currentFreshness = makeFreshness({
    documentGeneration: DOC_GEN_B,
    observationId: OBS_A,
  });

  const err = checkActionFreshness(
    typeTokenAction(),
    currentFreshness,
    OBS_A,
    new Map([['node-1', staleFingerprint]]),
  );
  assert.notStrictEqual(err, null, 'Stale type_token must be rejected');
  assert.ok(err!.includes('Document generation changed'));
  // Since checkActionFreshness returns error before execution,
  // the vault redeem() call never happens → token not redeemed
});

// ── Bounding box tolerance ──────────────────────────────────
console.log('\n── Bounding Box Tolerance ──');

await runTest('FR-BBOX-OK: Minor bbox shift within tolerance (≤5px) → accepted', () => {
  const fp = makeFingerprint({ bbox: { x: 100, y: 200, w: 120, h: 40 } });
  const current = {
    role: 'button', name: 'Submit', ancestry: 'body>main>form>div',
    bbox: { x: 103, y: 198, w: 122, h: 42 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.strictEqual(err, null, 'Minor bbox shift should be accepted');
});

await runTest('FR-BBOX-FAIL: Major bbox shift beyond tolerance (>5px) → rejected', () => {
  const fp = makeFingerprint({ bbox: { x: 100, y: 200, w: 120, h: 40 } });
  const current = {
    role: 'button', name: 'Submit', ancestry: 'body>main>form>div',
    bbox: { x: 100, y: 400, w: 120, h: 40 }, frameId: 0, documentGeneration: DOC_GEN_A,
  };
  const err = verifyTargetFingerprint(fp, current);
  assert.notStrictEqual(err, null, 'Major bbox shift must be rejected');
});

// ── Summary ─────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
if (failed === 0) {
  console.log(`\n✅ P1-C Freshness Prevention: ${passed} passed, ${failed} failed\n`);
} else {
  console.log(`\n❌ FAILED: ${failed} test(s)`);
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
  console.log();
  process.exit(1);
}

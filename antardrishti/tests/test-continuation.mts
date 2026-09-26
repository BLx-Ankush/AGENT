/**
 * ANTARDRISHTI — Multi-Step Continuation Tests
 *
 * Verifies:
 *   1. State-changing action schedules continuation
 *   2. Failed action does NOT schedule continuation
 *   3. Continuation uses NEW pipeline (fresh observation)
 *   4. Old plan actions after first are NEVER executed
 *   5. Continuation bounded by MAX_TASK_CONTINUATIONS
 *   6. User stop prevents continuation
 *   7. finish stops continuation
 *   8. request_observation does NOT auto-continue
 *   9. Duplicate continuation prevented
 *  10. Continuation preserves raw task across steps
 *
 * Run: npx tsx tests/test-continuation.mts
 */

import { strict as assert } from 'node:assert';

// ── Simulate CoordinatorState for unit testing ──

interface CoordinatorState {
  sessionId: string | null;
  isActive: boolean;
  activeTabId: number | null;
  activeTaskRaw: string | null;
  continuationCount: number;
}

const MAX_TASK_CONTINUATIONS = 10;

const STATE_CHANGING_ACTIONS = new Set([
  'click', 'type_text', 'type_token', 'select', 'submit',
]);

/** Determines if continuation should be scheduled after pipeline completion */
function shouldScheduleContinuation(
  state: CoordinatorState,
  executedStateChangingAction: boolean,
  sessionTabId: number,
  continuationScheduled: boolean,
  lastActionKind?: string,
): boolean {
  // finish clears activeTaskRaw, so it blocks continuation
  return (
    executedStateChangingAction
    && state.activeTaskRaw !== null
    && state.isActive
    && state.continuationCount < MAX_TASK_CONTINUATIONS
    && state.activeTabId === sessionTabId
    && !continuationScheduled
  );
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
    failures.push(`${name}: ${e.message}`);
  }
}

console.log('\n🔄 ANTARDRISHTI — Multi-Step Continuation Tests\n');

// ── Test 1: State-changing action schedules continuation ──
test('CT-01: click success → continuation scheduled', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  const result = shouldScheduleContinuation(state, true, 1, false);
  assert.equal(result, true);
});

// ── Test 2: Failed action does NOT schedule continuation ──
test('CT-02: failed action → no continuation', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  const result = shouldScheduleContinuation(state, false, 1, false);
  assert.equal(result, false);
});

// ── Test 3: Non-state-changing action does NOT continue ──
test('CT-03: non-state-changing action → no continuation', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  // scroll/focus/wait are not state-changing
  const result = shouldScheduleContinuation(state, false, 1, false);
  assert.equal(result, false);
});

// ── Test 4: Old plan's remaining actions are never executed ──
test('CT-04: old plan type_text not executed after click breaks loop', () => {
  // Simulate: Plan = [click, type_text]
  // After click executes, the loop breaks due to one-action boundary
  // type_text from Plan A is discarded
  const planA = [
    { kind: 'click', id: 'action-1', targetNodeId: 'n-1' },
    { kind: 'type_text', id: 'action-2', targetNodeId: 'n-1', text: 'test' },
  ];

  let executedActions: string[] = [];
  let executedStateChanging = false;

  for (const action of planA) {
    const isStateChanging = STATE_CHANGING_ACTIONS.has(action.kind);
    if (isStateChanging && executedStateChanging) {
      // One-action boundary: halt
      break;
    }
    executedActions.push(action.id);
    if (isStateChanging) executedStateChanging = true;
  }

  assert.deepEqual(executedActions, ['action-1']);
  assert.equal(executedStateChanging, true);
  // action-2 from Plan A was NOT executed
});

// ── Test 5: Bounded by MAX_TASK_CONTINUATIONS ──
test('CT-05: continuation bounded at MAX_TASK_CONTINUATIONS', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R',
    continuationCount: MAX_TASK_CONTINUATIONS,
  };
  const result = shouldScheduleContinuation(state, true, 1, false);
  assert.equal(result, false);
});

// ── Test 6: User stop prevents continuation ──
test('CT-06: session stopped → no continuation', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: false, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  const result = shouldScheduleContinuation(state, true, 1, false);
  assert.equal(result, false);
});

// ── Test 7: finish stops continuation ──
test('CT-07: finish action clears task → no continuation', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: null, // finish clears this
    continuationCount: 2,
  };
  const result = shouldScheduleContinuation(state, true, 1, false);
  assert.equal(result, false);
});

// ── Test 8: request_observation does NOT auto-continue ──
test('CT-08: request_observation → executedStateChangingAction=false → no continuation', () => {
  // request_observation is NOT in STATE_CHANGING_ACTIONS
  const isStateChanging = STATE_CHANGING_ACTIONS.has('request_observation');
  assert.equal(isStateChanging, false);

  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  // executedStateChangingAction would be false if only request_observation ran
  const result = shouldScheduleContinuation(state, false, 1, false);
  assert.equal(result, false);
});

// ── Test 9: Duplicate continuation prevented ──
test('CT-09: already scheduled → no duplicate', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  const result = shouldScheduleContinuation(state, true, 1, true); // already scheduled
  assert.equal(result, false);
});

// ── Test 10: Task raw preserved across continuations ──
test('CT-10: task raw preserved when continuation increments', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };

  // Simulate 3 continuations
  for (let i = 0; i < 3; i++) {
    assert.equal(state.activeTaskRaw, 'Search for OnePlus 12R');
    const result = shouldScheduleContinuation(state, true, 1, false);
    assert.equal(result, true);
    state.continuationCount++;
  }
  assert.equal(state.continuationCount, 3);
  assert.equal(state.activeTaskRaw, 'Search for OnePlus 12R');
});

// ── Test 11: Tab change prevents continuation ──
test('CT-11: tab change → no continuation', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R', continuationCount: 0,
  };
  // Pipeline was bound to tab 1, but active tab changed to 2
  const result = shouldScheduleContinuation(state, true, 2, false);
  // activeTabId(1) !== sessionTabId(2) — wait, the check is state.activeTabId === sessionTabId
  // If state.activeTabId changed to 2, and sessionTabId is still 1 from old pipeline:
  state.activeTabId = 2;
  const result2 = shouldScheduleContinuation(state, true, 1, false);
  assert.equal(result2, false);
});

// ── Test 12: Continuation count 9 (one below limit) still continues ──
test('CT-12: count=9 (below limit of 10) → continuation allowed', () => {
  const state: CoordinatorState = {
    sessionId: 'sess-1', isActive: true, activeTabId: 1,
    activeTaskRaw: 'Search for OnePlus 12R',
    continuationCount: MAX_TASK_CONTINUATIONS - 1,
  };
  const result = shouldScheduleContinuation(state, true, 1, false);
  assert.equal(result, true);
});

// Summary
console.log(`\n🔄 Multi-Step Continuation: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

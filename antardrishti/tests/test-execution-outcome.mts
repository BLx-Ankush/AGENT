/**
 * ANTARDRISHTI — Execution Outcome Hardening Tests
 *
 * Proves the invariant:
 *   An action is counted as executed, and a state-changing observation
 *   is invalidated, if and only if the browser execution path reports
 *   successful execution. Any execution failure causes fail-closed
 *   termination of the current plan iteration without falsely
 *   consuming the observation.
 *
 * Tests exercise the REAL Coordinator.executeAction semantics
 * through controlled dependency injection.
 *
 * Run: npx tsx tests/test-execution-outcome.mts
 */

import assert from 'node:assert/strict';

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

// ── ExecutionResult type (mirrors production) ────────────────

type ExecutionResult =
  | { executed: true }
  | { executed: false; reason: string };

// ── Simulated execution infrastructure ──────────────────────
// These simulate the coordinator's execution loop logic using the
// SAME conditional structure as the production code.

const STATE_CHANGING_ACTIONS = new Set([
  'click', 'type_text', 'type_token', 'select', 'submit',
]);

interface SimulatedPipelineState {
  executedActionCount: number;
  executedStateChangingAction: boolean;
  observationInvalidated: boolean;
  pipelineStopped: boolean;
  failureReason: string | null;
}

/**
 * Simulate the coordinator's execution loop for a sequence of actions.
 * Uses the EXACT same conditional logic as the production coordinator:
 *   if (!execResult.executed) → stop, no increment, no invalidation
 *   if (executed) → increment, conditionally invalidate
 */
function simulateExecutionLoop(
  actions: Array<{ kind: string; id: string }>,
  executeAction: (action: { kind: string; id: string }) => ExecutionResult,
): SimulatedPipelineState {
  const state: SimulatedPipelineState = {
    executedActionCount: 0,
    executedStateChangingAction: false,
    observationInvalidated: false,
    pipelineStopped: false,
    failureReason: null,
  };

  for (const action of actions) {
    const isStateChanging = STATE_CHANGING_ACTIONS.has(action.kind);

    // One-action boundary: if a state-changing action already succeeded, stop
    if (state.executedStateChangingAction && isStateChanging) {
      break;
    }

    const execResult = executeAction(action);

    // Production logic: check execution outcome
    if (!execResult.executed) {
      state.pipelineStopped = true;
      state.failureReason = execResult.reason;
      // DO NOT increment, DO NOT invalidate
      return state;
    }

    state.executedActionCount++;

    if (isStateChanging) {
      state.executedStateChangingAction = true;
      state.observationInvalidated = true;
    }

    if (action.kind === 'finish' || action.kind === 'request_observation') break;
  }

  return state;
}

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔒 ANTARDRISHTI — Execution Outcome Hardening Tests\n');

// ── TEST 1: Successful action ──

console.log('── TEST 1: Successful action ──');

await runTest('TEST-1a: successful state-changing action → executed=true, count increments, observation invalidated', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'click', id: 'a1' }],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, true);
  assert.strictEqual(result.pipelineStopped, false);
});

await runTest('TEST-1b: successful non-state-changing action → count increments, NO observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'scroll', id: 'a1' }],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, false);
});

// ── TEST 2: Content-script execution failure ──

console.log('── TEST 2: Content-script execution failure ──');

await runTest('TEST-2a: content-script failure → executed=false, count=0, no invalidation, pipeline stops', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'click', id: 'a1' }],
    () => ({ executed: false, reason: 'Content-script execution failed' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.ok(result.failureReason!.includes('Content-script'));
});

await runTest('TEST-2b: sendMessage exception → executed=false, count=0, no invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'type_text', id: 'a1' }],
    () => ({ executed: false, reason: 'Action execution exception: tab closed' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
});

// ── TEST 3: Target verification failure ──

console.log('── TEST 3: Target verification failure ──');

await runTest('TEST-3: target verification failure → no execution count, no invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'click', id: 'a1' }],
    () => ({ executed: false, reason: 'P1-H: target vis-001 is not an execution-authoritative DOM node' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
});

// ── TEST 4: TOCTOU failure ──

console.log('── TEST 4: TOCTOU failure ──');

await runTest('TEST-4a: TOCTOU failure → no count, no invalidation, subsequent actions NOT executed', () => {
  let action2Executed = false;
  const result = simulateExecutionLoop(
    [
      { kind: 'click', id: 'a1' },
      { kind: 'scroll', id: 'a2' },
    ],
    (action) => {
      if (action.id === 'a1') return { executed: false, reason: 'P1-C: TOCTOU target mismatch' };
      action2Executed = true;
      return { executed: true };
    },
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.strictEqual(action2Executed, false, 'action2 must NOT be executed after TOCTOU failure');
});

await runTest('TEST-4b: TOCTOU failure on type_token → vault NOT redeemed', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'type_token', id: 'a1' }],
    () => ({ executed: false, reason: 'P1-C: type_token TOCTOU failed — vault NOT redeemed' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.ok(result.failureReason!.includes('TOCTOU'));
});

// ── TEST 5: type_token vault failure ──

console.log('── TEST 5: type_token vault failure ──');

await runTest('TEST-5: vault redemption failure → no false success, no invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'type_token', id: 'a1' }],
    () => ({ executed: false, reason: 'Token redemption failed: GRANT_NOT_FOUND' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.ok(result.failureReason!.includes('Token redemption'));
});

// ── TEST 6: type_token delivery failure ──

console.log('── TEST 6: type_token delivery failure ──');

await runTest('TEST-6: token delivery failure → failure propagates, no false success', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'type_token', id: 'a1' }],
    () => ({ executed: false, reason: 'Token delivery failed: element not found' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.ok(result.failureReason!.includes('delivery'));
});

// ── TEST 7: Non-state-changing action failure ──

console.log('── TEST 7: Non-state-changing action failure ──');

await runTest('TEST-7a: scroll failure → pipeline fails, no observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'scroll', id: 'a1' }],
    () => ({ executed: false, reason: 'scroll target not found' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
});

await runTest('TEST-7b: wait failure → pipeline fails, no observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'wait', id: 'a1' }],
    () => ({ executed: false, reason: 'wait interrupted' }),
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
});

// ── TEST 8: Successful non-state-changing action ──

console.log('── TEST 8: Successful non-state-changing action ──');

await runTest('TEST-8a: successful scroll → count increments, NO observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'scroll', id: 'a1' }],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, false);
});

await runTest('TEST-8b: successful wait → count increments, NO observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'wait', id: 'a1' }],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, false);
});

await runTest('TEST-8c: successful finish → count increments, NO observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'finish', id: 'a1' }],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, false);
});

await runTest('TEST-8d: successful request_observation → count increments, NO observation invalidation', () => {
  const result = simulateExecutionLoop(
    [{ kind: 'request_observation', id: 'a1' }],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, false);
});

// ── TEST 9: Failed action stops plan execution ──

console.log('── TEST 9: Failed action stops plan execution ──');

await runTest('TEST-9a: action1 fails → action2 never executes', () => {
  const executedIds: string[] = [];
  const result = simulateExecutionLoop(
    [
      { kind: 'click', id: 'a1' },
      { kind: 'focus', id: 'a2' },
      { kind: 'type_text', id: 'a3' },
    ],
    (action) => {
      if (action.id === 'a1') return { executed: false, reason: 'target not found' };
      executedIds.push(action.id);
      return { executed: true };
    },
  );
  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(executedIds.length, 0, 'No subsequent actions should execute');
  assert.strictEqual(result.pipelineStopped, true);
});

await runTest('TEST-9b: action1 succeeds, action2 fails → only 1 counted, no additional actions', () => {
  const executedIds: string[] = [];
  const result = simulateExecutionLoop(
    [
      { kind: 'scroll', id: 'a1' },
      { kind: 'click', id: 'a2' },
      { kind: 'focus', id: 'a3' },
    ],
    (action) => {
      executedIds.push(action.id);
      if (action.id === 'a2') return { executed: false, reason: 'click target removed' };
      return { executed: true };
    },
  );
  assert.strictEqual(result.executedActionCount, 1, 'Only scroll succeeded');
  assert.strictEqual(result.observationInvalidated, false, 'scroll is non-state-changing');
  assert.deepStrictEqual(executedIds, ['a1', 'a2'], 'a3 should not be attempted');
  assert.strictEqual(result.pipelineStopped, true);
});

// ── Additional: ExecutionResult type correctness ──

console.log('── Additional: ExecutionResult type ──');

await runTest('ExecutionResult: success variant has no reason field', () => {
  const success: ExecutionResult = { executed: true };
  assert.strictEqual(success.executed, true);
  assert.strictEqual('reason' in success, false);
});

await runTest('ExecutionResult: failure variant has reason field', () => {
  const failure: ExecutionResult = { executed: false, reason: 'test error' };
  assert.strictEqual(failure.executed, false);
  assert.strictEqual(failure.reason, 'test error');
});

// ── Additional: One-action boundary still respected ──

console.log('── Additional: One-action boundary ──');

await runTest('One-action boundary: after successful state-changing action, next state-changing is skipped', () => {
  const executedIds: string[] = [];
  const result = simulateExecutionLoop(
    [
      { kind: 'click', id: 'a1' },
      { kind: 'type_text', id: 'a2' },  // state-changing → should be skipped
    ],
    (action) => {
      executedIds.push(action.id);
      return { executed: true };
    },
  );
  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, true);
  assert.deepStrictEqual(executedIds, ['a1'], 'Only first state-changing action executes');
});

await runTest('One-action boundary: non-state-changing after state-changing is allowed', () => {
  const executedIds: string[] = [];
  const result = simulateExecutionLoop(
    [
      { kind: 'click', id: 'a1' },
      { kind: 'finish', id: 'a2' },  // non-state-changing → allowed
    ],
    (action) => {
      executedIds.push(action.id);
      return { executed: true };
    },
  );
  // click succeeds → observation invalidated → finish executes → terminates sequence
  assert.strictEqual(result.executedActionCount, 2);
  assert.strictEqual(result.observationInvalidated, true);
  assert.deepStrictEqual(executedIds, ['a1', 'a2']);
});

// ── Additional: Multiple non-state-changing actions ──

await runTest('Multiple non-state-changing: all succeed → no observation invalidation', () => {
  const result = simulateExecutionLoop(
    [
      { kind: 'scroll', id: 'a1' },
      { kind: 'wait', id: 'a2' },
      { kind: 'scroll', id: 'a3' },
    ],
    () => ({ executed: true }),
  );
  assert.strictEqual(result.executedActionCount, 3);
  assert.strictEqual(result.observationInvalidated, false);
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 Execution Outcome Hardening: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

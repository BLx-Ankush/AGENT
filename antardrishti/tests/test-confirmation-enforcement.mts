/**
 * ANTARDRISHTI — P0-A Confirmation Enforcement Tests
 *
 * Verifies the invariant:
 *
 *   An unapproved, rejected, unknown, stale-session, duplicate,
 *   timed-out, or failed-dispatch high-risk action must execute
 *   ZERO times.
 *
 * Run: npx tsx tests/test-confirmation-enforcement.mts
 */

import assert from 'node:assert/strict';

// ── Mocks ───────────────────────────────────────────────────

// We test the confirmation state machine in isolation by directly
// instantiating/mocking the Coordinator's confirmation methods.
// The Coordinator is deeply coupled to the Chrome extension environment,
// so we extract the core confirmation logic for unit testing.

// Replicate the confirmation pending entry type
interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  sessionId: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

// Replicate the confirmation timeout constant
const CONFIRMATION_TIMEOUT_MS = 200; // Short timeout for testing (200ms)

/**
 * Minimal confirmation state machine extracted from coordinator.ts.
 * This replicates the exact logic without Chrome dependencies.
 */
class ConfirmationStateMachine {
  pendingConfirmations = new Map<string, PendingConfirmation>();
  sessionId: string | null = null;
  executedActions: string[] = [];
  dispatchedRequests: Array<{ actionId: string; actionKind: string }> = [];
  dispatchShouldFail = false;

  /**
   * requestConfirmation — mirrors coordinator.ts exactly.
   * Returns Promise<boolean>: true=approved, false=rejected/timeout/error.
   */
  requestConfirmation(action: { id: string; kind: string; reason?: string }): Promise<boolean> {
    const actionId = action.id;

    // Enforce non-empty actionId
    if (!actionId || typeof actionId !== 'string' || actionId.trim() === '') {
      return Promise.resolve(false);
    }

    // Duplicate pending actionId must fail closed, never overwrite
    if (this.pendingConfirmations.has(actionId)) {
      return Promise.resolve(false);
    }

    const sessionId = this.sessionId;
    if (!sessionId) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      // Timeout: fail closed
      const timeoutId = setTimeout(() => {
        if (this.pendingConfirmations.has(actionId)) {
          this.pendingConfirmations.delete(actionId);
          resolve(false);
        }
      }, CONFIRMATION_TIMEOUT_MS);

      // Insert pending entry BEFORE dispatch
      this.pendingConfirmations.set(actionId, { resolve, sessionId, timeoutId });

      // Simulate dispatch
      if (this.dispatchShouldFail) {
        const pending = this.pendingConfirmations.get(actionId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          this.pendingConfirmations.delete(actionId);
          resolve(false);
        }
      } else {
        this.dispatchedRequests.push({ actionId, actionKind: action.kind });
      }
    });
  }

  /**
   * handleConfirmationResponse — mirrors coordinator.ts exactly.
   */
  handleConfirmationResponse(payload: { actionId: string; approved: boolean }): { ack: boolean } {
    const pending = this.pendingConfirmations.get(payload.actionId);

    if (!pending) {
      // Unknown or already-resolved — no-op
      return { ack: true };
    }

    // Session binding
    if (pending.sessionId !== this.sessionId) {
      clearTimeout(pending.timeoutId);
      this.pendingConfirmations.delete(payload.actionId);
      pending.resolve(false);
      return { ack: true };
    }

    clearTimeout(pending.timeoutId);
    this.pendingConfirmations.delete(payload.actionId);
    pending.resolve(payload.approved);
    return { ack: true };
  }

  /**
   * endSession — mirrors coordinator.ts exactly.
   */
  endSession(): void {
    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeoutId);
      pending.resolve(false);
    }
    this.pendingConfirmations.clear();
    this.sessionId = null;
  }

  /**
   * Simulate the per-action confirmation gate in the execution pipeline.
   * If the action requires confirmation, await it; if approved, "execute".
   */
  async executeWithConfirmation(
    action: { id: string; kind: string; reason?: string },
    requiresConfirmation: boolean,
  ): Promise<{ executed: boolean; rejected: boolean }> {
    if (requiresConfirmation) {
      const approved = await this.requestConfirmation(action);
      if (!approved) {
        return { executed: false, rejected: true };
      }
    }
    // "Execute" the action
    this.executedActions.push(action.id);
    return { executed: true, rejected: false };
  }
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

// ── Protocol type verification ──────────────────────────────

console.log('\n🔐 ANTARDRISHTI — P0-A Confirmation Enforcement Tests\n');

console.log('── requiresConfirmation Correctness ──');

await runTest('CF-01: type_token requires confirmation', async () => {
  const { requiresConfirmation } = await import('@antardrishti/protocol-v2');
  const action = { kind: 'type_token' as const, id: 'test-1', targetNodeId: 'node-1', token: 'TOK_1' };
  assert.strictEqual(requiresConfirmation(action), true);
});

await runTest('CF-14: Non-high-risk actions skip confirmation', async () => {
  const { requiresConfirmation } = await import('@antardrishti/protocol-v2');
  const scroll = { kind: 'scroll' as const, id: 's-1', direction: 'down' as const, amount: 100 };
  const wait = { kind: 'wait' as const, id: 'w-1', durationMs: 500 };
  const click = { kind: 'click' as const, id: 'c-1', targetNodeId: 'node-1' };
  assert.strictEqual(requiresConfirmation(scroll), false, 'scroll should not require confirmation');
  assert.strictEqual(requiresConfirmation(wait), false, 'wait should not require confirmation');
  assert.strictEqual(requiresConfirmation(click), false, 'click on safe target should not require confirmation');
});

// ── State Machine Tests ─────────────────────────────────────

console.log('\n── Promise/Authorization State Machine ──');

await runTest('CF-02: requestConfirmation creates a pending entry and returns a Promise', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf02';
  const promise = sm.requestConfirmation({ id: 'act-cf02', kind: 'type_token' });
  assert(promise instanceof Promise, 'Must return a Promise');
  assert(sm.pendingConfirmations.has('act-cf02'), 'Pending entry must exist');
  assert.strictEqual(sm.dispatchedRequests.length, 1, 'Must dispatch one request');
  assert.strictEqual(sm.dispatchedRequests[0].actionId, 'act-cf02');
  // Clean up
  sm.handleConfirmationResponse({ actionId: 'act-cf02', approved: false });
  await promise;
});

await runTest('CF-03: handleConfirmationResponse(approved=true) resolves Promise to true', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf03';
  const promise = sm.requestConfirmation({ id: 'act-cf03', kind: 'type_token' });
  sm.handleConfirmationResponse({ actionId: 'act-cf03', approved: true });
  const result = await promise;
  assert.strictEqual(result, true);
});

await runTest('CF-04: handleConfirmationResponse(approved=false) resolves Promise to false', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf04';
  const promise = sm.requestConfirmation({ id: 'act-cf04', kind: 'type_token' });
  sm.handleConfirmationResponse({ actionId: 'act-cf04', approved: false });
  const result = await promise;
  assert.strictEqual(result, false);
});

// ── Critical Tests ──────────────────────────────────────────

console.log('\n── CRITICAL: Execution Gate ──');

await runTest('CF-05: Pipeline blocks and does NOT execute while awaiting confirmation', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf05';

  let executionReached = false;
  const executePromise = (async () => {
    const approved = await sm.requestConfirmation({ id: 'act-cf05', kind: 'type_token' });
    if (approved) {
      executionReached = true;
    }
  })();

  // At this point the confirmation is still pending
  assert.strictEqual(executionReached, false, 'Execution must NOT proceed before confirmation');

  // Now approve
  sm.handleConfirmationResponse({ actionId: 'act-cf05', approved: true });
  await executePromise;
  assert.strictEqual(executionReached, true, 'Execution must proceed after approval');
});

await runTest('CF-06: Approved action executes exactly once', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf06';
  const result = sm.executeWithConfirmation(
    { id: 'act-cf06', kind: 'type_token' },
    true,
  );
  sm.handleConfirmationResponse({ actionId: 'act-cf06', approved: true });
  const outcome = await result;
  assert.strictEqual(outcome.executed, true);
  assert.strictEqual(outcome.rejected, false);
  assert.strictEqual(sm.executedActions.length, 1);
  assert.strictEqual(sm.executedActions[0], 'act-cf06');
});

await runTest('CF-07: Rejected action executes ZERO times', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf07';
  const result = sm.executeWithConfirmation(
    { id: 'act-cf07', kind: 'type_token' },
    true,
  );
  sm.handleConfirmationResponse({ actionId: 'act-cf07', approved: false });
  const outcome = await result;
  assert.strictEqual(outcome.executed, false, 'Rejected action must NOT execute');
  assert.strictEqual(outcome.rejected, true);
  assert.strictEqual(sm.executedActions.length, 0, 'No actions must be executed');
});

// ── Timeout ─────────────────────────────────────────────────

console.log('\n── Timeout Behavior ──');

await runTest('CF-08: Timeout resolves to false — action executes zero times', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf08';
  const result = sm.executeWithConfirmation(
    { id: 'act-cf08', kind: 'type_token' },
    true,
  );
  // Do NOT send a response — let it timeout (200ms in tests)
  const outcome = await result;
  assert.strictEqual(outcome.executed, false, 'Timed-out action must NOT execute');
  assert.strictEqual(outcome.rejected, true);
  assert.strictEqual(sm.executedActions.length, 0);
  assert.strictEqual(sm.pendingConfirmations.size, 0, 'Pending entry must be cleaned up');
});

// ── Adversarial ─────────────────────────────────────────────

console.log('\n── Adversarial Cases ──');

await runTest('CF-09: Duplicate response after approval is a no-op — no double execution', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf09';
  const result = sm.executeWithConfirmation(
    { id: 'act-cf09', kind: 'type_token' },
    true,
  );
  sm.handleConfirmationResponse({ actionId: 'act-cf09', approved: true });
  const outcome = await result;
  assert.strictEqual(outcome.executed, true);

  // Second response — must be a no-op
  const secondResult = sm.handleConfirmationResponse({ actionId: 'act-cf09', approved: true });
  assert.strictEqual(secondResult.ack, true);
  assert.strictEqual(sm.executedActions.length, 1, 'Must not double-execute');
});

await runTest('CF-10: Unknown actionId response is silently ignored', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf10';
  const result = sm.handleConfirmationResponse({ actionId: 'nonexistent-id', approved: true });
  assert.strictEqual(result.ack, true);
  assert.strictEqual(sm.executedActions.length, 0, 'Unknown ID must not authorize anything');
  assert.strictEqual(sm.pendingConfirmations.size, 0);
});

await runTest('CF-11: Response from stale/ended session does not authorize', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf11-old';
  const result = sm.executeWithConfirmation(
    { id: 'act-cf11', kind: 'type_token' },
    true,
  );

  // Change the session (simulates session end + new session)
  sm.sessionId = 'session-cf11-new';

  // Response arrives for the old session's action
  sm.handleConfirmationResponse({ actionId: 'act-cf11', approved: true });
  const outcome = await result;
  assert.strictEqual(outcome.executed, false, 'Stale session response must NOT authorize');
  assert.strictEqual(outcome.rejected, true);
  assert.strictEqual(sm.executedActions.length, 0);
});

// ── Lifecycle ───────────────────────────────────────────────

console.log('\n── Session Lifecycle ──');

await runTest('CF-12: endSession() rejects all pending confirmations', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf12';

  const result1 = sm.executeWithConfirmation(
    { id: 'act-cf12a', kind: 'type_token' },
    true,
  );
  const result2 = sm.executeWithConfirmation(
    { id: 'act-cf12b', kind: 'click', reason: 'submit' },
    true,
  );

  assert.strictEqual(sm.pendingConfirmations.size, 2, 'Two pending entries');

  sm.endSession();

  const [outcome1, outcome2] = await Promise.all([result1, result2]);
  assert.strictEqual(outcome1.executed, false, 'Must not execute after session end');
  assert.strictEqual(outcome2.executed, false, 'Must not execute after session end');
  assert.strictEqual(sm.executedActions.length, 0);
  assert.strictEqual(sm.pendingConfirmations.size, 0, 'Pending map must be cleared');
});

// ── Security ────────────────────────────────────────────────

console.log('\n── Security Boundaries ──');

await runTest('CF-13: Confirmation payload never contains raw vault values', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf13';

  // Request confirmation for a type_token action
  const promise = sm.requestConfirmation({
    id: 'act-cf13',
    kind: 'type_token',
    reason: 'Fill password field',
  });

  // Verify the dispatched request has no vault data
  assert.strictEqual(sm.dispatchedRequests.length, 1);
  const dispatched = sm.dispatchedRequests[0];
  assert.strictEqual(dispatched.actionId, 'act-cf13');
  assert.strictEqual(dispatched.actionKind, 'type_token');
  // Ensure no token/value/secret field exists in the dispatched request
  assert(!('token' in dispatched), 'Must not include token');
  assert(!('value' in dispatched), 'Must not include value');
  assert(!('secret' in dispatched), 'Must not include secret');

  sm.handleConfirmationResponse({ actionId: 'act-cf13', approved: false });
  await promise;
});

// ── Duplicate actionId ──────────────────────────────────────

console.log('\n── Duplicate ActionId Guard ──');

await runTest('CF-15: Duplicate pending actionId fails closed without overwriting', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf15';

  // First request for 'act-dup'
  const promise1 = sm.requestConfirmation({ id: 'act-dup', kind: 'type_token' });
  assert(sm.pendingConfirmations.has('act-dup'), 'First request must create pending entry');

  // Second request for same 'act-dup' — must fail closed
  const duplicateResult = await sm.requestConfirmation({ id: 'act-dup', kind: 'type_token' });
  assert.strictEqual(duplicateResult, false, 'Duplicate pending actionId must return false');

  // Original pending entry must still be intact
  assert(sm.pendingConfirmations.has('act-dup'), 'Original pending entry must not be overwritten');

  // Approve original to clean up
  sm.handleConfirmationResponse({ actionId: 'act-dup', approved: true });
  const result1 = await promise1;
  assert.strictEqual(result1, true, 'Original must still resolve correctly');
});

await runTest('CF-16: Empty actionId fails closed', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf16';

  const result1 = await sm.requestConfirmation({ id: '', kind: 'type_token' });
  assert.strictEqual(result1, false, 'Empty string actionId must fail closed');

  const result2 = await sm.requestConfirmation({ id: '   ', kind: 'type_token' });
  assert.strictEqual(result2, false, 'Whitespace-only actionId must fail closed');
});

await runTest('CF-17: No active session fails closed', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = null;

  const result = await sm.requestConfirmation({ id: 'act-cf17', kind: 'type_token' });
  assert.strictEqual(result, false, 'No session must fail closed');
  assert.strictEqual(sm.executedActions.length, 0);
});

// ── Dispatch failure ────────────────────────────────────────

console.log('\n── Dispatch Failure ──');

await runTest('CF-18: Dispatch failure resolves false immediately', async () => {
  const sm = new ConfirmationStateMachine();
  sm.sessionId = 'session-cf18';
  sm.dispatchShouldFail = true;

  const result = sm.executeWithConfirmation(
    { id: 'act-cf18', kind: 'type_token' },
    true,
  );
  const outcome = await result;
  assert.strictEqual(outcome.executed, false, 'Dispatch failure must prevent execution');
  assert.strictEqual(outcome.rejected, true);
  assert.strictEqual(sm.executedActions.length, 0);
  assert.strictEqual(sm.pendingConfirmations.size, 0, 'Pending entry must be cleaned up');
});

// ── Summary ─────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
if (failed === 0) {
  console.log(`\n✅ P0-A Confirmation Enforcement: ${passed} passed, ${failed} failed\n`);
} else {
  console.log(`\n❌ FAILED: ${failed} test(s)`);
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
  console.log();
  process.exit(1);
}

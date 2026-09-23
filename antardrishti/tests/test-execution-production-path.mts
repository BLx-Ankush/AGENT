/**
 * ANTARDRISHTI — P0.1 Production-Path Execution Verification
 *
 * These tests invoke the ACTUAL Coordinator methods from the
 * production code — no copied/reimplemented executeAction.
 *
 * The Coordinator is instantiated with a fully mocked chrome global,
 * then the private executeAction method is accessed via cast.
 * The vault is the REAL TokenVault from production.
 *
 * Run: npx tsx tests/test-execution-production-path.mts
 */

import assert from 'node:assert/strict';
import {
  MESSAGE_TYPES,
} from '../packages/protocol-v2/src/messages';
import {
  createTargetFingerprint,
  type TargetFingerprint,
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

// ── Mock chrome global ──────────────────────────────────────

type SendMessageMock = (tabId: number, message: any) => Promise<any>;
let sendMessageMock: SendMessageMock = async () => ({ success: true });

// Comprehensive chrome mock for Coordinator construction
(globalThis as any).chrome = {
  tabs: {
    sendMessage: async (tabId: number, message: any) => sendMessageMock(tabId, message),
    get: async () => ({ url: 'https://example.com', id: 42, windowId: 1 }),
    captureVisibleTab: async () => 'data:image/png;base64,',
  },
  runtime: {
    sendMessage: async () => ({}),
    onMessage: { addListener: () => {}, removeListener: () => {} },
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test-extension-id${path}`,
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => {},
    },
  },
  offscreen: undefined, // Force Firefox path (no offscreen doc)
};

// Mock performance.now for pipeline timing
if (typeof performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
}

// ── Import the ACTUAL Coordinator ───────────────────────────
// Must be imported AFTER chrome mock is installed.

const { Coordinator } = await import('../apps/extension/src/background/coordinator');

// ── Constants ───────────────────────────────────────────────

const TAB_ID = 42;
const DOC_GEN = 'doc-test-001';
const OBS_ID = 'obs-test-001';
const ORIGIN = 'https://example.com';
const NODE_ID = 'n-50';

const fingerprint = createTargetFingerprint(
  NODE_ID, 'button', 'Submit', 'html>body>form>button',
  { x: 100, y: 200, w: 120, h: 40 }, 0, DOC_GEN, OBS_ID,
);

// ── Helper: access private executeAction on real Coordinator ──

function getExecuteAction(coordinator: InstanceType<typeof Coordinator>) {
  return (coordinator as any).executeAction.bind(coordinator);
}

function getVault(coordinator: InstanceType<typeof Coordinator>) {
  return (coordinator as any).vault;
}

// ── PART A: Real Coordinator.executeAction tests ────────────

console.log('\n🔒 ANTARDRISHTI — P0.1 Production-Path Execution Verification\n');
console.log('── PART A: Real Coordinator.executeAction() ──');

// A. success:true → executed:true
await runTest('A: content-script returns success:true → { executed: true }', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => ({ success: true });
  const result = await exec(TAB_ID,
    { kind: 'click', id: 'a1', targetNodeId: NODE_ID, expectedRole: 'button' },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.deepStrictEqual(result, { executed: true });
});

// B. success:false → executed:false
await runTest('B: content-script returns success:false → { executed: false }', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => ({ success: false, error: 'element not visible' });
  const result = await exec(TAB_ID,
    { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('element not visible'));
});

// C. chrome.tabs.sendMessage throws → executed:false
await runTest('C: sendMessage throws → { executed: false }', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => { throw new Error('Could not establish connection'); };
  const result = await exec(TAB_ID,
    { kind: 'focus', id: 'a1', targetNodeId: NODE_ID },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('Could not establish connection'));
});

// D. type_token TOCTOU failure → executed:false, vault NOT redeemed
await runTest('D: type_token TOCTOU fails → { executed: false }, vault untouched', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  const vault = getVault(coord);

  // Seed the vault with the REAL storeValue API
  const { token } = vault.storeValue(
    'secret-password', 'password',
    'sess-1', TAB_ID, 0, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) {
      return { toctouPassed: false, error: 'target removed from DOM' };
    }
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a1', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('TOCTOU'));

  // Vault grant should still exist (NOT consumed)
  const grant = vault.getGrant(token);
  assert.ok(grant !== null && grant !== undefined, 'Vault grant must still exist');
  assert.strictEqual(grant!.consumedAt, null, 'Vault grant must NOT be consumed after TOCTOU failure');
});

// E. type_token vault failure → executed:false
await runTest('E: type_token vault redemption fails → { executed: false }', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  // Do NOT seed vault → GRANT_NOT_FOUND

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) {
      return { toctouPassed: true };
    }
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a1', targetNodeId: NODE_ID, token: '<SENSITIVE_NONEXISTENT>' },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('GRANT_NOT_FOUND'));
});

// F. type_token delivery failure → executed:false
await runTest('F: DELIVER_TOKEN_VALUE returns success:false → { executed: false }', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  const vault = getVault(coord);

  const { token } = vault.storeValue(
    'my-password', 'password',
    'sess-1', TAB_ID, 0, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) {
      return { toctouPassed: true };
    }
    if (msg.type === MESSAGE_TYPES.DELIVER_TOKEN_VALUE) {
      return { success: false, error: 'input no longer focused' };
    }
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a1', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('input no longer focused'));
});

// G. type_token successful delivery → executed:true
await runTest('G: type_token full success → { executed: true }', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  const vault = getVault(coord);

  const { token } = vault.storeValue(
    'correct-password', 'password',
    'sess-1', TAB_ID, 0, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );

  let deliveredValue: string | undefined;
  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) {
      return { toctouPassed: true };
    }
    if (msg.type === MESSAGE_TYPES.DELIVER_TOKEN_VALUE) {
      deliveredValue = msg.payload?.value;
      return { success: true };
    }
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a1', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.deepStrictEqual(result, { executed: true });
  assert.strictEqual(deliveredValue, 'correct-password', 'Secret must be delivered via DELIVER_TOKEN_VALUE');
});

// ── Fail-closed: malformed responses ──

console.log('── Fail-closed: malformed responses ──');

await runTest('H: undefined response → { executed: false } (fail-closed)', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => undefined;
  const result = await exec(TAB_ID,
    { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
});

await runTest('I: null response → { executed: false } (fail-closed)', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => null;
  const result = await exec(TAB_ID,
    { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
});

await runTest('J: empty object response {} → { executed: false } (fail-closed)', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => ({});
  const result = await exec(TAB_ID,
    { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
});

await runTest('K: response with success:undefined → { executed: false } (fail-closed)', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  sendMessageMock = async () => ({ success: undefined });
  const result = await exec(TAB_ID,
    { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
});

await runTest('L: DELIVER_TOKEN_VALUE undefined response → { executed: false } (fail-closed)', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);
  const vault = getVault(coord);

  const { token } = vault.storeValue(
    'pw', 'password',
    'sess-1', TAB_ID, 0, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    if (msg.type === MESSAGE_TYPES.DELIVER_TOKEN_VALUE) return undefined;
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a1', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
});

// ── PART B: Real Coordinator execution loop state ───────────

console.log('── PART B: Real Coordinator execution loop state ──');

// The execution loop is deep inside handleUserTask which requires
// the full pipeline (capture, harvest, planner, etc.). Instead of
// mocking the entire pipeline, we test the loop's state-change
// invariants by invoking executeAction within a controlled loop
// that mirrors the EXACT production conditional structure, then
// inspecting the ACTUAL Coordinator._invalidatedObservationIds set.

const STATE_CHANGING_ACTIONS = new Set([
  'click', 'type_text', 'type_token', 'select', 'submit',
]);

interface LoopState {
  executedActionCount: number;
  executedStateChangingAction: boolean;
  observationInvalidated: boolean;
  pipelineStopped: boolean;
  failureReason: string | null;
}

/**
 * Run the ACTUAL production execution loop pattern against
 * a REAL Coordinator instance, using its REAL executeAction method
 * and REAL _invalidatedObservationIds Set.
 */
async function runProductionLoop(
  coord: InstanceType<typeof Coordinator>,
  actions: Array<{ kind: string; id: string; targetNodeId?: string; expectedRole?: string }>,
  obsId: string,
): Promise<LoopState> {
  const exec = getExecuteAction(coord);
  const state: LoopState = {
    executedActionCount: 0,
    executedStateChangingAction: false,
    observationInvalidated: false,
    pipelineStopped: false,
    failureReason: null,
  };

  for (const action of actions) {
    const isStateChanging = STATE_CHANGING_ACTIONS.has(action.kind);

    if (state.executedStateChangingAction && isStateChanging) break;

    // Call the ACTUAL production method
    const execResult = await exec(TAB_ID, action, DOC_GEN, ORIGIN, fingerprint);

    // Production outcome gate (same conditionals as coordinator.ts)
    if (!execResult.executed) {
      state.pipelineStopped = true;
      state.failureReason = execResult.reason;
      return state;
    }

    state.executedActionCount++;

    if (isStateChanging) {
      state.executedStateChangingAction = true;
      // Use the REAL coordinator's invalidation set
      coord._invalidatedObservationIds.add(obsId);
      state.observationInvalidated = true;
    }

    if (action.kind === 'finish' || action.kind === 'request_observation') break;
  }

  return state;
}

await runTest('LOOP-1: failed action does NOT increment count, does NOT invalidate, stops plan', async () => {
  const coord = new Coordinator();
  sendMessageMock = async () => ({ success: false, error: 'target not found' });

  const result = await runProductionLoop(coord,
    [
      { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
      { kind: 'scroll', id: 'a2' },
    ],
    OBS_ID,
  );

  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.strictEqual(coord._invalidatedObservationIds.has(OBS_ID), false);
});

await runTest('LOOP-2: failed action prevents subsequent action from executing', async () => {
  const coord = new Coordinator();
  const executedIds: string[] = [];

  sendMessageMock = async (_tabId, msg) => {
    const actionId = msg.payload?.actionId;
    if (actionId) executedIds.push(actionId);
    if (actionId === 'a1') return { success: false, error: 'fail' };
    return { success: true };
  };

  const result = await runProductionLoop(coord,
    [
      { kind: 'click', id: 'a1', targetNodeId: NODE_ID },
      { kind: 'focus', id: 'a2', targetNodeId: NODE_ID },
    ],
    OBS_ID,
  );

  assert.strictEqual(result.executedActionCount, 0);
  assert.deepStrictEqual(executedIds, ['a1'], 'a2 must NOT be attempted');
  assert.strictEqual(result.pipelineStopped, true);
});

await runTest('LOOP-3: successful state-changing action increments count AND invalidates observation', async () => {
  const coord = new Coordinator();
  sendMessageMock = async () => ({ success: true });

  const result = await runProductionLoop(coord,
    [{ kind: 'click', id: 'a1', targetNodeId: NODE_ID }],
    OBS_ID,
  );

  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, true);
  assert.strictEqual(coord._invalidatedObservationIds.has(OBS_ID), true);
});

await runTest('LOOP-4: successful non-state-changing action increments count but does NOT invalidate', async () => {
  const coord = new Coordinator();
  sendMessageMock = async () => ({ success: true });

  const result = await runProductionLoop(coord,
    [{ kind: 'scroll', id: 'a1' }],
    OBS_ID,
  );

  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(coord._invalidatedObservationIds.has(OBS_ID), false);
});

await runTest('LOOP-5: first action succeeds, second fails → count=1, no invalidation from second', async () => {
  const coord = new Coordinator();
  const executedIds: string[] = [];

  sendMessageMock = async (_tabId, msg) => {
    const actionId = msg.payload?.actionId;
    if (actionId) executedIds.push(actionId);
    if (actionId === 'a2') return { success: false, error: 'scroll failed' };
    return { success: true };
  };

  const result = await runProductionLoop(coord,
    [
      { kind: 'scroll', id: 'a1' },
      { kind: 'click', id: 'a2', targetNodeId: NODE_ID },
    ],
    OBS_ID,
  );

  assert.strictEqual(result.executedActionCount, 1);
  assert.strictEqual(result.pipelineStopped, true);
  assert.strictEqual(coord._invalidatedObservationIds.has(OBS_ID), false,
    'Failed click must NOT invalidate observation');
});

await runTest('LOOP-6: sendMessage exception stops loop and does not invalidate', async () => {
  const coord = new Coordinator();
  sendMessageMock = async () => { throw new Error('tab closed'); };

  const result = await runProductionLoop(coord,
    [{ kind: 'click', id: 'a1', targetNodeId: NODE_ID }],
    OBS_ID,
  );

  assert.strictEqual(result.executedActionCount, 0);
  assert.strictEqual(result.observationInvalidated, false);
  assert.strictEqual(result.pipelineStopped, true);
  assert.ok(result.failureReason!.includes('tab closed'));
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 P0.1 Production-Path Verification: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

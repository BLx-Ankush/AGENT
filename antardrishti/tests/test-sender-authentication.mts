/**
 * ANTARDRISHTI — P1-E Sender Authentication Tests
 *
 * Verifies the invariant:
 *
 *   Untrusted content-script / web page content must NEVER
 *   be able to authorize a high-risk action.
 *
 *   The coordinator authenticates the actual Chrome runtime sender,
 *   NOT the claimed envelope.sender field.
 *
 * Run: npx tsx tests/test-sender-authentication.mts
 */

import assert from 'node:assert/strict';

// ── Mock Chrome runtime types ───────────────────────────────

const EXTENSION_ID = 'test-extension-id-abc123';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const ACTIVE_TAB_ID = 42;

// Trusted UI page paths
const TRUSTED_UI_PATHS = ['/popup.html'];

/**
 * Replicate the sender authentication logic from coordinator.ts exactly.
 * This avoids importing the coordinator (which needs Chrome APIs).
 */
function isTrustedExtensionUI(
  sender: { id?: string; url?: string; tab?: { id?: number } } | null | undefined,
  extensionId: string,
): boolean {
  if (!sender || !sender.id || !sender.url) return false;
  if (sender.id !== extensionId) return false;
  // Content scripts have sender.tab — extension UI pages do NOT
  if (sender.tab) return false;
  const extensionOrigin = `chrome-extension://${extensionId}`;
  if (!sender.url.startsWith(extensionOrigin)) return false;
  try {
    const senderPath = new URL(sender.url).pathname;
    if (!TRUSTED_UI_PATHS.includes(senderPath)) return false;
  } catch {
    return false;
  }
  return true;
}

function isTrustedContentScript(
  sender: { id?: string; url?: string; tab?: { id?: number } } | null | undefined,
  extensionId: string,
  activeTabId: number | null,
): boolean {
  if (!sender || !sender.id) return false;
  if (sender.id !== extensionId) return false;
  if (!sender.tab || sender.tab.id === undefined) return false;
  if (sender.tab.id !== activeTabId) return false;
  return true;
}

// ── Sender factories ────────────────────────────────────────

/** Trusted popup sender (extension UI, no tab) */
function trustedPopupSender() {
  return {
    id: EXTENSION_ID,
    url: `${EXTENSION_ORIGIN}/popup.html`,
  };
}

/** Content-script sender from the active session tab */
function trustedContentScriptSender() {
  return {
    id: EXTENSION_ID,
    url: 'https://example.com/page',
    tab: { id: ACTIVE_TAB_ID },
  };
}

/** Content-script sender from a DIFFERENT tab */
function wrongTabContentScriptSender() {
  return {
    id: EXTENSION_ID,
    url: 'https://attacker.com/page',
    tab: { id: 999 },
  };
}

/** Content-script sender trying to spoof confirmation response */
function contentScriptAsPopupSender() {
  return {
    id: EXTENSION_ID,
    url: 'https://example.com/page',
    tab: { id: ACTIVE_TAB_ID },
    // Note: content scripts ALWAYS have sender.tab set by Chrome runtime
  };
}

/** Wrong extension ID */
function wrongExtensionSender() {
  return {
    id: 'other-extension-id',
    url: `chrome-extension://other-extension-id/popup.html`,
  };
}

// ── Confirmation state machine (from P0-A) ──────────────────

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  sessionId: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

const CONFIRMATION_TIMEOUT_MS = 200;

class AuthenticatedConfirmationMachine {
  pendingConfirmations = new Map<string, PendingConfirmation>();
  sessionId: string | null = null;
  activeTabId: number | null = null;
  executedActions: string[] = [];

  requestConfirmation(action: { id: string; kind: string }): Promise<boolean> {
    const actionId = action.id;
    if (!actionId || this.pendingConfirmations.has(actionId) || !this.sessionId) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingConfirmations.has(actionId)) {
          this.pendingConfirmations.delete(actionId);
          resolve(false);
        }
      }, CONFIRMATION_TIMEOUT_MS);
      this.pendingConfirmations.set(actionId, {
        resolve,
        sessionId: this.sessionId!,
        timeoutId,
      });
    });
  }

  /**
   * Handle confirmation response with sender authentication.
   * This mirrors the coordinator's dispatch + handler flow.
   */
  handleConfirmationWithSenderAuth(
    sender: { id?: string; url?: string; tab?: { id?: number } } | null | undefined,
    payload: { actionId: string; approved: boolean },
  ): { ack: boolean; error?: string } {
    // P1-E: Sender authentication gate
    if (!isTrustedExtensionUI(sender, EXTENSION_ID)) {
      return { ack: false, error: 'Untrusted sender' };
    }

    // P0-A: Confirmation resolution
    const pending = this.pendingConfirmations.get(payload.actionId);
    if (!pending) return { ack: true };
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
   * Handle action outcome with sender authentication.
   */
  handleActionOutcomeWithSenderAuth(
    sender: { id?: string; url?: string; tab?: { id?: number } } | null | undefined,
    payload: { actionId: string; success: boolean; outcome: string },
  ): { ack: boolean; error?: string } {
    if (!isTrustedContentScript(sender, EXTENSION_ID, this.activeTabId)) {
      return { ack: false, error: 'Untrusted sender' };
    }
    return { ack: true };
  }

  async executeWithConfirmation(
    action: { id: string; kind: string },
  ): Promise<{ executed: boolean }> {
    const approved = await this.requestConfirmation(action);
    if (!approved) return { executed: false };
    this.executedActions.push(action.id);
    return { executed: true };
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

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔑 ANTARDRISHTI — P1-E Sender Authentication Tests\n');

// ── CONFIRMATION_RESPONSE sender authentication ─────────────

console.log('── CONFIRMATION_RESPONSE Sender Auth ──');

await runTest('SE-01: Valid trusted popup sender can submit CONFIRMATION_RESPONSE', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se01';
  const promise = sm.executeWithConfirmation({ id: 'act-se01', kind: 'type_token' });
  const result = sm.handleConfirmationWithSenderAuth(
    trustedPopupSender(),
    { actionId: 'act-se01', approved: true },
  );
  assert.strictEqual(result.ack, true);
  const outcome = await promise;
  assert.strictEqual(outcome.executed, true, 'Trusted popup must authorize');
  assert.strictEqual(sm.executedActions.length, 1);
});

await runTest('SE-02: Content-script sender attempting CONFIRMATION_RESPONSE is rejected', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se02';
  sm.activeTabId = ACTIVE_TAB_ID;
  const promise = sm.executeWithConfirmation({ id: 'act-se02', kind: 'type_token' });
  const result = sm.handleConfirmationWithSenderAuth(
    contentScriptAsPopupSender(),
    { actionId: 'act-se02', approved: true },
  );
  assert.strictEqual(result.ack, false, 'Content-script sender must be rejected');
  assert.strictEqual(result.error, 'Untrusted sender');
  // Action must NOT have been approved — let it timeout
  const outcome = await promise;
  assert.strictEqual(outcome.executed, false, 'Content-script must NOT authorize');
  assert.strictEqual(sm.executedActions.length, 0);
});

await runTest('SE-03: CONFIRMATION_RESPONSE with wrong extension ID is rejected', async () => {
  const result = isTrustedExtensionUI(wrongExtensionSender(), EXTENSION_ID);
  assert.strictEqual(result, false, 'Wrong extension ID must be rejected');
});

await runTest('SE-04: CONFIRMATION_RESPONSE with missing sender is rejected', async () => {
  assert.strictEqual(isTrustedExtensionUI(null, EXTENSION_ID), false, 'null sender');
  assert.strictEqual(isTrustedExtensionUI(undefined, EXTENSION_ID), false, 'undefined sender');
  assert.strictEqual(isTrustedExtensionUI({}, EXTENSION_ID), false, 'empty sender');
  assert.strictEqual(isTrustedExtensionUI({ id: EXTENSION_ID }, EXTENSION_ID), false, 'missing url');
});

await runTest('SE-05: CONFIRMATION_RESPONSE with wrong extension URL/path is rejected', async () => {
  // Wrong path
  const wrongPath = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/options.html` };
  assert.strictEqual(isTrustedExtensionUI(wrongPath, EXTENSION_ID), false, 'Wrong path');

  // Wrong origin
  const wrongOrigin = { id: EXTENSION_ID, url: 'https://example.com/popup.html' };
  assert.strictEqual(isTrustedExtensionUI(wrongOrigin, EXTENSION_ID), false, 'Wrong origin');

  // Path traversal attempt
  const traversal = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/../../../etc/passwd` };
  assert.strictEqual(isTrustedExtensionUI(traversal, EXTENSION_ID), false, 'Path traversal');
});

await runTest('SE-06: Payload envelope.sender claiming "popup" cannot bypass runtime sender auth', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se06';
  sm.activeTabId = ACTIVE_TAB_ID;
  const promise = sm.executeWithConfirmation({ id: 'act-se06', kind: 'type_token' });

  // Content-script sender with tab — envelope claims "popup" but runtime sender is content-script
  const contentScriptSender = {
    id: EXTENSION_ID,
    url: 'https://example.com/page',
    tab: { id: ACTIVE_TAB_ID },
  };

  const result = sm.handleConfirmationWithSenderAuth(
    contentScriptSender,
    { actionId: 'act-se06', approved: true },
  );
  assert.strictEqual(result.ack, false, 'Envelope sender must NOT bypass runtime auth');
  const outcome = await promise;
  assert.strictEqual(outcome.executed, false);
  assert.strictEqual(sm.executedActions.length, 0);
});

// ── ACTION_OUTCOME sender authentication ────────────────────

console.log('\n── ACTION_OUTCOME Sender Auth ──');

await runTest('SE-07: Valid content-script sender from active session tab can send ACTION_OUTCOME', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se07';
  sm.activeTabId = ACTIVE_TAB_ID;
  const result = sm.handleActionOutcomeWithSenderAuth(
    trustedContentScriptSender(),
    { actionId: 'act-se07', success: true, outcome: 'success' },
  );
  assert.strictEqual(result.ack, true);
});

await runTest('SE-08: ACTION_OUTCOME from another tab is rejected', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se08';
  sm.activeTabId = ACTIVE_TAB_ID;
  const result = sm.handleActionOutcomeWithSenderAuth(
    wrongTabContentScriptSender(),
    { actionId: 'act-se08', success: true, outcome: 'success' },
  );
  assert.strictEqual(result.ack, false, 'Wrong tab must be rejected');
  assert.strictEqual(result.error, 'Untrusted sender');
});

await runTest('SE-09: ACTION_OUTCOME with missing sender.tab is rejected', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se09';
  sm.activeTabId = ACTIVE_TAB_ID;
  // Popup sender has no tab
  const result = sm.handleActionOutcomeWithSenderAuth(
    trustedPopupSender(),
    { actionId: 'act-se09', success: true, outcome: 'success' },
  );
  assert.strictEqual(result.ack, false, 'Missing tab must be rejected');
});

await runTest('SE-10: ACTION_OUTCOME with wrong extension ID is rejected', async () => {
  const result = isTrustedContentScript(
    { id: 'wrong-ext-id', tab: { id: ACTIVE_TAB_ID } },
    EXTENSION_ID,
    ACTIVE_TAB_ID,
  );
  assert.strictEqual(result, false);
});

// ── Malformed/missing sender ────────────────────────────────

console.log('\n── Malformed/Missing Sender ──');

await runTest('SE-11: Malformed/missing runtime sender cannot trigger privileged handling', async () => {
  assert.strictEqual(isTrustedExtensionUI(null, EXTENSION_ID), false, 'null');
  assert.strictEqual(isTrustedExtensionUI(undefined, EXTENSION_ID), false, 'undefined');
  assert.strictEqual(isTrustedContentScript(null, EXTENSION_ID, 42), false, 'null');
  assert.strictEqual(isTrustedContentScript(undefined, EXTENSION_ID, 42), false, 'undefined');
  assert.strictEqual(isTrustedContentScript({ id: EXTENSION_ID }, EXTENSION_ID, 42), false, 'no tab');
  assert.strictEqual(isTrustedContentScript({ id: EXTENSION_ID, tab: {} }, EXTENSION_ID, 42), false, 'no tab.id');
});

// ── Critical: forged confirmation → zero executions ─────────

console.log('\n── CRITICAL: Forged Confirmation → Zero Executions ──');

await runTest('SE-12: Rejected confirmation sender cannot cause execution', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se12';
  sm.activeTabId = ACTIVE_TAB_ID;
  const promise = sm.executeWithConfirmation({ id: 'act-se12', kind: 'type_token' });

  // Content-script forges a CONFIRMATION_RESPONSE with approved: true
  const forgedSender = {
    id: EXTENSION_ID,
    url: 'https://evil.com/inject',
    tab: { id: ACTIVE_TAB_ID },
  };
  const result = sm.handleConfirmationWithSenderAuth(
    forgedSender,
    { actionId: 'act-se12', approved: true },
  );
  assert.strictEqual(result.ack, false);

  // Action must time out — zero executions
  const outcome = await promise;
  assert.strictEqual(outcome.executed, false, 'Forged confirmation must NOT authorize');
  assert.strictEqual(sm.executedActions.length, 0, 'ZERO executions after forgery');
});

// ── Integration: trusted path still works ───────────────────

console.log('\n── Integration: Trusted Path ──');

await runTest('SE-13: Trusted confirmation still works after sender auth is enforced', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se13';
  sm.activeTabId = ACTIVE_TAB_ID;
  const promise = sm.executeWithConfirmation({ id: 'act-se13', kind: 'type_token' });

  // Legitimate popup sender
  const result = sm.handleConfirmationWithSenderAuth(
    trustedPopupSender(),
    { actionId: 'act-se13', approved: true },
  );
  assert.strictEqual(result.ack, true);
  const outcome = await promise;
  assert.strictEqual(outcome.executed, true, 'Trusted path must still work');
  assert.strictEqual(sm.executedActions.length, 1);
});

await runTest('SE-14: Duplicate/stale P0-A confirmation protections remain intact', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se14';
  const promise = sm.executeWithConfirmation({ id: 'act-se14', kind: 'type_token' });

  // First approval
  sm.handleConfirmationWithSenderAuth(
    trustedPopupSender(),
    { actionId: 'act-se14', approved: true },
  );
  const outcome = await promise;
  assert.strictEqual(outcome.executed, true);

  // Duplicate response — must be no-op (pending entry already deleted)
  const dup = sm.handleConfirmationWithSenderAuth(
    trustedPopupSender(),
    { actionId: 'act-se14', approved: true },
  );
  assert.strictEqual(dup.ack, true); // acknowledged but no-op
  assert.strictEqual(sm.executedActions.length, 1, 'No double execution');
});

// ── Content-script receiver validation ──────────────────────

console.log('\n── Content-Script Receiver ──');

await runTest('SE-15: Content-script message receiver validates sender origin', async () => {
  // The content-script uses chrome.runtime.onMessage which Chrome guarantees
  // only delivers messages from the extension runtime (same extension).
  // Web page scripts cannot send messages via chrome.runtime.sendMessage.
  //
  // Verify: the content-script's listener checks isValidMessageEnvelope
  // which validates the protocol-v2 envelope structure.
  // Any message not matching the typed envelope schema is rejected.
  const { isValidMessageEnvelope } = await import('@antardrishti/protocol-v2');

  // Valid envelope (matching createMessage output format)
  const valid = {
    version: '2.0',
    type: 'EXECUTE_ACTION',
    payload: { actionId: 'test', kind: 'click', targetNodeId: 'node-1' },
    sender: 'background',
    timestamp: new Date().toISOString(),
  };
  assert.strictEqual(isValidMessageEnvelope(valid), true, 'Valid envelope accepted');

  // Invalid: missing required fields
  assert.strictEqual(isValidMessageEnvelope({}), false, 'Empty object rejected');
  assert.strictEqual(isValidMessageEnvelope({ type: 'EXECUTE_ACTION' }), false, 'Missing fields rejected');
  assert.strictEqual(isValidMessageEnvelope(null), false, 'null rejected');
  assert.strictEqual(isValidMessageEnvelope('string'), false, 'string rejected');
  assert.strictEqual(isValidMessageEnvelope({ version: '1.0', type: 'X', sender: 'a', timestamp: '2024-01-01', payload: {} }), false, 'Wrong version rejected');
});

// ── Wrong-tab ACTION_OUTCOME ────────────────────────────────

console.log('\n── Wrong-Tab ACTION_OUTCOME ──');

await runTest('SE-16: Wrong-tab ACTION_OUTCOME is rejected and does not advance session state', async () => {
  const sm = new AuthenticatedConfirmationMachine();
  sm.sessionId = 'session-se16';
  sm.activeTabId = ACTIVE_TAB_ID;

  // Attacker tab sends ACTION_OUTCOME
  const attackerSender = {
    id: EXTENSION_ID,
    url: 'https://attacker.com/page',
    tab: { id: 666 },
  };
  const result = sm.handleActionOutcomeWithSenderAuth(
    attackerSender,
    { actionId: 'attacker-action', success: true, outcome: 'navigated' },
  );
  assert.strictEqual(result.ack, false, 'Wrong-tab outcome must be rejected');
  assert.strictEqual(result.error, 'Untrusted sender');
  // Session state must not be affected
  assert.strictEqual(sm.executedActions.length, 0);
});

// ── Summary ─────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
if (failed === 0) {
  console.log(`\n✅ P1-E Sender Authentication: ${passed} passed, ${failed} failed\n`);
} else {
  console.log(`\n❌ FAILED: ${failed} test(s)`);
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
  console.log();
  process.exit(1);
}

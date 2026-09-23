/**
 * ANTARDRISHTI — P0.2a Integration Tests
 *
 * Proves the complete Sanitizer → TokenVault → Coordinator execution path
 * using REAL production implementations.
 *
 * Tests invoke:
 *   - actual Sanitizer (from @antardrishti/privacy)
 *   - actual TokenVault (from @antardrishti/privacy)
 *   - actual Coordinator.executeAction() (via cast)
 *
 * Sensitive values use REAL PII patterns (email, credit card) that
 * the production PII scanner actually detects. Arbitrary strings like
 * "MyPassword" are NOT detected — only pattern-matched PII triggers
 * sanitization.
 *
 * Run: npx tsx tests/test-p02a-integration.mts
 */

import assert from 'node:assert/strict';
import {
  MESSAGE_TYPES,
} from '../packages/protocol-v2/src/messages';
import {
  createTargetFingerprint,
} from '../packages/protocol-v2/src/index';
import type { SceneNode } from '../packages/scene-graph/src/index';
import { TokenVault } from '../packages/privacy/src/token-vault';
import { Sanitizer } from '../packages/privacy/src/sanitizer';

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
  offscreen: undefined,
};

if (typeof performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
}

// ── Import ACTUAL Coordinator (after chrome mock) ───────────

const { Coordinator } = await import('../apps/extension/src/background/coordinator');

// ── Constants ───────────────────────────────────────────────

const TAB_ID = 42;
const FRAME_ID = 0;
const DOC_GEN = 'doc-p02a-001';
const OBS_ID = 'obs-p02a-001';
const ORIGIN = 'https://example.com';
const SESSION_ID = 'sess-p02a-001';
const NODE_ID = 'n-email-field';

// Use an email address as the protected value — the real PII
// scanner detects emails with high confidence. Arbitrary passwords
// are NOT detected by the pattern scanner.
const RAW_PROTECTED_VALUE = 'user.private@secret-corp.com';

const fingerprint = createTargetFingerprint(
  NODE_ID, 'textbox', 'Email', 'html>body>form>input',
  { x: 100, y: 200, w: 200, h: 30 }, FRAME_ID, DOC_GEN, OBS_ID,
);

// ── Helpers ─────────────────────────────────────────────────

function getExecuteAction(coord: InstanceType<typeof Coordinator>) {
  return (coord as any).executeAction.bind(coord);
}

function getVault(coord: InstanceType<typeof Coordinator>): TokenVault {
  return (coord as any).vault;
}

/**
 * Create a SceneNode with a PII-detectable value.
 */
function createSensitiveNode(nodeId: string, rawValue: string): SceneNode {
  return {
    id: nodeId,
    role: 'textbox',
    name: 'Email',
    visibleText: rawValue,
    bbox: { x: 100, y: 200, w: 200, h: 30 },
    affordances: ['type'],
  } as SceneNode;
}

/**
 * Sanitize a node through the REAL Sanitizer and extract the token.
 * Uses the Coordinator's own vault so the token is redeemable.
 */
function sanitizeAndGetToken(
  vault: TokenVault,
  nodeId: string,
  rawValue: string,
): string {
  const sanitizer = new Sanitizer(vault);
  const node = createSensitiveNode(nodeId, rawValue);

  const result = sanitizer.sanitize(
    'Please fill in the form',
    [node],
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN,
  );

  const pNode = result.scene.nodes.find(n => n.id === nodeId);
  const tokenValue = pNode?.value;
  assert.ok(tokenValue, 'Sanitized node must have a token value');
  assert.ok(tokenValue!.startsWith('<SENSITIVE_'), `Token must be opaque, got: ${tokenValue}`);

  return tokenValue!;
}

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔒 ANTARDRISHTI — P0.2a Sanitizer→Vault→Coordinator Integration\n');

// ── SUCCESS PATH ──

console.log('── Success: real protected value reaches intended target ──');

await runTest('SUCCESS: sanitized email → type_token → vault redeem → delivery', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  // Verify the raw value is NOT in the token
  assert.ok(!token.includes(RAW_PROTECTED_VALUE), 'Raw value must NOT appear in token');

  // Verify the grant binds to the correct target
  const grant = vault.getGrant(token);
  assert.ok(grant, 'Grant must exist');
  assert.strictEqual(grant!.targetRef, NODE_ID, 'targetRef must be the authoritative node ID');
  assert.strictEqual(grant!.permittedOperation, 'type_token', 'permittedOperation must be type_token');
  assert.strictEqual(grant!.tabId, TAB_ID);
  assert.strictEqual(grant!.frameId, FRAME_ID);
  assert.strictEqual(grant!.documentGeneration, DOC_GEN);
  assert.strictEqual(grant!.targetOrigin, ORIGIN);

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
  assert.strictEqual(deliveredValue, RAW_PROTECTED_VALUE,
    'Raw protected value must be delivered locally to the DOM');
});

// ── WRONG TARGET ──

console.log('── Wrong target ──');

await runTest('WRONG-TARGET: type_token on different node → TARGET_MISMATCH', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a2', targetNodeId: 'n-OTHER-FIELD', token },
    DOC_GEN, ORIGIN, fingerprint,
  );

  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('TARGET_MISMATCH'));
});

// ── REPLAY ──

console.log('── Replay ──');

await runTest('REPLAY: second redemption → GRANT_ALREADY_CONSUMED', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    if (msg.type === MESSAGE_TYPES.DELIVER_TOKEN_VALUE) return { success: true };
    return { success: true };
  };

  const r1 = await exec(TAB_ID,
    { kind: 'type_token', id: 'a3', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.deepStrictEqual(r1, { executed: true });

  const r2 = await exec(TAB_ID,
    { kind: 'type_token', id: 'a4', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(r2.executed, false);
  assert.ok(!r2.executed && r2.reason.includes('GRANT_ALREADY_CONSUMED'));
});

// ── STALE DOCUMENT ──

console.log('── Stale document ──');

await runTest('STALE-DOC: wrong documentGeneration → DOCUMENT_GENERATION_MISMATCH', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a5', targetNodeId: NODE_ID, token },
    'doc-STALE-OLD', ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('DOCUMENT_GENERATION_MISMATCH'));
});

// ── WRONG ORIGIN ──

console.log('── Wrong origin ──');

await runTest('WRONG-ORIGIN: different origin → ORIGIN_MISMATCH', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a6', targetNodeId: NODE_ID, token },
    DOC_GEN, 'https://evil.com', fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('ORIGIN_MISMATCH'));
});

// ── WRONG TAB ──

console.log('── Wrong tab ──');

await runTest('WRONG-TAB: vault grant binds to tab 42, redeem from tab 99 → TAB_MISMATCH', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'tabtest@example.com', 'email',
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );
  const grant = vault.getGrant(token)!;

  const result = vault.redeem(
    token, grant.sessionId, 99, grant.frameId,
    DOC_GEN, ORIGIN, NODE_ID, 'type_token', grant.actionNonce,
  );
  assert.ok('error' in result && result.error === 'TAB_MISMATCH');
});

// ── WRONG FRAME ──

console.log('── Wrong frame ──');

await runTest('WRONG-FRAME: vault grant binds to frame 0, redeem from frame 5 → FRAME_MISMATCH', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'frametest@example.com', 'email',
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );
  const grant = vault.getGrant(token)!;

  const result = vault.redeem(
    token, grant.sessionId, grant.tabId, 5,
    DOC_GEN, ORIGIN, NODE_ID, 'type_token', grant.actionNonce,
  );
  assert.ok('error' in result && result.error === 'FRAME_MISMATCH');
});

// ── WRONG OPERATION ──

console.log('── Wrong operation ──');

await runTest('WRONG-OP: capability for type_token redeemed as click → OPERATION_MISMATCH', () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  const grant = vault.getGrant(token)!;
  assert.strictEqual(grant.permittedOperation, 'type_token');

  const result = vault.redeem(
    token, grant.sessionId, grant.tabId, grant.frameId,
    DOC_GEN, ORIGIN, NODE_ID, 'click', grant.actionNonce,
  );
  assert.ok('error' in result && result.error === 'OPERATION_MISMATCH',
    'Capability authorized for type_token must not redeem through click');
});

await runTest('WRONG-OP-E2E: Coordinator.redeemTokenForAction with wrong actionKind → OPERATION_MISMATCH', () => {
  const coord = new Coordinator();
  const vault = getVault(coord);

  const { token } = vault.storeValue(
    'optest@example.com', 'email',
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );

  // Invoke the REAL redeemTokenForAction with wrong operation
  const redeemFn = (coord as any).redeemTokenForAction.bind(coord);
  const result = redeemFn(token, NODE_ID, DOC_GEN, ORIGIN, 'click');
  assert.ok('error' in result && result.error === 'OPERATION_MISMATCH',
    'Coordinator must independently verify operation kind');
});

await runTest('WRONG-OP-REVERSE: capability for click cannot redeem through type_token', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'reverse@example.com', 'email',
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN, NODE_ID, 'click',
  );
  const grant = vault.getGrant(token)!;

  const result = vault.redeem(
    token, grant.sessionId, grant.tabId, grant.frameId,
    DOC_GEN, ORIGIN, NODE_ID, 'type_token', grant.actionNonce,
  );
  assert.ok('error' in result && result.error === 'OPERATION_MISMATCH');
});

// ── EXPIRED CAPABILITY ──

console.log('── Expired ──');

await runTest('EXPIRED: manually expired grant → GRANT_EXPIRED', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'expired@example.com', 'email',
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN, NODE_ID, 'type_token',
  );

  const grant = vault.getGrant(token)!;
  grant.expiresAt = new Date(Date.now() - 1000).toISOString();

  const result = vault.redeem(
    token, grant.sessionId, grant.tabId, grant.frameId,
    DOC_GEN, ORIGIN, NODE_ID, 'type_token', grant.actionNonce,
  );
  assert.ok('error' in result && result.error === 'GRANT_EXPIRED');
});

// ── MALFORMED TOKEN ──

console.log('── Malformed token ──');

await runTest('MALFORMED: nonexistent token → GRANT_NOT_FOUND', async () => {
  const coord = new Coordinator();
  const exec = getExecuteAction(coord);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a7', targetNodeId: NODE_ID, token: '<SENSITIVE_FAKE_99999>' },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('GRANT_NOT_FOUND'));
});

// ── TOCTOU FAILURE ──

console.log('── TOCTOU ──');

await runTest('TOCTOU: failure → no redemption → no delivery → executed:false', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) {
      return { toctouPassed: false, error: 'target removed from DOM' };
    }
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a8', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('TOCTOU'));

  const grant = vault.getGrant(token)!;
  assert.strictEqual(grant.consumedAt, null, 'Grant must NOT be consumed after TOCTOU failure');
});

// ── DELIVERY FAILURE ──

console.log('── Delivery failure ──');

await runTest('DELIVERY-FAIL: token delivery fails → executed:false', async () => {
  const coord = new Coordinator();
  const vault = getVault(coord);
  const exec = getExecuteAction(coord);

  const token = sanitizeAndGetToken(vault, NODE_ID, RAW_PROTECTED_VALUE);

  sendMessageMock = async (_tabId: number, msg: any) => {
    if (msg.type === MESSAGE_TYPES.EXECUTE_ACTION) return { toctouPassed: true };
    if (msg.type === MESSAGE_TYPES.DELIVER_TOKEN_VALUE) {
      return { success: false, error: 'input element removed' };
    }
    return { success: true };
  };

  const result = await exec(TAB_ID,
    { kind: 'type_token', id: 'a9', targetNodeId: NODE_ID, token },
    DOC_GEN, ORIGIN, fingerprint,
  );
  assert.strictEqual(result.executed, false);
  assert.ok(!result.executed && result.reason.includes('input element removed'));
});

// ── PRIVACY ──

console.log('── Privacy ──');

await runTest('PRIVACY: raw value does not appear in sanitized output', () => {
  const vault = new TokenVault();
  const sanitizer = new Sanitizer(vault);
  const raw = 'secret.email@private.org';

  const node = createSensitiveNode('n-priv', raw);
  const result = sanitizer.sanitize(
    'Fill in the form', [node],
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN,
  );

  const outputStr = JSON.stringify(result);
  assert.ok(!outputStr.includes(raw),
    'Raw protected value must not appear in sanitized planner output');

  const pNode = result.scene.nodes.find(n => n.id === 'n-priv');
  assert.ok(pNode?.value?.startsWith('<SENSITIVE_'),
    'Node value must be an opaque token');
  assert.ok(result.redactions.length > 0, 'Must have redaction declarations');
});

await runTest('PRIVACY: raw value exists only in vault, not in grant metadata', () => {
  const vault = new TokenVault();
  const sanitizer = new Sanitizer(vault);
  const raw = 'vault.only@private.org';

  const node = createSensitiveNode('n-priv2', raw);
  sanitizer.sanitize(
    'Enter email', [node],
    SESSION_ID, TAB_ID, FRAME_ID, DOC_GEN, ORIGIN,
  );

  for (const [, grant] of (vault as any).grants) {
    const grantStr = JSON.stringify(grant);
    assert.ok(!grantStr.includes(raw),
      'Raw protected value must not appear in CapabilityGrant metadata');
  }
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 P0.2a Integration: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

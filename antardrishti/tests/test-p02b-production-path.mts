/**
 * ANTARDRISHTI — P0.2b Production-Path Evidence Tests
 *
 * Proves that the ACTUAL Coordinator.buildTargetContext() method
 * constructs targetContext from authoritative harvest nodes, and
 * that this local context flows through validateAction →
 * requiresConfirmation.
 *
 * Uses:
 *   - REAL Coordinator instance (via test-cast to access private method)
 *   - REAL classifyTargetRisk (invoked inside Coordinator.buildTargetContext)
 *   - REAL validateAction + requiresConfirmation (production action-validator)
 *
 * Does NOT recreate the targetContext map construction in the test.
 *
 * Run: npx tsx tests/test-p02b-production-path.mts
 */

import assert from 'node:assert/strict';
import {
  requiresConfirmation,
  isHighRiskTarget,
  createTargetFingerprint,
  type TargetRiskContext,
  type AgentAction,
} from '../packages/protocol-v2/src/index';
import { validateAction, type SceneContext } from '../packages/planner/src/action-validator';

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

(globalThis as any).chrome = {
  tabs: {
    sendMessage: async () => ({ success: true }),
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
    session: { get: async () => ({}), set: async () => {} },
  },
  offscreen: undefined,
};

if (typeof performance === 'undefined') {
  (globalThis as any).performance = { now: () => Date.now() };
}

// Suppress ONNX model loading in Node.js
process.on('unhandledRejection', (err: any) => {
  if (err?.message?.includes('ONNX') || err?.message?.includes('fetch failed')) return;
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

// ── Import Coordinator (after mocks) ────────────────────────

const { Coordinator } = await import('../apps/extension/src/background/coordinator');

// ── Constants ───────────────────────────────────────────────

const DOC_GEN = 'doc-prod-001';
const OBS_ID = 'obs-prod-001';

function makeFingerprint(nodeId: string) {
  return createTargetFingerprint(
    nodeId, 'button', 'test', 'html>body>div>button',
    { x: 100, y: 200, w: 200, h: 30 }, 0, DOC_GEN, OBS_ID,
  );
}

function makeSceneContextFromTargetContext(
  nodeIds: string[],
  targetContext: Map<string, TargetRiskContext>,
): SceneContext {
  const fps = new Map();
  for (const id of nodeIds) fps.set(id, makeFingerprint(id));
  return {
    nodeIds: new Set(nodeIds),
    freshness: {
      sessionId: 'sess-1', tabId: 42, frameId: 0,
      documentGeneration: DOC_GEN, viewportFingerprint: '1920x1080',
      observationId: OBS_ID, origin: 'https://example.com',
      createdAt: new Date().toISOString(),
    },
    targetFingerprints: fps,
    planObservationId: OBS_ID,
    tokenValidator: () => true,
    targetContext,
  };
}

// ── Access the ACTUAL Coordinator method ─────────────────────

const coord = new Coordinator();
const buildTargetContext = (coord as any).buildTargetContext.bind(coord);

// Verify the method exists and is a function
assert.strictEqual(typeof buildTargetContext, 'function',
  'Coordinator.buildTargetContext must be a callable method');

// ──────────────────────────────────────────────────────────────
console.log('\n🔒 ANTARDRISHTI — P0.2b Production-Path Evidence\n');
console.log('── Coordinator.buildTargetContext → validateAction → requiresConfirmation ──');

// ── TEST 1: Payment ──────────────────────────────────────────

await runTest('PROD-1 — Payment: authoritative "Pay Now" node → isPayment + confirmation', () => {
  // Authoritative harvest node — this is what the content script returns
  const harvestNodes = [
    { id: 'n-pay', role: 'button', name: 'Pay Now', visibleText: 'Pay Now',
      tag: 'button', inputType: '', affordances: ['click'] },
  ];

  // Invoke the ACTUAL Coordinator production method
  const targetCtx: Map<string, TargetRiskContext> = buildTargetContext(harvestNodes);

  // Verify Coordinator built the map correctly
  assert.ok(targetCtx.has('n-pay'), 'Coordinator must classify "Pay Now" node');
  assert.strictEqual(targetCtx.get('n-pay')!.isPayment, true,
    'Coordinator must set isPayment=true for "Pay Now"');

  // Feed into REAL validateAction
  const sceneCtx = makeSceneContextFromTargetContext(['n-pay'], targetCtx);
  const action: AgentAction = { kind: 'click', id: 'a-pay', targetNodeId: 'n-pay' };
  const result = validateAction(action, sceneCtx);

  assert.ok(result.valid, 'Action must be valid');
  assert.strictEqual(result.requiresConfirmation, true,
    'Payment click must require confirmation through production path');
});

// ── TEST 2: Destructive ──────────────────────────────────────

await runTest('PROD-2 — Destructive: authoritative "Delete" node → isDestructive + confirmation', () => {
  const harvestNodes = [
    { id: 'n-del', role: 'button', name: 'Delete', visibleText: 'Delete',
      tag: 'button', inputType: '', affordances: ['click'] },
  ];

  const targetCtx: Map<string, TargetRiskContext> = buildTargetContext(harvestNodes);

  assert.ok(targetCtx.has('n-del'), 'Coordinator must classify "Delete" node');
  assert.strictEqual(targetCtx.get('n-del')!.isDestructive, true,
    'Coordinator must set isDestructive=true for "Delete"');

  const sceneCtx = makeSceneContextFromTargetContext(['n-del'], targetCtx);
  const action: AgentAction = { kind: 'click', id: 'a-del', targetNodeId: 'n-del' };
  const result = validateAction(action, sceneCtx);

  assert.ok(result.valid);
  assert.strictEqual(result.requiresConfirmation, true,
    'Destructive click must require confirmation through production path');
});

// ── TEST 3: Upload ───────────────────────────────────────────

await runTest('PROD-3 — Upload: authoritative inputType=file → isUpload + confirmation', () => {
  const harvestNodes = [
    { id: 'n-upload', role: 'textbox', name: 'Choose file', visibleText: '',
      tag: 'input', inputType: 'file', affordances: ['click'] },
  ];

  const targetCtx: Map<string, TargetRiskContext> = buildTargetContext(harvestNodes);

  assert.ok(targetCtx.has('n-upload'), 'Coordinator must classify file input');
  assert.strictEqual(targetCtx.get('n-upload')!.isUpload, true,
    'Coordinator must set isUpload=true for inputType=file');

  const sceneCtx = makeSceneContextFromTargetContext(['n-upload'], targetCtx);
  const action: AgentAction = { kind: 'click', id: 'a-upload', targetNodeId: 'n-upload' };
  const result = validateAction(action, sceneCtx);

  assert.ok(result.valid);
  assert.strictEqual(result.requiresConfirmation, true,
    'Upload click must require confirmation through production path');
});

// ── TEST 4: Safe ─────────────────────────────────────────────

await runTest('PROD-4 — Safe: authoritative "Next" node → no risk flags, no confirmation', () => {
  const harvestNodes = [
    { id: 'n-safe', role: 'button', name: 'Next', visibleText: 'Next',
      tag: 'button', inputType: '', affordances: ['click'] },
  ];

  const targetCtx: Map<string, TargetRiskContext> = buildTargetContext(harvestNodes);

  // Safe nodes should NOT be in the targetContext map at all
  // (Coordinator only adds nodes with at least one risk flag)
  assert.strictEqual(targetCtx.has('n-safe'), false,
    'Coordinator must NOT add safe nodes to targetContext');

  const sceneCtx = makeSceneContextFromTargetContext(['n-safe'], targetCtx);
  const action: AgentAction = { kind: 'click', id: 'a-safe', targetNodeId: 'n-safe' };
  const result = validateAction(action, sceneCtx);

  assert.ok(result.valid);
  assert.strictEqual(result.requiresConfirmation, false,
    'Safe click must NOT require confirmation');
});

// ── TEST 5: Planner independence ─────────────────────────────

await runTest('PROD-5 — Planner independence: planner has NO risk field, local classifies payment', () => {
  // Mixed harvest: one risky, one safe
  const harvestNodes = [
    { id: 'n-checkout', role: 'button', name: 'Checkout', visibleText: 'Checkout',
      tag: 'button', inputType: '', affordances: ['click'] },
    { id: 'n-home', role: 'link', name: 'Home', visibleText: 'Home',
      tag: 'a', inputType: '', affordances: ['click'] },
  ];

  const targetCtx: Map<string, TargetRiskContext> = buildTargetContext(harvestNodes);

  // Coordinator must classify checkout as payment
  assert.ok(targetCtx.has('n-checkout'));
  assert.strictEqual(targetCtx.get('n-checkout')!.isPayment, true);

  // Coordinator must NOT classify home as risky
  assert.strictEqual(targetCtx.has('n-home'), false);

  // Planner action has ZERO risk information — just a plain click proposal
  const sceneCtx = makeSceneContextFromTargetContext(['n-checkout', 'n-home'], targetCtx);

  const riskyAction: AgentAction = { kind: 'click', id: 'a-ck', targetNodeId: 'n-checkout' };
  const riskyResult = validateAction(riskyAction, sceneCtx);
  assert.strictEqual(riskyResult.requiresConfirmation, true,
    'Local payment classification must require confirmation even though planner says nothing');

  const safeAction: AgentAction = { kind: 'click', id: 'a-hm', targetNodeId: 'n-home' };
  const safeResult = validateAction(safeAction, sceneCtx);
  assert.strictEqual(safeResult.requiresConfirmation, false,
    'Safe action must not require confirmation');
});

// ── TEST 6: Multi-node batch ─────────────────────────────────

await runTest('PROD-6 — Multi-node: Coordinator classifies mixed batch correctly', () => {
  const harvestNodes = [
    { id: 'n1', role: 'button', name: 'Submit', tag: 'button', inputType: 'submit' },
    { id: 'n2', role: 'button', name: 'Pay Now', tag: 'button' },
    { id: 'n3', role: 'button', name: 'Send', tag: 'div', visibleText: 'Send' },
    { id: 'n4', role: 'button', name: 'Cancel', tag: 'button' },
    { id: 'n5', role: 'link', name: 'Back', tag: 'a' },
  ];

  const targetCtx: Map<string, TargetRiskContext> = buildTargetContext(harvestNodes);

  // Risky: n1 (submit), n2 (payment), n3 (send)
  assert.strictEqual(targetCtx.has('n1'), true, 'Submit must be classified');
  assert.strictEqual(targetCtx.get('n1')!.isSubmit, true);

  assert.strictEqual(targetCtx.has('n2'), true, 'Payment must be classified');
  assert.strictEqual(targetCtx.get('n2')!.isPayment, true);

  assert.strictEqual(targetCtx.has('n3'), true, 'Send must be classified');
  assert.strictEqual(targetCtx.get('n3')!.isSend, true);

  // Safe: n4 (Cancel), n5 (Back)
  assert.strictEqual(targetCtx.has('n4'), false, 'Cancel must NOT be classified as risky');
  assert.strictEqual(targetCtx.has('n5'), false, 'Back must NOT be classified as risky');

  // Total risky nodes: exactly 3
  assert.strictEqual(targetCtx.size, 3, 'Exactly 3 risky nodes expected');
});

// ── Summary ─────────────────────────────────────────────────

console.log(`\n🔒 P0.2b Production-Path Evidence: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

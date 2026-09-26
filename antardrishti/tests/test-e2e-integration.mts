/**
 * ANTARDRISHTI — End-to-End Integration Simulation Test
 *
 * Simulates the full coordinator pipeline (steps 5-8) using real production code:
 *   1. Sanitize a real page scene
 *   2. Build wire-level planner request
 *   3. Run egress verification (field-aware)
 *   4. POST to local planner server (if running)
 *   5. Validate planner response schema
 *
 * Run: npx tsx tests/test-e2e-integration.mts
 */

import assert from 'node:assert/strict';
import { TokenVault, Sanitizer } from '../packages/privacy/src/index';
import { PlannerRequestSchema, PlannerResponseSchema } from '../packages/protocol-v2/src/schemas';
import { EgressVerifier } from '../packages/egress-verifier/src/verifier';

let passed = 0, failed = 0;
const failures: string[] = [];
async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e: any) { const m = e.message ?? String(e); console.log(`  ❌ ${name}: ${m}`); failed++; failures.push(`${name}: ${m}`); }
}

console.log('\n🔬 ANTARDRISHTI — End-to-End Integration Test\n');

const SESSION = 'session-' + Date.now();
const TAB = 1;
const FRAME = 0;
const DOC_GEN = 'gen-' + Date.now();
const ORIGIN = 'https://sih.gov.in';

// Simulate a realistic SIH page harvest
function makeNode(id: string, name: string, opts: any = {}) {
  return {
    id,
    role: opts.role || 'text',
    name,
    value: opts.value,
    actionability: opts.actionability || 'readable',
    source: opts.source || ['dom'],
    bbox: opts.bbox || { x: 0, y: 0, w: 100, h: 30 },
    state: opts.state,
  };
}

const nodes = [
  makeNode('n-home', 'Home', { role: 'link', actionability: 'clickable' }),
  makeNode('n-about', 'ABOUT SIH', { role: 'link', actionability: 'clickable' }),
  makeNode('n-timeline', 'Timeline', { role: 'link', actionability: 'clickable' }),
  makeNode('n-problems', 'Problem Statements', { role: 'link', actionability: 'clickable' }),
  makeNode('n-heading', 'Smart India Hackathon 2026', { role: 'heading' }),
  makeNode('n-desc', 'A nationwide initiative to provide students platforms to solve pressing problems.'),
  makeNode('n-btn', 'Register Now', { role: 'button', actionability: 'clickable' }),
  makeNode('n-footer', '© 2026 MoE Innovation Cell'),
];

const vault = new TokenVault();
const sanitizer = new Sanitizer(vault);
const result = sanitizer.sanitize(
  'Click the ABOUT SIH menu', nodes, SESSION, TAB, FRAME, DOC_GEN, ORIGIN,
);

// Build wire-level request
const plannerRequest = {
  protocolVersion: '2.0' as const,
  session: {
    id: SESSION, step: 0,
    observationId: `obs-${Date.now()}`,
    origin: ORIGIN,
    documentGeneration: DOC_GEN,
    viewport: { width: 1920, height: 1080, devicePixelRatio: 2 },
  },
  task: {
    sanitized: result.sanitizedTask,
    risk: result.risk,
  },
  scene: result.scene,
  redactions: result.redactions,
  allowedActions: ['click', 'focus', 'type_text', 'type_token', 'select', 'scroll', 'wait', 'request_observation', 'finish'] as const,
};

console.log('── Step 5: Sanitization ──');

await runTest('SANITIZE-1 — task sanitized', () => {
  assert.ok(result.sanitizedTask.length > 0);
  console.log(`    Task: "${result.sanitizedTask}"`);
});

await runTest('SANITIZE-2 — scene has nodes', () => {
  assert.ok(result.scene.nodes.length >= 5, `Expected ≥5 nodes, got ${result.scene.nodes.length}`);
});

await runTest('SANITIZE-3 — schema validates', () => {
  const parsed = PlannerRequestSchema.safeParse(plannerRequest);
  assert.ok(parsed.success, `Schema fail: ${parsed.success ? 'ok' : parsed.error?.message}`);
});

console.log('── Step 7: Egress Verification ──');

await runTest('EGRESS-4 — verifier approves sanitized payload', async () => {
  const verifier = new EgressVerifier();
  const verdict = await verifier.verify(plannerRequest, 'http://localhost:8000');
  console.log(`    Verdict: approved=${verdict.approved}`);
  if (!verdict.approved) {
    const block = verdict as any;
    console.log(`    Reason: ${block.reason}`);
    console.log(`    Category: ${block.category}`);
    console.log(`    Details: ${block.details}`);
  }
  assert.ok(verdict.approved, `Egress must approve — got: ${(verdict as any).reason}`);
});

console.log('── Step 8: Planner Server ──');

// Try to reach the planner server
let serverReachable = false;
try {
  const healthResp = await fetch('http://localhost:8000/v1/health', { signal: AbortSignal.timeout(3000) });
  if (healthResp.ok) {
    const health = await healthResp.json();
    console.log(`    Server health: ${JSON.stringify(health)}`);
    serverReachable = true;
  }
} catch {
  console.log('    ⚠ Planner server not running on localhost:8000');
}

if (serverReachable) {
  await runTest('PLANNER-5 — POST /v1/plan receives response', async () => {
    const resp = await fetch('http://localhost:8000/v1/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plannerRequest),
      signal: AbortSignal.timeout(30000),
    });
    console.log(`    Response status: ${resp.status}`);
    const body = await resp.json();
    console.log(`    Response keys: ${Object.keys(body).join(', ')}`);

    if (resp.ok) {
      // Validate against PlannerResponseSchema
      const parsed = PlannerResponseSchema.safeParse(body);
      console.log(`    Schema valid: ${parsed.success}`);
      if (parsed.success) {
        console.log(`    Plan ID: ${parsed.data.planId}`);
        console.log(`    Actions: ${parsed.data.actions.length}`);
        for (const a of parsed.data.actions) {
          console.log(`      - ${a.kind} → ${a.targetNodeId || '(none)'}`);
        }
      } else {
        console.log(`    Schema errors: ${parsed.error.issues.map(i => i.message).join('; ')}`);
      }
      assert.ok(parsed.success, `PlannerResponseSchema must validate`);
    } else {
      // LLM might fail (no API key, etc) — record but don't crash test
      console.log(`    Server error: ${JSON.stringify(body)}`);
      assert.fail(`Server returned ${resp.status}: ${JSON.stringify(body)}`);
    }
  });

  // Check health again
  await runTest('PLANNER-6 — requestsServed incremented', async () => {
    const resp = await fetch('http://localhost:8000/v1/health');
    const health = await resp.json();
    console.log(`    requestsServed: ${health.requestsServed}`);
    assert.ok(health.requestsServed >= 1, `Expected ≥1, got ${health.requestsServed}`);
  });
} else {
  console.log('    ⚠ Skipping planner tests (server not running)');
  console.log('    Start server: python server.py --adapter=llm --port=8000');
}

// ── Summary ──
console.log(`\n🔬 E2E Integration: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

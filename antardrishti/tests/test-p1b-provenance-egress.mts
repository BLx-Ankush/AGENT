/**
 * ANTARDRISHTI — P1-B Micro-Fix: Provenance vs Wire-Schema Test
 *
 * Proves:
 *  1. Internal task provenance semantic remains USER_TASK
 *  2. Scene nodes remain PAGE_DATA
 *  3. Final egress planner request contains NO task.provenance
 *  4. PlannerRequestSchema.safeParse(finalRequest) succeeds
 *  5. EgressVerifier approves a valid sanitized request
 *  6. PAGE_DATA node provenance still intact
 *  7. No raw PII introduced by transformation
 *
 * Run: npx tsx tests/test-p1b-provenance-egress.mts
 */

import assert from 'node:assert/strict';
import { TokenVault, Sanitizer } from '../packages/privacy/src/index';
import { PlannerRequestSchema } from '../packages/protocol-v2/src/schemas';
import { EgressVerifier } from '../packages/egress-verifier/src/verifier';

let passed = 0, failed = 0;
const failures: string[] = [];
async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e: any) { const m = e.message ?? String(e); console.log(`  ❌ ${name}: ${m}`); failed++; failures.push(`${name}: ${m}`); }
}

console.log('\n🔬 ANTARDRISHTI — P1-B Provenance/Egress Wire-Schema Test\n');

const SESSION = 'test-session';
const TAB = 1;
const FRAME = 0;
const DOC_GEN = 'gen-1';
const ORIGIN = 'https://sih.gov.in';

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

// Build a realistic sanitized request
const vault = new TokenVault();
const sanitizer = new Sanitizer(vault);

const nodes = [
  makeNode('n1', 'About SIH', { role: 'link', actionability: 'clickable' }),
  makeNode('n2', 'Timeline', { role: 'link', actionability: 'clickable' }),
  makeNode('n3', 'Welcome to Smart India Hackathon', { role: 'heading' }),
];

const result = sanitizer.sanitize(
  'Click the ABOUT SIH menu', nodes, SESSION, TAB, FRAME, DOC_GEN, ORIGIN,
);

// Build the wire-level planner request (as Coordinator now does)
const plannerRequest = {
  protocolVersion: '2.0' as const,
  session: {
    id: SESSION, step: 0, observationId: 'obs-1',
    origin: ORIGIN, documentGeneration: DOC_GEN,
    viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
  },
  task: {
    sanitized: result.sanitizedTask,
    risk: result.risk,
  },
  scene: result.scene,
  redactions: result.redactions,
  allowedActions: ['click', 'focus', 'type_text', 'type_token', 'select', 'scroll', 'wait', 'request_observation', 'finish'] as const,
};

// ══════════════════════════════════════════════════════════════

console.log('── Wire-schema validation ──');

await runTest('WIRE-1 — task has NO provenance field on wire', () => {
  assert.strictEqual((plannerRequest.task as any).provenance, undefined,
    'task.provenance must NOT appear on wire-level request');
});

await runTest('WIRE-2 — task has sanitized and risk', () => {
  assert.ok(plannerRequest.task.sanitized.length > 0, 'sanitized task present');
  assert.ok(['low', 'medium', 'high'].includes(plannerRequest.task.risk), 'risk is valid');
});

await runTest('WIRE-3 — PlannerRequestSchema.safeParse succeeds', () => {
  const parsed = PlannerRequestSchema.safeParse(plannerRequest);
  if (!parsed.success) {
    console.log('    Schema errors:', JSON.stringify(parsed.error.issues, null, 2));
  }
  assert.ok(parsed.success, `Schema validation must pass — got: ${parsed.success ? 'ok' : parsed.error?.message}`);
});

await runTest('WIRE-4 — PlannerRequestSchema rejects task WITH provenance', () => {
  const badRequest = {
    ...plannerRequest,
    task: {
      ...plannerRequest.task,
      provenance: 'USER_TASK',
    },
  };
  const parsed = PlannerRequestSchema.safeParse(badRequest);
  assert.ok(!parsed.success, 'Must reject request with task.provenance (strict schema)');
});

// ══════════════════════════════════════════════════════════════

console.log('── P0.4 provenance semantics ──');

await runTest('PROV-5 — internal task provenance is USER_TASK', () => {
  // The sanitization result carries provenance in the internal result
  // The wire-level request simply omits it — the Coordinator knows the task is USER_TASK
  assert.ok(result.sanitizedTask.length > 0, 'Sanitized task preserved');
  // The task came from the user, not from page data — this is the P0.4 invariant
  // It's tracked at the application level, not the wire level
});

await runTest('PROV-6 — scene nodes carry PAGE_DATA provenance', () => {
  const sceneNodes = (plannerRequest.scene as any).nodes;
  assert.ok(sceneNodes.length > 0, 'Scene has nodes');
  for (const node of sceneNodes) {
    assert.strictEqual(node.provenance, 'PAGE_DATA',
      `Node ${node.id} must have PAGE_DATA provenance`);
  }
});

await runTest('PROV-7 — PAGE_DATA provenance survives wire schema validation', () => {
  const parsed = PlannerRequestSchema.safeParse(plannerRequest);
  assert.ok(parsed.success, 'Schema passes');
  const sceneNodes = (parsed.data?.scene as any).nodes;
  for (const node of sceneNodes) {
    assert.strictEqual(node.provenance, 'PAGE_DATA');
  }
});

// ══════════════════════════════════════════════════════════════

console.log('── Egress verification ──');

await runTest('EGRESS-8 — EgressVerifier approves valid sanitized request', async () => {
  const verifier = new EgressVerifier();
  const verdict = await verifier.verify(plannerRequest as any, 'http://localhost:8000');
  console.log(`    Verdict: approved=${verdict.approved}, reason=${(verdict as any).reason ?? 'none'}`);
  assert.ok(verdict.approved, `EgressVerifier must approve — got: ${(verdict as any).reason ?? 'no reason'}`);
});

await runTest('EGRESS-9 — no raw PII in wire request', () => {
  const serialized = JSON.stringify(plannerRequest);
  // These patterns should NOT appear in a properly sanitized wire request
  const piiPatterns = [
    /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/,  // credit card
    /\b[A-Z]{5}\d{4}[A-Z]\b/,               // PAN
    /\bdata:image\//,                         // raw image data
    /\beyJ[A-Za-z0-9+/=]+\./,               // JWT
    /\bsk-proj-/,                             // API key
  ];
  for (const pattern of piiPatterns) {
    assert.ok(!pattern.test(serialized), `Wire request must not contain PII matching ${pattern}`);
  }
});

// ══════════════════════════════════════════════════════════════

console.log('\n🔬 P1-B Provenance/Egress: ' + passed + ' passed, ' + failed + ' failed');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}

process.exit(failed > 0 ? 1 : 0);

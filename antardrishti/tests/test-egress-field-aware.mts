/**
 * ANTARDRISHTI — Egress Field-Aware PII Verification Test
 *
 * Proves the field-aware egress verifier:
 *  1. Real phone in scene text → BLOCK
 *  2. Real email in scene text → BLOCK
 *  3. Real credential in task → BLOCK
 *  4. Real account number → BLOCK
 *  5. Sensitive token <SENSITIVE_...> → allowed
 *  6. Numeric observation ID → allowed (not false-positive phone)
 *  7. Numeric bbox → allowed
 *  8. Normal button label → allowed
 *  9. Scene with many numeric IDs → approved
 *
 * Run: npx tsx tests/test-egress-field-aware.mts
 */

import assert from 'node:assert/strict';
import { EgressVerifier } from '../packages/egress-verifier/src/verifier';
import { PlannerRequestSchema } from '../packages/protocol-v2/src/schemas';

let passed = 0, failed = 0;
const failures: string[] = [];
async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e: any) { const m = e.message ?? String(e); console.log(`  FAIL ${name}: ${m}`); failed++; failures.push(`${name}: ${m}`); }
}

console.log('\n[EGRESS] ANTARDRISHTI -- Field-Aware Egress Verifier Test\n');

const verifier = new EgressVerifier();

function makeRequest(overrides: any = {}): any {
  return {
    protocolVersion: '2.0',
    session: {
      id: 'session-8741928347123',
      step: 0,
      observationId: 'obs-9827364518273645',
      origin: 'https://example.com',
      documentGeneration: 'gen-1726549382710',
      viewport: { width: 1920, height: 1080, devicePixelRatio: 2 },
    },
    task: { sanitized: 'Click the Submit button', risk: 'low' as const, ...overrides.task },
    scene: {
      nodes: [
        {
          provenance: 'PAGE_DATA',
          id: 'node-1920108042',
          role: 'button',
          name: 'Submit',
          actionability: 'clickable',
        },
        ...(overrides.extraNodes || []),
      ],
      coverage: {
        visualGrounding: 'none',
        unresolvedRegions: 0,
        structuredGate: 'passed',
        visualGate: 'not-applicable',
      },
      ...(overrides.scene || {}),
    },
    redactions: overrides.redactions || [],
    allowedActions: ['click', 'focus', 'type_text', 'type_token', 'select', 'scroll', 'wait', 'request_observation', 'finish'],
    ...(overrides.root || {}),
  };
}

// ── BLOCKING tests ──

await runTest('BLOCK-1 -- real phone in scene node name', async () => {
  const req = makeRequest({
    extraNodes: [{ provenance: 'PAGE_DATA', id: 'n2', role: 'text', name: 'Call us: +91 98765 43210' }],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, false, 'Must block phone in scene text');
  assert.strictEqual((result as any).category, 'pii-leak');
});

await runTest('BLOCK-2 -- real email in scene node value', async () => {
  const req = makeRequest({
    extraNodes: [{ provenance: 'PAGE_DATA', id: 'n3', role: 'textbox', name: 'Email', value: 'user@secret-domain.com' }],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, false, 'Must block email in scene text');
  assert.ok(
    (result as any).category === 'pii-leak' || (result as any).category === 'forbidden-field',
    `Must block as pii-leak or forbidden-field, got: ${(result as any).category}`,
  );
});

await runTest('BLOCK-3 -- raw credential in task', async () => {
  const req = makeRequest({
    task: { sanitized: 'Enter password: MyS3cr3tP@ss! into the field', risk: 'high' as const },
    extraNodes: [{ provenance: 'PAGE_DATA', id: 'n4', role: 'textbox', name: 'Password', value: 'password: MyS3cr3tP@ss!' }],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, false, 'Must block credential in task/scene');
});

await runTest('BLOCK-4 -- raw account number in scene', async () => {
  const req = makeRequest({
    extraNodes: [{ provenance: 'PAGE_DATA', id: 'n5', role: 'text', name: 'Account: 1234567890123456' }],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, false, 'Must block account number');
});

// ── APPROVAL tests ──

await runTest('ALLOW-5 -- sensitive token is allowed', async () => {
  const req = makeRequest({
    redactions: [{
      token: '<SENSITIVE_PAN_ABC>',
      category: 'identity-document',
      shape: 'text',
      region: 'node-n1',
      representation: 'placeholder',
      disclosure: 'shape-only',
      reasonCode: 'required-for-planning',
    }],
    extraNodes: [{ provenance: 'PAGE_DATA', id: 'n6', role: 'textbox', name: 'PAN', value: '<SENSITIVE_PAN_ABC>' }],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, true, `Must allow SENSITIVE token -- got: ${(result as any).reason}`);
});

await runTest('ALLOW-6 -- numeric observation/session IDs not false positive', async () => {
  // This was the core false-positive bug: observation IDs with digits
  // were being matched as phone numbers
  const req = makeRequest();
  // Session ID: session-8741928347123, Observation ID: obs-9827364518273645
  // These contain 10+ digit sequences that the generic phone pattern matches
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, true,
    `Must approve request with numeric IDs -- got: ${(result as any).reason}, ${(result as any).details}`);
});

await runTest('ALLOW-7 -- bbox coordinates not false positive', async () => {
  const req = makeRequest({
    extraNodes: [{
      provenance: 'PAGE_DATA', id: 'n7', role: 'button', name: 'OK',
      bbox: { x: 192, y: 1080, width: 200, height: 40 },
      actionability: 'clickable',
    }],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, true,
    `Must approve request with bbox -- got: ${(result as any).reason}`);
});

await runTest('ALLOW-8 -- normal button labels allowed', async () => {
  const req = makeRequest({
    extraNodes: [
      { provenance: 'PAGE_DATA', id: 'n8', role: 'link', name: 'ABOUT SIH' },
      { provenance: 'PAGE_DATA', id: 'n9', role: 'link', name: 'Timeline' },
      { provenance: 'PAGE_DATA', id: 'n10', role: 'heading', name: 'Smart India Hackathon 2026' },
    ],
  });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, true,
    `Must approve normal labels -- got: ${(result as any).reason}`);
});

await runTest('ALLOW-9 -- scene with many numeric node IDs approved', async () => {
  // Simulate a real page with 50 nodes with numeric IDs (like a11y tree)
  const nodes = Array.from({ length: 50 }, (_, i) => ({
    provenance: 'PAGE_DATA' as const,
    id: `node-${1000000 + i * 13579}`,
    role: 'text',
    name: `Item ${i + 1}`,
  }));
  const req = makeRequest({ extraNodes: nodes });
  const result = await verifier.verify(req, 'http://localhost:8000');
  assert.strictEqual(result.approved, true,
    `Must approve 50 numeric-ID nodes -- got: ${(result as any).reason}`);
});

await runTest('ALLOW-10 -- schema validation still works', async () => {
  const req = makeRequest();
  const parsed = PlannerRequestSchema.safeParse(req);
  assert.ok(parsed.success, `Schema must validate -- got: ${parsed.success ? 'ok' : parsed.error?.message}`);
});

// ── Summary ──

console.log(`\n[EGRESS] Field-Aware Test: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  FAIL ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

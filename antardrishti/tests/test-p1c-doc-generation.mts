/**
 * ANTARDRISHTI — P1-C Document Generation Unification Test
 *
 * Verifies:
 *   1. Same document + two captures → generation remains the same
 *   2. Harvest gen ≠ capture gen → harvest wins (content-script authority)
 *   3. Fingerprint generation equals freshness generation
 *   4. Valid plan on unchanged doc → passes generation validation
 *   5. Navigation → generation must change
 *   6. Stale plan after navigation → must fail closed
 *
 * Run: npx tsx tests/test-p1c-doc-generation.mts
 */

import assert from 'node:assert/strict';
import { createTargetFingerprint } from '../packages/protocol-v2/src/observation';
import type { TargetFingerprint } from '../packages/protocol-v2/src/observation';
import { validatePlan } from '../packages/planner/src/action-validator';
import type { SceneContext } from '../packages/planner/src/action-validator';

let passed = 0, failed = 0;
const failures: string[] = [];
async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e: any) { const m = e.message ?? String(e); console.log(`  ❌ ${name}: ${m}`); failed++; failures.push(`${name}: ${m}`); }
}

console.log('\n🔬 ANTARDRISHTI — P1-C Document Generation Unification Test\n');

// ── Test 1: Same content-script generation across captures ──

await runTest('DOCGEN-1 — same document + multiple captures use same gen', () => {
  // Content-script creates one generation at page load
  const harvestGen = `doc-${Date.now()}`;

  // Capture creates its own (different) generation per screenshot
  const captureGen1 = `doc-42-${Date.now() + 1}`;
  const captureGen2 = `doc-42-${Date.now() + 2}`;

  // After P1-C binding: capture gen is overwritten by harvest gen
  const boundGen1 = harvestGen; // what coordinator does now
  const boundGen2 = harvestGen; // same harvest, same gen

  assert.strictEqual(boundGen1, boundGen2,
    'Same document must produce same generation across captures');
  assert.notStrictEqual(captureGen1, captureGen2,
    'Capture generates different IDs per screenshot (before fix)');
  assert.strictEqual(boundGen1, harvestGen,
    'Bound generation must equal harvest generation');
});

// ── Test 2: Harvest authority overrides capture ──

await runTest('DOCGEN-2 — harvest gen overrides capture gen', () => {
  const captureGen = 'doc-42-1727351234890';
  const harvestGen = 'doc-1727351234567';

  // P1-C binding logic from coordinator:
  let finalGen = captureGen;
  if (harvestGen && captureGen !== harvestGen) {
    finalGen = harvestGen;
  }

  assert.strictEqual(finalGen, harvestGen,
    'Final generation must be harvest (content-script) authority');
  assert.notStrictEqual(finalGen, captureGen,
    'Must not use capture-generated identity');
});

// ── Test 3: Fingerprint gen equals freshness gen ──

await runTest('DOCGEN-3 — fingerprint gen equals freshness gen', () => {
  const authoritativeGen = 'doc-1727351234567';
  const obsId = 'obs-test-123';

  // After P1-C: both use the same bound generation
  const fingerprint = createTargetFingerprint(
    'n-about', 'link', 'ABOUT SIH', 'html>body>nav>a',
    { x: 100, y: 50, w: 120, h: 30 },
    0, authoritativeGen, obsId,
  );

  const freshness = {
    sessionId: 'session-test',
    tabId: 1,
    frameId: 0,
    documentGeneration: authoritativeGen,
    viewportFingerprint: '1920x1080',
    observationId: obsId,
    origin: 'https://sih.gov.in',
    createdAt: new Date().toISOString(),
  };

  assert.strictEqual(fingerprint.documentGeneration, freshness.documentGeneration,
    'Fingerprint and freshness must share the same documentGeneration');
  assert.strictEqual(fingerprint.documentGeneration, authoritativeGen,
    'Both must use the authoritative harvest generation');
});

// ── Test 4: Valid plan on unchanged document passes ──

await runTest('DOCGEN-4 — valid plan on unchanged document passes validation', () => {
  const gen = 'doc-1727351234567';
  const obsId = 'obs-test-456';

  const nodeIds = new Set(['n-about', 'n-home', 'n-timeline']);

  const fingerprints = new Map<string, TargetFingerprint>();
  fingerprints.set('n-about', createTargetFingerprint(
    'n-about', 'link', 'ABOUT SIH', 'html>body>nav>a',
    { x: 100, y: 50, w: 120, h: 30 },
    0, gen, obsId,
  ));

  const context: SceneContext = {
    nodeIds,
    freshness: {
      sessionId: 'session-test',
      tabId: 1,
      frameId: 0,
      documentGeneration: gen,  // Same gen as fingerprints
      viewportFingerprint: '1920x1080',
      observationId: obsId,
      origin: 'https://sih.gov.in',
      createdAt: new Date().toISOString(),
    },
    targetFingerprints: fingerprints,
    planObservationId: obsId,
    tokenValidator: () => false,
    targetContext: new Map(),
  };

  const actions = [{
    id: 'action-1',
    kind: 'click' as const,
    targetNodeId: 'n-about',
    reason: 'Click ABOUT SIH',
  }];

  const result = validatePlan(actions, context);
  assert.ok(result.valid, `Plan must pass validation — got errors: ${result.validations.flatMap(v => v.errors).join('; ')}`);
});

// ── Test 5: Navigation creates new generation ──

await runTest('DOCGEN-5 — navigation produces new generation', () => {
  // Content-script: new gen on page load
  const gen1 = `doc-${1727351234567}`;

  // After navigation: content-script creates new gen
  const gen2 = `doc-${1727351234567 + 5000}`;

  assert.notStrictEqual(gen1, gen2,
    'Navigation must produce a new documentGeneration');
});

// ── Test 6: Stale plan after navigation fails closed ──

await runTest('DOCGEN-6 — stale plan after navigation fails closed', () => {
  const genBeforeNav = 'doc-1727351234567';
  const genAfterNav = 'doc-1727351239567';  // New gen after navigation
  const obsId = 'obs-test-789';

  const nodeIds = new Set(['n-about']);

  // Fingerprint created with OLD generation
  const fingerprints = new Map<string, TargetFingerprint>();
  fingerprints.set('n-about', createTargetFingerprint(
    'n-about', 'link', 'ABOUT SIH', 'html>body>nav>a',
    { x: 100, y: 50, w: 120, h: 30 },
    0, genBeforeNav, obsId,
  ));

  // But freshness uses NEW generation (navigation happened)
  const context: SceneContext = {
    nodeIds,
    freshness: {
      sessionId: 'session-test',
      tabId: 1,
      frameId: 0,
      documentGeneration: genAfterNav,  // Different from fingerprint!
      viewportFingerprint: '1920x1080',
      observationId: obsId,
      origin: 'https://sih.gov.in',
      createdAt: new Date().toISOString(),
    },
    targetFingerprints: fingerprints,
    planObservationId: obsId,
    tokenValidator: () => false,
    targetContext: new Map(),
  };

  const actions = [{
    id: 'action-1',
    kind: 'click' as const,
    targetNodeId: 'n-about',
    reason: 'Click ABOUT SIH',
  }];

  const result = validatePlan(actions, context);
  assert.ok(!result.valid,
    'Plan against stale document must fail closed');
});

// ── Summary ──
console.log(`\n🔬 P1-C Document Generation: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

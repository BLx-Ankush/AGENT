/**
 * ANTARDRISHTI — Authoritative Navigation Detection Tests
 *
 * Verifies that navigation detection uses the AUTHORITATIVE
 * harvest documentGeneration, not the capture stamp.
 *
 * Run: npx tsx tests/test-navigation-detection.mts
 */

import { strict as assert } from 'node:assert';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
    failures.push(`${name}: ${e.message}`);
  }
}

// ── Simulate the authoritative navigation detection logic ──

interface StateChanges {
  textEntered: boolean;
  navigationOccurred: boolean;
  documentChanged: boolean;
}

interface NavState {
  lastDocumentGeneration: string | null;
  stateChanges: StateChanges;
}

/**
 * Simulates the coordinator's navigation detection logic.
 * captureGen: the capture subsystem's documentGeneration (changes per capture)
 * harvestGen: the content-script's authoritative documentGeneration (changes on real navigation)
 * isContinuation: whether this is a continuation pipeline
 */
function detectNavigation(
  state: NavState,
  captureGen: string,
  harvestGen: string | null,
  isContinuation: boolean,
): { changed: boolean; authoritativeDocGen: string } {
  // P1-C binding: use harvest if available, else capture
  const authoritativeDocGen = harvestGen ?? captureGen;

  // Navigation detection: AFTER binding, using authoritative generation
  if (isContinuation && state.lastDocumentGeneration !== null) {
    const changed = authoritativeDocGen !== state.lastDocumentGeneration;
    if (changed) {
      state.stateChanges.documentChanged = true;
      state.stateChanges.navigationOccurred = true;
    }
  }

  // Store authoritative generation
  state.lastDocumentGeneration = authoritativeDocGen;

  return {
    changed: state.stateChanges.documentChanged,
    authoritativeDocGen,
  };
}

function freshState(): NavState {
  return {
    lastDocumentGeneration: null,
    stateChanges: { textEntered: false, navigationOccurred: false, documentChanged: false },
  };
}

console.log('\n🧭 ANTARDRISHTI — Authoritative Navigation Detection Tests\n');

// ── ND-01: Same harvest generation across captures → no navigation ──
test('ND-01: same harvest docGen across captures → navigationOccurred=false', () => {
  const state = freshState();

  // First pipeline: initial observation
  detectNavigation(state, 'capture-gen-1', 'harvest-gen-A', false);
  assert.equal(state.stateChanges.navigationOccurred, false);

  // Second pipeline (continuation): new capture but SAME harvest
  detectNavigation(state, 'capture-gen-2', 'harvest-gen-A', true);
  assert.equal(state.stateChanges.navigationOccurred, false);
  assert.equal(state.stateChanges.documentChanged, false);
});

// ── ND-02: New capture generation but same harvest → no navigation ──
test('ND-02: new capture gen + same harvest gen → navigationOccurred=false', () => {
  const state = freshState();

  detectNavigation(state, 'capture-100', 'harvest-X', false);
  // Continuation with totally different capture stamp but identical harvest
  detectNavigation(state, 'capture-200', 'harvest-X', true);
  assert.equal(state.stateChanges.navigationOccurred, false);
  assert.equal(state.stateChanges.documentChanged, false);
});

// ── ND-03: Changed harvest documentGeneration → navigation detected ──
test('ND-03: changed harvest docGen → navigationOccurred=true', () => {
  const state = freshState();

  detectNavigation(state, 'capture-1', 'harvest-A', false);
  // Real navigation: harvest generation changed
  detectNavigation(state, 'capture-2', 'harvest-B', true);
  assert.equal(state.stateChanges.navigationOccurred, true);
  assert.equal(state.stateChanges.documentChanged, true);
});

// ── ND-04: First observation → no navigation (no previous to compare) ──
test('ND-04: first observation → navigationOccurred=false', () => {
  const state = freshState();

  detectNavigation(state, 'capture-1', 'harvest-A', false);
  assert.equal(state.stateChanges.navigationOccurred, false);
  assert.equal(state.stateChanges.documentChanged, false);
  assert.equal(state.lastDocumentGeneration, 'harvest-A');
});

// ── ND-05: Capture generation changes alone → no documentChanged ──
test('ND-05: capture gen change only → documentChanged=false', () => {
  const state = freshState();

  // Same harvest across 3 captures with different capture gens
  detectNavigation(state, 'cap-A', 'harvest-SAME', false);
  detectNavigation(state, 'cap-B', 'harvest-SAME', true);
  detectNavigation(state, 'cap-C', 'harvest-SAME', true);
  assert.equal(state.stateChanges.documentChanged, false);
  assert.equal(state.stateChanges.navigationOccurred, false);
});

// ── ND-06: TaskProgress after type_text before navigation ──
test('ND-06: type_text success + same page → textEntered=true, nav=false', () => {
  const state = freshState();
  state.stateChanges.textEntered = true; // type_text succeeded

  // Continuation: same harvest gen (no navigation)
  detectNavigation(state, 'cap-1', 'harvest-A', false);
  detectNavigation(state, 'cap-2', 'harvest-A', true);
  assert.equal(state.stateChanges.textEntered, true);
  assert.equal(state.stateChanges.navigationOccurred, false);
  assert.equal(state.stateChanges.documentChanged, false);
});

// ── ND-07: TaskProgress after genuine navigation ──
test('ND-07: genuine navigation → nav=true, docChanged=true', () => {
  const state = freshState();
  state.stateChanges.textEntered = true; // from previous step

  detectNavigation(state, 'cap-1', 'harvest-A', false);
  // Actual navigation: harvest gen changed
  detectNavigation(state, 'cap-2', 'harvest-B', true);
  assert.equal(state.stateChanges.textEntered, true); // preserved
  assert.equal(state.stateChanges.navigationOccurred, true);
  assert.equal(state.stateChanges.documentChanged, true);
});

// ── ND-08: Authoritative gen stored is harvest, not capture ──
test('ND-08: stored lastDocumentGeneration is harvest gen, not capture gen', () => {
  const state = freshState();

  const result = detectNavigation(state, 'capture-xyz', 'harvest-abc', false);
  assert.equal(state.lastDocumentGeneration, 'harvest-abc');
  assert.equal(result.authoritativeDocGen, 'harvest-abc');
  assert.notEqual(state.lastDocumentGeneration, 'capture-xyz');
});

// ── ND-09: Non-continuation pipeline with previous gen → no nav detection ──
test('ND-09: non-continuation with previous gen → no navigation check', () => {
  const state = freshState();

  detectNavigation(state, 'cap-1', 'harvest-A', false);
  // Fresh user task (not continuation) with different gen
  detectNavigation(state, 'cap-2', 'harvest-B', false);
  // Not a continuation → navigation detection should not run
  assert.equal(state.stateChanges.navigationOccurred, false);
});

// ── ND-10: Multiple continuations, nav only on actual change ──
test('ND-10: 3 continuations, nav detected only on gen change', () => {
  const state = freshState();

  detectNavigation(state, 'cap-0', 'harvest-1', false);  // initial
  detectNavigation(state, 'cap-1', 'harvest-1', true);   // no change
  assert.equal(state.stateChanges.navigationOccurred, false);
  detectNavigation(state, 'cap-2', 'harvest-1', true);   // no change
  assert.equal(state.stateChanges.navigationOccurred, false);
  detectNavigation(state, 'cap-3', 'harvest-2', true);   // real change
  assert.equal(state.stateChanges.navigationOccurred, true);
  assert.equal(state.stateChanges.documentChanged, true);
});

// ── ND-11: Harvest gen null → falls back to capture gen (backward compat) ──
test('ND-11: null harvest gen → uses capture gen as fallback', () => {
  const state = freshState();

  detectNavigation(state, 'cap-1', null, false);
  assert.equal(state.lastDocumentGeneration, 'cap-1');
  detectNavigation(state, 'cap-1', null, true);
  assert.equal(state.stateChanges.navigationOccurred, false);
});

// Summary
console.log(`\n🧭 Navigation Detection: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

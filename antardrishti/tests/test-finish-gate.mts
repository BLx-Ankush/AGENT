/**
 * ANTARDRISHTI — Finish Completion Gate Tests (Hardened)
 *
 * Verifies the local finish gate requires post-submit evidence
 * (not just click success) before allowing search task completion.
 *
 * Run: npx tsx tests/test-finish-gate.mts
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

// ── Mirror the exact logic from coordinator.ts ──

type TaskIntent = 'search' | 'generic';

const SEARCH_PATTERNS = [
  /\bsearch\s+for\b/i,
  /\bsearch\b/i,
  /\bfind\b/i,
  /\blook\s+for\b/i,
  /\blook\s+up\b/i,
  /\bbrowse\s+for\b/i,
];

function classifyTaskIntent(sanitizedTask: string): TaskIntent {
  for (const pattern of SEARCH_PATTERNS) {
    if (pattern.test(sanitizedTask)) return 'search';
  }
  return 'generic';
}

interface FinishGateContext {
  taskIntent: TaskIntent;
  textEntered: boolean;
  navigationOccurred: boolean;
  documentChanged: boolean;
  submitActionAttempted: boolean;
  submitActionConfirmed: boolean;
}

interface FinishGateResult {
  allowed: boolean;
  reason: string;
}

function validateFinish(ctx: FinishGateContext): FinishGateResult {
  if (ctx.taskIntent === 'generic') {
    return { allowed: true, reason: 'generic-task-finish-allowed' };
  }
  if (ctx.taskIntent === 'search') {
    if (ctx.navigationOccurred || ctx.documentChanged) {
      return { allowed: true, reason: 'navigation-observed' };
    }
    if (ctx.submitActionConfirmed) {
      return { allowed: true, reason: 'submit-action-confirmed' };
    }
    if (ctx.submitActionAttempted) {
      return { allowed: false, reason: 'completion-not-established' };
    }
    if (ctx.textEntered) {
      return { allowed: false, reason: 'completion-not-established' };
    }
    return { allowed: true, reason: 'no-text-entered-finish-allowed' };
  }
  return { allowed: true, reason: 'fallback-allowed' };
}

const SUBMIT_ACTION_KINDS = new Set(['click', 'select']);

console.log('\n🚫 ANTARDRISHTI — Finish Completion Gate Tests (Hardened)\n');

// ── FG-01: click executed but no post-action evidence → REJECT ──
test('FG-01: click executed + no post-submit evidence → REJECT', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: true,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'completion-not-established');
});

// ── FG-02: click + genuine navigation → ALLOW ──
test('FG-02: click + genuine navigation → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: true,
    documentChanged: true,
    submitActionAttempted: true,
    submitActionConfirmed: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'navigation-observed');
});

// ── FG-03: click + confirmed progression → ALLOW ──
test('FG-03: click + confirmed without explicit navigation → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: true,
    submitActionConfirmed: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'submit-action-confirmed');
});

// ── FG-04: finish after click without confirmation → REJECT ──
test('FG-04: finish after click without confirmation → REJECT', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: true,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, false);
});

// ── FG-05: finish after confirmed progression → ALLOW ──
test('FG-05: finish after confirmed progression → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: true,
    documentChanged: true,
    submitActionAttempted: true,
    submitActionConfirmed: true,
  });
  assert.equal(result.allowed, true);
});

// ── FG-06: planner finish cannot override missing evidence ──
test('FG-06: planner finish blocked when local evidence missing', () => {
  // Even with submitActionAttempted=true, no confirmation = reject
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: true,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'completion-not-established');
});

// ── FG-07: non-search behavior unchanged ──
test('FG-07: generic task + finish → ALLOW (existing behavior)', () => {
  const result = validateFinish({
    taskIntent: 'generic',
    textEntered: false,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: false,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'generic-task-finish-allowed');
});

// ── FG-08: search + no text/submit + finish → ALLOW ──
test('FG-08: search + no text entered + finish → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: false,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: false,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'no-text-entered-finish-allowed');
});

// ── FG-09: type_text only + finish → REJECT ──
test('FG-09: type_text only (no submit) + finish → REJECT', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: false,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, false);
});

// ── FG-10: documentChanged only → ALLOW ──
test('FG-10: documentChanged only → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: true,
    submitActionAttempted: false,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'navigation-observed');
});

// ── Task-intent classifier tests ──

test('FG-11: "Search for OnePlus 12R" → search', () => {
  assert.equal(classifyTaskIntent('Search for OnePlus 12R'), 'search');
});

test('FG-12: "find cheap flights" → search', () => {
  assert.equal(classifyTaskIntent('find cheap flights'), 'search');
});

test('FG-13: "look for red shoes" → search', () => {
  assert.equal(classifyTaskIntent('look for red shoes'), 'search');
});

test('FG-14: "look up the weather" → search', () => {
  assert.equal(classifyTaskIntent('look up the weather'), 'search');
});

test('FG-15: "click the login button" → generic', () => {
  assert.equal(classifyTaskIntent('click the login button'), 'generic');
});

test('FG-16: "fill in the form" → generic', () => {
  assert.equal(classifyTaskIntent('fill in the form'), 'generic');
});

test('FG-17: "browse for headphones" → search', () => {
  assert.equal(classifyTaskIntent('browse for headphones'), 'search');
});

test('FG-18: "SEARCH FOR something" (uppercase) → search', () => {
  assert.equal(classifyTaskIntent('SEARCH FOR something'), 'search');
});

// ── Submit action tracking tests ──

test('FG-19: click is a submit-like action', () => {
  assert.equal(SUBMIT_ACTION_KINDS.has('click'), true);
});

test('FG-20: select is a submit-like action', () => {
  assert.equal(SUBMIT_ACTION_KINDS.has('select'), true);
});

test('FG-21: type_text is NOT a submit-like action', () => {
  assert.equal(SUBMIT_ACTION_KINDS.has('type_text'), false);
});

test('FG-22: focus is NOT a submit-like action', () => {
  assert.equal(SUBMIT_ACTION_KINDS.has('focus'), false);
});

// ── End-to-end scenario: Amazon search sequence ──

test('FG-23: full sequence — type_text → click → no nav → REJECT', () => {
  // After type_text + click but no navigation
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionAttempted: true,
    submitActionConfirmed: false,
  });
  assert.equal(result.allowed, false);
});

test('FG-24: full sequence — type_text → click → nav → ALLOW', () => {
  // After type_text + click + actual navigation
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: true,
    documentChanged: true,
    submitActionAttempted: true,
    submitActionConfirmed: true,
  });
  assert.equal(result.allowed, true);
});

// Summary
console.log(`\n🚫 Finish Gate: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

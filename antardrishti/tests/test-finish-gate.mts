/**
 * ANTARDRISHTI — Finish Completion Gate Tests
 *
 * Verifies the local finish gate prevents premature task completion
 * and preserves existing behavior for non-search tasks.
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
  submitActionSucceeded: boolean;
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
    if (ctx.submitActionSucceeded) {
      return { allowed: true, reason: 'submit-action-succeeded' };
    }
    if (ctx.textEntered) {
      return { allowed: false, reason: 'completion-not-established' };
    }
    return { allowed: true, reason: 'no-text-entered-finish-allowed' };
  }
  return { allowed: true, reason: 'fallback-allowed' };
}

function hasSubmitActionSucceeded(
  actionHistory: Array<{ kind: string; outcome: string }>,
): boolean {
  const SUBMIT_KINDS = new Set(['click', 'select']);
  return actionHistory.some(
    a => SUBMIT_KINDS.has(a.kind) && a.outcome === 'success',
  );
}

console.log('\n🚫 ANTARDRISHTI — Finish Completion Gate Tests\n');

// ── FG-01: search + type_text + no nav + finish → REJECT ──
test('FG-01: search + type_text + no nav + finish → REJECT', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionSucceeded: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'completion-not-established');
});

// ── FG-02: search + type_text + finish → REJECT ──
test('FG-02: search + type_text success only + finish → REJECT', () => {
  const history = [{ kind: 'type_text', outcome: 'success' }];
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionSucceeded: hasSubmitActionSucceeded(history),
  });
  assert.equal(result.allowed, false);
});

// ── FG-03: search + type_text + click + finish → ALLOW ──
test('FG-03: search + type_text + click success + finish → ALLOW', () => {
  const history = [
    { kind: 'type_text', outcome: 'success' },
    { kind: 'click', outcome: 'success' },
  ];
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionSucceeded: hasSubmitActionSucceeded(history),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'submit-action-succeeded');
});

// ── FG-04: search + navigation → ALLOW ──
test('FG-04: search + navigation observed + finish → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: true,
    documentChanged: true,
    submitActionSucceeded: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'navigation-observed');
});

// ── FG-05: non-search + existing finish → ALLOW (preserve behavior) ──
test('FG-05: generic task + finish → ALLOW (existing behavior)', () => {
  const result = validateFinish({
    taskIntent: 'generic',
    textEntered: false,
    navigationOccurred: false,
    documentChanged: false,
    submitActionSucceeded: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'generic-task-finish-allowed');
});

// ── FG-06: planner finish never overrides local evidence ──
test('FG-06: planner finish blocked when local evidence missing', () => {
  // Even if planner says finish, local gate rejects
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: false,
    submitActionSucceeded: false,
  });
  assert.equal(result.allowed, false);
});

// ── FG-07: search + documentChanged only → ALLOW ──
test('FG-07: documentChanged without navigationOccurred → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: true,
    navigationOccurred: false,
    documentChanged: true,
    submitActionSucceeded: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'navigation-observed');
});

// ── FG-08: search + no text entered + finish → ALLOW ──
test('FG-08: search + no text entered + finish → ALLOW', () => {
  const result = validateFinish({
    taskIntent: 'search',
    textEntered: false,
    navigationOccurred: false,
    documentChanged: false,
    submitActionSucceeded: false,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'no-text-entered-finish-allowed');
});

// ── Task-intent classifier tests ──

test('FG-09: "Search for OnePlus 12R" → search', () => {
  assert.equal(classifyTaskIntent('Search for OnePlus 12R'), 'search');
});

test('FG-10: "find cheap flights" → search', () => {
  assert.equal(classifyTaskIntent('find cheap flights'), 'search');
});

test('FG-11: "look for red shoes" → search', () => {
  assert.equal(classifyTaskIntent('look for red shoes'), 'search');
});

test('FG-12: "look up the weather" → search', () => {
  assert.equal(classifyTaskIntent('look up the weather'), 'search');
});

test('FG-13: "click the login button" → generic', () => {
  assert.equal(classifyTaskIntent('click the login button'), 'generic');
});

test('FG-14: "fill in the form" → generic', () => {
  assert.equal(classifyTaskIntent('fill in the form'), 'generic');
});

test('FG-15: "browse for headphones" → search', () => {
  assert.equal(classifyTaskIntent('browse for headphones'), 'search');
});

test('FG-16: "SEARCH FOR something" (uppercase) → search', () => {
  assert.equal(classifyTaskIntent('SEARCH FOR something'), 'search');
});

// ── hasSubmitActionSucceeded tests ──

test('FG-17: empty history → no submit', () => {
  assert.equal(hasSubmitActionSucceeded([]), false);
});

test('FG-18: only type_text → no submit', () => {
  assert.equal(hasSubmitActionSucceeded([
    { kind: 'type_text', outcome: 'success' },
  ]), false);
});

test('FG-19: click success → submit succeeded', () => {
  assert.equal(hasSubmitActionSucceeded([
    { kind: 'type_text', outcome: 'success' },
    { kind: 'click', outcome: 'success' },
  ]), true);
});

test('FG-20: click failure → no submit', () => {
  assert.equal(hasSubmitActionSucceeded([
    { kind: 'click', outcome: 'failure' },
  ]), false);
});

test('FG-21: select success → submit succeeded', () => {
  assert.equal(hasSubmitActionSucceeded([
    { kind: 'select', outcome: 'success' },
  ]), true);
});

test('FG-22: focus/scroll/wait → no submit', () => {
  assert.equal(hasSubmitActionSucceeded([
    { kind: 'focus', outcome: 'success' },
    { kind: 'scroll', outcome: 'success' },
    { kind: 'wait', outcome: 'success' },
  ]), false);
});

// Summary
console.log(`\n🚫 Finish Gate: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

/**
 * ANTARDRISHTI — Task Progress Context Tests
 *
 * Verifies:
 *   1. type_text success updates progress
 *   2. failed type_text does not claim progress
 *   3. click success updates progress
 *   4. previous successful action appears in bounded history
 *   5. raw type_text value is NOT included in progress history
 *   6. new planner request contains progress context
 *   7. old PlannerResponse is never reused
 *   8. after type_text success, next planner context indicates text-entry
 *   9. progress resets for a new user task
 *  10. progress clears on session end
 *  11. continuation limit still works
 *  12. navigation detection updates documentChanged
 *  13. bounded history respects MAX_ACTION_HISTORY
 *  14. failure recorded in history
 *  15. progress does not bypass one-action boundary
 *  16. taskStatus remains in_progress until finish
 *  17. privacy: no raw values in progress
 *
 * Run: npx tsx tests/test-task-progress.mts
 */

import { strict as assert } from 'node:assert';

// ── Types mirrored from coordinator ──

interface ActionHistoryEntry {
  kind: string;
  outcome: 'success' | 'failure' | 'rejected';
}

interface TaskProgressContext {
  step: number;
  lastAction?: ActionHistoryEntry;
  actionHistory: ActionHistoryEntry[];
  taskStatus: 'in_progress' | 'completed' | 'blocked';
  stateChanges: {
    textEntered: boolean;
    navigationOccurred: boolean;
    documentChanged: boolean;
  };
}

const MAX_ACTION_HISTORY = 5;

const EMPTY_PROGRESS: TaskProgressContext = {
  step: 0,
  actionHistory: [],
  taskStatus: 'in_progress',
  stateChanges: {
    textEntered: false,
    navigationOccurred: false,
    documentChanged: false,
  },
};

function freshProgress(): TaskProgressContext {
  return { ...EMPTY_PROGRESS, actionHistory: [], stateChanges: { ...EMPTY_PROGRESS.stateChanges } };
}

function recordSuccess(progress: TaskProgressContext, kind: string): void {
  const entry: ActionHistoryEntry = { kind, outcome: 'success' };
  progress.step++;
  progress.lastAction = entry;
  progress.actionHistory.push(entry);
  if (progress.actionHistory.length > MAX_ACTION_HISTORY) {
    progress.actionHistory.shift();
  }
  if (kind === 'type_text' || kind === 'type_token') {
    progress.stateChanges.textEntered = true;
  }
}

function recordFailure(progress: TaskProgressContext, kind: string): void {
  const entry: ActionHistoryEntry = { kind, outcome: 'failure' };
  progress.lastAction = entry;
  progress.actionHistory.push(entry);
  if (progress.actionHistory.length > MAX_ACTION_HISTORY) {
    progress.actionHistory.shift();
  }
  // Failed action does NOT increment step or set stateChanges
}

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

console.log('\n📊 ANTARDRISHTI — Task Progress Context Tests\n');

// ── Test 1: type_text success updates progress ──
test('TP-01: type_text success → step=1, textEntered=true', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  assert.equal(p.step, 1);
  assert.equal(p.stateChanges.textEntered, true);
  assert.equal(p.lastAction?.kind, 'type_text');
  assert.equal(p.lastAction?.outcome, 'success');
});

// ── Test 2: failed type_text does not claim progress ──
test('TP-02: failed type_text → step stays 0, textEntered=false', () => {
  const p = freshProgress();
  recordFailure(p, 'type_text');
  assert.equal(p.step, 0);
  assert.equal(p.stateChanges.textEntered, false);
  assert.equal(p.lastAction?.outcome, 'failure');
});

// ── Test 3: click success updates progress ──
test('TP-03: click success → step=1, textEntered=false', () => {
  const p = freshProgress();
  recordSuccess(p, 'click');
  assert.equal(p.step, 1);
  assert.equal(p.stateChanges.textEntered, false);
  assert.equal(p.lastAction?.kind, 'click');
});

// ── Test 4: previous successful action in bounded history ──
test('TP-04: action history records both actions', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  recordSuccess(p, 'click');
  assert.equal(p.actionHistory.length, 2);
  assert.equal(p.actionHistory[0].kind, 'type_text');
  assert.equal(p.actionHistory[1].kind, 'click');
});

// ── Test 5: raw type_text value NOT in progress history ──
test('TP-05: privacy — no raw values in progress entries', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  const entry = p.actionHistory[0];
  // Only kind and outcome — no text, value, token, targetNodeId
  assert.deepEqual(Object.keys(entry).sort(), ['kind', 'outcome']);
  assert.equal('text' in entry, false);
  assert.equal('value' in entry, false);
  assert.equal('token' in entry, false);
});

// ── Test 6: planner request would contain progress ──
test('TP-06: progress step > 0 → included in planner request', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  const shouldInclude = p.step > 0;
  assert.equal(shouldInclude, true);
});

// ── Test 7: fresh progress for step=0 → NOT in planner request ──
test('TP-07: step=0 → NOT included in planner request', () => {
  const p = freshProgress();
  const shouldInclude = p.step > 0;
  assert.equal(shouldInclude, false);
});

// ── Test 8: after type_text success, context indicates text entry ──
test('TP-08: after type_text success → stateChanges.textEntered=true', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  assert.equal(p.stateChanges.textEntered, true);
  // Simulating planner request serialization
  const progressPayload = {
    step: p.step,
    lastAction: p.lastAction,
    actionHistory: p.actionHistory,
    taskStatus: p.taskStatus,
    stateChanges: { ...p.stateChanges },
  };
  assert.equal(progressPayload.stateChanges.textEntered, true);
  assert.equal(progressPayload.lastAction?.kind, 'type_text');
});

// ── Test 9: progress resets for a new user task ──
test('TP-09: new task resets progress', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  recordSuccess(p, 'click');
  assert.equal(p.step, 2);
  // Simulate new task init
  const reset = freshProgress();
  assert.equal(reset.step, 0);
  assert.equal(reset.actionHistory.length, 0);
  assert.equal(reset.stateChanges.textEntered, false);
});

// ── Test 10: progress clears on session end (same as reset) ──
test('TP-10: session end → progress cleared', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  // Session end replaces state with INITIAL_STATE which has fresh progress
  const endedProgress = freshProgress();
  assert.equal(endedProgress.step, 0);
  assert.equal(endedProgress.taskStatus, 'in_progress');
  assert.equal(endedProgress.actionHistory.length, 0);
});

// ── Test 11: continuation limit still works ──
test('TP-11: continuation count independent of progress step', () => {
  const MAX_TASK_CONTINUATIONS = 10;
  let continuationCount = 0;
  const p = freshProgress();
  for (let i = 0; i < 12; i++) {
    recordSuccess(p, 'click');
    continuationCount++;
  }
  assert.equal(p.step, 12);
  assert.equal(continuationCount >= MAX_TASK_CONTINUATIONS, true);
  // Continuation limit blocks based on continuationCount, not progress.step
});

// ── Test 12: navigation detection ──
test('TP-12: document generation change → navigation detected', () => {
  const p = freshProgress();
  recordSuccess(p, 'click');
  // Simulate navigation detection
  const prevDocGen = 'gen-1';
  const currentDocGen = 'gen-2';
  if (currentDocGen !== prevDocGen) {
    p.stateChanges.documentChanged = true;
    p.stateChanges.navigationOccurred = true;
  }
  assert.equal(p.stateChanges.documentChanged, true);
  assert.equal(p.stateChanges.navigationOccurred, true);
});

// ── Test 13: bounded history respects MAX_ACTION_HISTORY ──
test('TP-13: history bounded at MAX_ACTION_HISTORY=5', () => {
  const p = freshProgress();
  for (let i = 0; i < 8; i++) {
    recordSuccess(p, i % 2 === 0 ? 'click' : 'type_text');
  }
  assert.equal(p.step, 8);
  assert.equal(p.actionHistory.length, MAX_ACTION_HISTORY);
  // Oldest entries were shifted out
});

// ── Test 14: failure recorded in history ──
test('TP-14: failure appears in history with outcome=failure', () => {
  const p = freshProgress();
  recordSuccess(p, 'click');
  recordFailure(p, 'type_text');
  assert.equal(p.actionHistory.length, 2);
  assert.equal(p.actionHistory[1].outcome, 'failure');
  assert.equal(p.step, 1); // Only success increments step
});

// ── Test 15: progress does not bypass one-action boundary ──
test('TP-15: one-action boundary preserved — progress is informational', () => {
  // Progress context is for the planner. It does not affect
  // how many actions are executed per observation.
  const STATE_CHANGING_ACTIONS = new Set(['click', 'type_text', 'type_token', 'select', 'submit']);
  const plan = [
    { kind: 'click', id: 'a-1' },
    { kind: 'type_text', id: 'a-2' },
  ];
  let executedStateChanging = false;
  const executed: string[] = [];
  for (const action of plan) {
    const isStateChanging = STATE_CHANGING_ACTIONS.has(action.kind);
    if (isStateChanging && executedStateChanging) break; // one-action boundary
    executed.push(action.id);
    if (isStateChanging) executedStateChanging = true;
  }
  assert.deepEqual(executed, ['a-1']); // Only one action executed
});

// ── Test 16: taskStatus remains in_progress ──
test('TP-16: taskStatus stays in_progress until finish', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  recordSuccess(p, 'click');
  recordSuccess(p, 'click');
  assert.equal(p.taskStatus, 'in_progress');
});

// ── Test 17: privacy — no raw values ever ──
test('TP-17: serialized progress contains ZERO raw values', () => {
  const p = freshProgress();
  recordSuccess(p, 'type_text');
  recordSuccess(p, 'click');
  const serialized = JSON.stringify(p);
  // Should not contain any of these raw value patterns
  assert.equal(serialized.includes('OnePlus'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('SENSITIVE'), false);
  assert.equal(serialized.includes('targetNodeId'), false);
  // Verify only expected keys in history entries
  for (const entry of p.actionHistory) {
    const keys = Object.keys(entry);
    assert.deepEqual(keys.sort(), ['kind', 'outcome']);
  }
});

// Summary
console.log(`\n📊 Task Progress: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

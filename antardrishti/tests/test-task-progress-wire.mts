/**
 * ANTARDRISHTI — Task Progress Wire-Schema Tests
 *
 * Tests the canonical PlannerRequestSchema accepts/rejects
 * taskProgress correctly, and verifies the EgressVerifier
 * production boundary.
 *
 * Run: npx tsx tests/test-task-progress-wire.mts
 */

import { strict as assert } from 'node:assert';
import {
  PlannerRequestSchema,
  TaskProgressSchema,
} from '../packages/protocol-v2/src/schemas';

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

// ── Helpers ──

function makeValidRequest(taskProgress?: unknown) {
  const base: any = {
    protocolVersion: '2.0',
    session: {
      id: 'sess-1',
      step: 0,
      observationId: 'obs-1',
      origin: 'https://example.com',
      documentGeneration: 'doc-1',
      viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
    },
    task: { sanitized: 'Search for something', risk: 'low' },
    scene: {
      nodes: [
        {
          provenance: 'PAGE_DATA',
          id: 'n-1',
          role: 'searchbox',
          name: 'Search',
        },
      ],
      coverage: {
        visualGrounding: 'none',
        unresolvedRegions: 0,
        structuredGate: 'passed',
        visualGate: 'not-applicable',
      },
    },
    redactions: [],
    allowedActions: ['click', 'type_text', 'finish'],
  };
  if (taskProgress !== undefined) {
    base.taskProgress = taskProgress;
  }
  return base;
}

function makeValidProgress(): any {
  return {
    step: 1,
    lastAction: { kind: 'type_text', outcome: 'success' },
    actionHistory: [
      { kind: 'type_text', outcome: 'success' },
    ],
    taskStatus: 'in_progress',
    stateChanges: {
      textEntered: true,
      navigationOccurred: false,
      documentChanged: false,
    },
  };
}

console.log('\n🔌 ANTARDRISHTI — Task Progress Wire-Schema Tests\n');

// ── Test 1: Without taskProgress → accepted ──
test('WS-01: PlannerRequest without taskProgress → accepted', () => {
  const result = PlannerRequestSchema.safeParse(makeValidRequest());
  assert.equal(result.success, true, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
});

// ── Test 2: With valid taskProgress → accepted ──
test('WS-02: PlannerRequest with valid taskProgress → accepted', () => {
  const result = PlannerRequestSchema.safeParse(makeValidRequest(makeValidProgress()));
  assert.equal(result.success, true, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
});

// ── Test 3: taskProgress with unknown key → rejected ──
test('WS-03: taskProgress with unknown key → rejected', () => {
  const progress = { ...makeValidProgress(), rawPageContent: 'some content' };
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 4: lastAction with unknown key → rejected ──
test('WS-04: lastAction with unknown key → rejected', () => {
  const progress = makeValidProgress();
  progress.lastAction = { kind: 'type_text', outcome: 'success', targetNodeId: 'n-1' };
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 5: history > 5 → rejected ──
test('WS-05: actionHistory > 5 entries → rejected', () => {
  const progress = makeValidProgress();
  progress.actionHistory = Array.from({ length: 6 }, (_, i) => ({
    kind: 'click',
    outcome: 'success',
  }));
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 6: invalid outcome → rejected ──
test('WS-06: invalid outcome value → rejected', () => {
  const progress = makeValidProgress();
  progress.lastAction = { kind: 'click', outcome: 'maybe' };
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 7: negative step → rejected ──
test('WS-07: negative step → rejected', () => {
  const progress = makeValidProgress();
  progress.step = -1;
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 8: non-integer step → rejected ──
test('WS-08: non-integer step → rejected', () => {
  const progress = makeValidProgress();
  progress.step = 1.5;
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 9: raw token field → rejected ──
test('WS-09: history entry with token field → rejected', () => {
  const progress = makeValidProgress();
  progress.actionHistory = [{ kind: 'type_token', outcome: 'success', token: '<SENSITIVE_XXXX>' }];
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 10: raw action text field → rejected ──
test('WS-10: history entry with text field → rejected', () => {
  const progress = makeValidProgress();
  progress.actionHistory = [{ kind: 'type_text', outcome: 'success', text: 'OnePlus 12R' }];
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 11: stateChanges with unknown key → rejected ──
test('WS-11: stateChanges with unknown key → rejected', () => {
  const progress = makeValidProgress();
  progress.stateChanges.pageUrl = 'https://amazon.in';
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 12: invalid taskStatus → rejected ──
test('WS-12: invalid taskStatus value → rejected', () => {
  const progress = makeValidProgress();
  progress.taskStatus = 'unknown';
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, false);
});

// ── Test 13: valid multi-step progress → accepted ──
test('WS-13: multi-step progress with 5 history entries → accepted', () => {
  const progress = makeValidProgress();
  progress.step = 5;
  progress.actionHistory = [
    { kind: 'click', outcome: 'success' },
    { kind: 'type_text', outcome: 'success' },
    { kind: 'click', outcome: 'success' },
    { kind: 'click', outcome: 'failure' },
    { kind: 'click', outcome: 'success' },
  ];
  progress.stateChanges = {
    textEntered: true,
    navigationOccurred: true,
    documentChanged: true,
  };
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, true, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
});

// ── Test 14: step=0 with empty history → accepted ──
test('WS-14: step=0 with empty history → accepted', () => {
  const progress = {
    step: 0,
    actionHistory: [],
    taskStatus: 'in_progress' as const,
    stateChanges: { textEntered: false, navigationOccurred: false, documentChanged: false },
  };
  const result = PlannerRequestSchema.safeParse(makeValidRequest(progress));
  assert.equal(result.success, true, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
});

// ── Test 15: TaskProgressSchema standalone validation ──
test('WS-15: TaskProgressSchema rejects targetNodeId in history', () => {
  const result = TaskProgressSchema.safeParse({
    step: 1,
    lastAction: { kind: 'click', outcome: 'success' },
    actionHistory: [{ kind: 'click', outcome: 'success', targetNodeId: 'n-1' }],
    taskStatus: 'in_progress',
    stateChanges: { textEntered: false, navigationOccurred: false, documentChanged: false },
  });
  assert.equal(result.success, false);
});

// Summary
console.log(`\n🔌 Wire-Schema: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

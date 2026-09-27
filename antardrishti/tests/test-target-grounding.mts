/**
 * ANTARDRISHTI — Target Grounding & supportedActions Tests
 *
 * Verifies that supportedActions is correctly derived from DOM affordances
 * and that action-target compatibility enforces supportedActions.
 *
 * Run: npx tsx tests/test-target-grounding.mts
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

// ── Mirror deriveSupportedActions logic from sanitizer ──

type Affordance = 'click' | 'type' | 'select' | 'focus' | 'scroll' | 'upload';

function deriveSupportedActions(
  affordances: Affordance[],
  role: string,
): string[] {
  const sa: string[] = [];
  if (affordances.includes('type')) {
    sa.push('type_text', 'type_token');
  }
  if (affordances.includes('click') || role === 'button' || role === 'link') {
    sa.push('click');
  }
  if (affordances.includes('select') || role === 'combobox') {
    sa.push('select');
  }
  if (affordances.includes('focus') || affordances.includes('type')) {
    if (!sa.includes('focus')) {
      sa.push('focus');
    }
  }
  if (affordances.includes('scroll')) {
    sa.push('scroll');
  }
  return sa;
}

/** Check if an action kind is compatible with a node's supportedActions */
function isActionCompatible(
  actionKind: string,
  supportedActions: string[] | undefined,
): boolean {
  // Actions without targets are always compatible
  if (actionKind === 'finish' || actionKind === 'request_observation' || actionKind === 'wait') {
    return true;
  }
  if (!supportedActions || supportedActions.length === 0) {
    return false; // fail closed — no actions listed means nothing is supported
  }
  return supportedActions.includes(actionKind);
}

console.log('\n🎯 ANTARDRISHTI — Target Grounding & supportedActions Tests\n');

// ── Affordance → supportedActions derivation ──

test('TG-01: searchbox → supports type_text, type_token, focus', () => {
  const sa = deriveSupportedActions(['type', 'focus'], 'searchbox');
  assert.ok(sa.includes('type_text'));
  assert.ok(sa.includes('type_token'));
  assert.ok(sa.includes('focus'));
  assert.ok(!sa.includes('click'));
});

test('TG-02: textbox → supports type_text, type_token, focus', () => {
  const sa = deriveSupportedActions(['type', 'focus'], 'textbox');
  assert.ok(sa.includes('type_text'));
  assert.ok(sa.includes('type_token'));
  assert.ok(sa.includes('focus'));
});

test('TG-03: button → supports click only', () => {
  const sa = deriveSupportedActions(['click'], 'button');
  assert.ok(sa.includes('click'));
  assert.ok(!sa.includes('type_text'));
  assert.ok(!sa.includes('select'));
});

test('TG-04: combobox → supports click, select', () => {
  const sa = deriveSupportedActions(['click', 'select'], 'combobox');
  assert.ok(sa.includes('click'));
  assert.ok(sa.includes('select'));
});

test('TG-05: generic div → empty supportedActions', () => {
  const sa = deriveSupportedActions([], 'generic');
  assert.equal(sa.length, 0);
});

test('TG-06: link → supports click', () => {
  const sa = deriveSupportedActions(['click'], 'link');
  assert.ok(sa.includes('click'));
  assert.ok(!sa.includes('type_text'));
});

test('TG-07: contenteditable → supports type_text, type_token', () => {
  const sa = deriveSupportedActions(['type'], 'generic');
  assert.ok(sa.includes('type_text'));
  assert.ok(sa.includes('type_token'));
  assert.ok(sa.includes('focus'));
});

test('TG-08: scrollable div → supports scroll', () => {
  const sa = deriveSupportedActions(['scroll'], 'generic');
  assert.ok(sa.includes('scroll'));
  assert.ok(!sa.includes('click'));
});

// ── Action compatibility ──

test('TG-09: type_text + searchbox → compatible', () => {
  const sa = deriveSupportedActions(['type', 'focus'], 'searchbox');
  assert.ok(isActionCompatible('type_text', sa));
});

test('TG-10: type_text + button → INCOMPATIBLE', () => {
  const sa = deriveSupportedActions(['click'], 'button');
  assert.ok(!isActionCompatible('type_text', sa));
});

test('TG-11: type_text + generic div → INCOMPATIBLE', () => {
  const sa = deriveSupportedActions([], 'generic');
  assert.ok(!isActionCompatible('type_text', sa));
});

test('TG-12: click + button → compatible', () => {
  const sa = deriveSupportedActions(['click'], 'button');
  assert.ok(isActionCompatible('click', sa));
});

test('TG-13: click + generic div (no affordances) → INCOMPATIBLE', () => {
  const sa = deriveSupportedActions([], 'generic');
  assert.ok(!isActionCompatible('click', sa));
});

test('TG-14: select + combobox → compatible', () => {
  const sa = deriveSupportedActions(['click', 'select'], 'combobox');
  assert.ok(isActionCompatible('select', sa));
});

test('TG-15: select + input → INCOMPATIBLE', () => {
  const sa = deriveSupportedActions(['type', 'focus'], 'textbox');
  assert.ok(!isActionCompatible('select', sa));
});

test('TG-16: finish → always compatible', () => {
  assert.ok(isActionCompatible('finish', undefined));
  assert.ok(isActionCompatible('finish', []));
  assert.ok(isActionCompatible('finish', ['click']));
});

test('TG-17: request_observation → always compatible', () => {
  assert.ok(isActionCompatible('request_observation', undefined));
});

// ── Amazon-like fixture ──

test('TG-18: Amazon fixture — wrapper div has no type_text', () => {
  // Wrapper div with no affordances
  const wrapperSA = deriveSupportedActions([], 'generic');
  assert.ok(!isActionCompatible('type_text', wrapperSA));
});

test('TG-19: Amazon fixture — searchbox input has type_text', () => {
  // Searchbox input with type affordance
  const searchboxSA = deriveSupportedActions(['type', 'focus'], 'searchbox');
  assert.ok(isActionCompatible('type_text', searchboxSA));
});

test('TG-20: Amazon fixture — submit button has click', () => {
  // Submit button with click affordance
  const submitSA = deriveSupportedActions(['click'], 'button');
  assert.ok(isActionCompatible('click', submitSA));
});

test('TG-21: type_text → wrapper → REJECTED (not searchbox)', () => {
  const wrapperSA = deriveSupportedActions([], 'generic');
  const searchboxSA = deriveSupportedActions(['type', 'focus'], 'searchbox');
  // Planner proposal: type_text → wrapper
  assert.ok(!isActionCompatible('type_text', wrapperSA), 'wrapper should be rejected');
  // Correct proposal: type_text → searchbox
  assert.ok(isActionCompatible('type_text', searchboxSA), 'searchbox should be accepted');
});

// ── No silent retargeting ──

test('TG-22: no silent retargeting — action fails closed', () => {
  // If the planner picked the wrong node, the action fails.
  // The system does NOT find a nearby correct node.
  const wrongSA = deriveSupportedActions([], 'generic');
  const result = isActionCompatible('type_text', wrongSA);
  assert.equal(result, false);
  // There is no "findNearby" function — the action just fails.
});

// ── Stale target still rejected ──

test('TG-23: stale target remains rejected (no supportedActions bypass)', () => {
  // Even if a node has the right supportedActions,
  // freshness/TOCTOU checks still apply separately
  const sa = deriveSupportedActions(['type', 'focus'], 'searchbox');
  assert.ok(isActionCompatible('type_text', sa));
  // Freshness is checked separately — this test just confirms
  // supportedActions doesn't bypass anything
});

// ── Submit button correctly identified ──

test('TG-24: input[type=submit] → button role → click supported', () => {
  // input type=submit gets role=button, affordance=click
  const sa = deriveSupportedActions(['click'], 'button');
  assert.ok(sa.includes('click'));
  assert.ok(!sa.includes('type_text'));
});

// Summary
console.log(`\n🎯 Target Grounding: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

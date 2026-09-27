/**
 * ANTARDRISHTI — Action-Target Compatibility Tests
 *
 * Verifies isActionTargetCompatible() — pure check that validates
 * whether an action kind is compatible with an authoritative
 * harvest node's tag/contentEditable.
 *
 * This is NOT a retargeting mechanism. It only returns boolean.
 *
 * Run: npx tsx tests/test-action-target-compatibility.mts
 */

import { strict as assert } from 'node:assert';

// ── isActionTargetCompatible: pure compatibility check ──

interface HarvestNode {
  tag: string;
  contentEditable?: boolean | string;
  role?: string;
  inputType?: string;
}

/**
 * Check if an action kind is compatible with the authoritative
 * harvest node. Returns true only for valid combinations.
 *
 * type_text / type_token → input | textarea | contenteditable=true
 * select                 → select
 * click / focus / scroll → any (no tag restriction)
 */
function isActionTargetCompatible(kind: string, node: HarvestNode): boolean {
  if (kind === 'type_text' || kind === 'type_token') {
    return (
      node.tag === 'input'
      || node.tag === 'textarea'
      || node.contentEditable === true
      || node.contentEditable === 'true'
    );
  }
  if (kind === 'select') {
    return node.tag === 'select';
  }
  // click, focus, scroll, wait, finish, request_observation — no tag restriction
  return true;
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

console.log('\n🎯 ANTARDRISHTI — Action-Target Compatibility Tests\n');

// ── type_text compatibility ──

test('ATC-01: type_text + input → compatible', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'input' }), true);
});

test('ATC-02: type_text + textarea → compatible', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'textarea' }), true);
});

test('ATC-03: type_text + contenteditable=true → compatible', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'div', contentEditable: true }), true);
});

test('ATC-04: type_text + contenteditable="true" → compatible', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'span', contentEditable: 'true' }), true);
});

test('ATC-05: type_text + button → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'button' }), false);
});

test('ATC-06: type_text + a (link) → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'a' }), false);
});

test('ATC-07: type_text + div → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'div' }), false);
});

test('ATC-08: type_text + span → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'span' }), false);
});

test('ATC-09: type_text + label → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'label' }), false);
});

test('ATC-10: type_text + img → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'img' }), false);
});

// ── type_token compatibility ──

test('ATC-11: type_token + input → compatible', () => {
  assert.equal(isActionTargetCompatible('type_token', { tag: 'input' }), true);
});

test('ATC-12: type_token + button → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_token', { tag: 'button' }), false);
});

// ── select compatibility ──

test('ATC-13: select + select → compatible', () => {
  assert.equal(isActionTargetCompatible('select', { tag: 'select' }), true);
});

test('ATC-14: select + input → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('select', { tag: 'input' }), false);
});

test('ATC-15: select + div → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('select', { tag: 'div' }), false);
});

// ── click / focus / scroll: always compatible ──

test('ATC-16: click + button → compatible', () => {
  assert.equal(isActionTargetCompatible('click', { tag: 'button' }), true);
});

test('ATC-17: click + a → compatible', () => {
  assert.equal(isActionTargetCompatible('click', { tag: 'a' }), true);
});

test('ATC-18: click + div → compatible', () => {
  assert.equal(isActionTargetCompatible('click', { tag: 'div' }), true);
});

test('ATC-19: focus + input → compatible', () => {
  assert.equal(isActionTargetCompatible('focus', { tag: 'input' }), true);
});

test('ATC-20: scroll + div → compatible', () => {
  assert.equal(isActionTargetCompatible('scroll', { tag: 'div' }), true);
});

// ── Edge cases ──

test('ATC-21: type_text + contentEditable=false → INCOMPATIBLE', () => {
  assert.equal(isActionTargetCompatible('type_text', { tag: 'div', contentEditable: false }), false);
});

test('ATC-22: finish → always compatible', () => {
  assert.equal(isActionTargetCompatible('finish', { tag: 'body' }), true);
});

test('ATC-23: request_observation → always compatible', () => {
  assert.equal(isActionTargetCompatible('request_observation', { tag: 'body' }), true);
});

// ── No retargeting test ──

test('ATC-24: incompatible target is reported, not silently changed', () => {
  const result = isActionTargetCompatible('type_text', { tag: 'button', role: 'button' });
  assert.equal(result, false);
  // The function only returns boolean — it does NOT modify the action
});

// Summary
console.log(`\n🎯 Action-Target Compatibility: ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

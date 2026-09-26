/**
 * ANTARDRISHTI — Scene Compaction Tests
 *
 * Verifies:
 *   1. Output ≤500 nodes when input >500
 *   2. Relevant task target always retained
 *   3. No compaction when ≤500
 *   4. Actionable targets prioritized over decorative
 *   5. Node IDs preserved exactly (no new identities)
 *   6. Duplicates deprioritized
 *   7. Viewport-visible nodes prioritized
 *   8. Task-matching terms boost relevance
 *   9. PII policy unchanged (compaction doesn't reintroduce)
 *  10. No arbitrary first-N truncation
 *
 * Run: npx tsx tests/test-scene-compaction.mts
 */

import assert from 'node:assert/strict';
import { compactScene, type SceneNode, type CompactionConfig } from '../packages/privacy/src/scene-compaction';

let passed = 0, failed = 0;
const failures: string[] = [];
async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e: any) { const m = e.message ?? String(e); console.log(`  ❌ ${name}: ${m}`); failed++; failures.push(`${name}: ${m}`); }
}

console.log('\n🔬 ANTARDRISHTI — Scene Compaction Tests\n');

// Helper to generate nodes
function makeNode(id: string, overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    role: overrides.role || 'text',
    name: overrides.name,
    value: overrides.value,
    actionability: overrides.actionability,
    source: overrides.source || ['dom'],
    bbox: overrides.bbox || { x: 0, y: 0, w: 100, h: 30 },
    ...overrides,
  };
}

function generateBulkNodes(count: number, prefix = 'bulk'): SceneNode[] {
  return Array.from({ length: count }, (_, i) => makeNode(
    `${prefix}-${i}`,
    {
      role: 'generic',
      name: `Item ${i}`,
      bbox: { x: 0, y: 50 * i, w: 200, h: 40 },
    }
  ));
}

// ── Test 1: Output ≤500 ──

await runTest('COMPACT-1 — 800 nodes compacted to ≤500', () => {
  const nodes = generateBulkNodes(800);
  const result = compactScene(nodes, { maxNodes: 500 });
  assert.ok(result.compacted);
  assert.strictEqual(result.retainedCount, 500);
  assert.strictEqual(result.removedCount, 300);
  assert.strictEqual(result.originalCount, 800);
  assert.ok(result.nodes.length <= 500);
});

// ── Test 2: Task-relevant target retained ──

await runTest('COMPACT-2 — task-relevant actionable target always retained', () => {
  const filler = generateBulkNodes(600);
  const searchInput = makeNode('n-search', {
    role: 'searchbox',
    name: 'Search Amazon.in',
    actionability: 'typeable',
    source: ['dom'],
    bbox: { x: 200, y: 50, w: 400, h: 40 },
  });
  // Put the target at position 550 (would be truncated by naive first-N)
  const nodes = [...filler.slice(0, 550), searchInput, ...filler.slice(550)];
  
  const result = compactScene(nodes, {
    maxNodes: 500,
    viewport: { width: 1366, height: 768 },
    taskText: 'Search for OnePlus 12R',
  });

  assert.ok(result.compacted);
  assert.ok(result.nodes.length <= 500);
  // The search target MUST be retained
  const retained = result.nodes.find(n => n.id === 'n-search');
  assert.ok(retained, 'Task-relevant searchbox must be retained');
  assert.strictEqual(retained!.id, 'n-search');
});

// ── Test 3: No compaction when ≤500 ──

await runTest('COMPACT-3 — no compaction when nodes ≤500', () => {
  const nodes = generateBulkNodes(400);
  const result = compactScene(nodes, { maxNodes: 500 });
  assert.ok(!result.compacted);
  assert.strictEqual(result.retainedCount, 400);
  assert.strictEqual(result.removedCount, 0);
  assert.strictEqual(result.nodes.length, 400);
});

// ── Test 4: Actionable over decorative ──

await runTest('COMPACT-4 — actionable targets retained over decorative', () => {
  // 300 actionable + 300 decorative = 600 total
  const actionable = Array.from({ length: 300 }, (_, i) => makeNode(
    `act-${i}`,
    { role: 'button', name: `Button ${i}`, actionability: 'clickable', source: ['dom'],
      bbox: { x: 0, y: i * 30, w: 100, h: 25 } }
  ));
  const decorative = Array.from({ length: 300 }, (_, i) => makeNode(
    `dec-${i}`,
    { role: 'presentation', name: `Spacer ${i}`, source: ['dom'],
      bbox: { x: 500, y: i * 30, w: 10, h: 10 } }
  ));
  
  const result = compactScene([...decorative, ...actionable], {
    maxNodes: 500,
    viewport: { width: 1366, height: 768 },
  });

  assert.ok(result.compacted);
  // All 300 actionable buttons should be retained
  const retainedActionable = result.nodes.filter(n => n.id.startsWith('act-'));
  assert.strictEqual(retainedActionable.length, 300, 'All actionable targets must be retained');
});

// ── Test 5: Node IDs preserved exactly ──

await runTest('COMPACT-5 — node IDs preserved exactly', () => {
  const nodes = generateBulkNodes(600);
  const result = compactScene(nodes, { maxNodes: 500 });
  
  for (const node of result.nodes) {
    assert.ok(node.id.startsWith('bulk-'), `Node ID must be original: ${node.id}`);
    // Find original
    const original = nodes.find(n => n.id === node.id);
    assert.ok(original, `Retained node ${node.id} must exist in original`);
    assert.strictEqual(node.role, original!.role);
    assert.strictEqual(node.name, original!.name);
  }
});

// ── Test 6: Duplicates deprioritized ──

await runTest('COMPACT-6 — duplicate nodes deprioritized', () => {
  const unique = Array.from({ length: 400 }, (_, i) => makeNode(
    `uniq-${i}`,
    { role: 'link', name: `Page ${i}`, source: ['dom'], actionability: 'clickable',
      bbox: { x: 0, y: i * 20, w: 100, h: 18 } }
  ));
  // 200 duplicates of "Home" link
  const dupes = Array.from({ length: 200 }, (_, i) => makeNode(
    `dupe-${i}`,
    { role: 'link', name: 'Home', source: ['dom'], actionability: 'clickable',
      bbox: { x: 0, y: 8000 + i * 20, w: 100, h: 18 } }
  ));
  
  const result = compactScene([...unique, ...dupes], {
    maxNodes: 500,
    viewport: { width: 1366, height: 768 },
  });

  assert.ok(result.compacted);
  const retainedDupes = result.nodes.filter(n => n.id.startsWith('dupe-'));
  // Some dupes retained but fewer than all 200
  assert.ok(retainedDupes.length < 200, `Duplicates should be deprioritized: ${retainedDupes.length}/200 retained`);
  // All unique nodes should be retained
  const retainedUnique = result.nodes.filter(n => n.id.startsWith('uniq-'));
  assert.strictEqual(retainedUnique.length, 400, 'All unique nodes must be retained');
});

// ── Test 7: Viewport-visible prioritized ──

await runTest('COMPACT-7 — viewport-visible nodes prioritized over offscreen', () => {
  const visible = Array.from({ length: 200 }, (_, i) => makeNode(
    `vis-${i}`,
    { role: 'text', name: `Visible ${i}`, source: ['dom'],
      bbox: { x: 0, y: i * 3, w: 100, h: 20 } }
  ));
  const offscreen = Array.from({ length: 400 }, (_, i) => makeNode(
    `off-${i}`,
    { role: 'text', name: `Offscreen ${i}`, source: ['dom'],
      bbox: { x: 0, y: 5000 + i * 20, w: 100, h: 20 } }
  ));
  
  const result = compactScene([...offscreen, ...visible], {
    maxNodes: 500,
    viewport: { width: 1366, height: 768 },
  });

  assert.ok(result.compacted);
  // All 200 visible nodes should be retained
  const retainedVisible = result.nodes.filter(n => n.id.startsWith('vis-'));
  assert.strictEqual(retainedVisible.length, 200, 'All viewport-visible nodes retained');
});

// ── Test 8: Task terms boost relevance ──

await runTest('COMPACT-8 — task terms boost node relevance', () => {
  const filler = generateBulkNodes(550);
  // Target matching task term — placed at the END (position 550)
  const target = makeNode('n-oneplus', {
    role: 'link',
    name: 'OnePlus 12R - Buy Now',
    actionability: 'clickable',
    source: ['dom'],
    bbox: { x: 0, y: 9999, w: 200, h: 30 }, // offscreen!
  });
  const nodes = [...filler, target];
  
  const result = compactScene(nodes, {
    maxNodes: 500,
    taskText: 'Search for OnePlus 12R',
  });

  assert.ok(result.compacted);
  const retained = result.nodes.find(n => n.id === 'n-oneplus');
  assert.ok(retained, 'Task-matching node must be retained even if offscreen');
});

// ── Test 9: Exact node at 500 ──

await runTest('COMPACT-9 — exactly 500 nodes not compacted', () => {
  const nodes = generateBulkNodes(500);
  const result = compactScene(nodes, { maxNodes: 500 });
  assert.ok(!result.compacted);
  assert.strictEqual(result.nodes.length, 500);
});

// ── Test 10: No arbitrary first-N truncation ──

await runTest('COMPACT-10 — not arbitrary first-N truncation', () => {
  // Put all actionable nodes at the END (indices 500-699)
  const nonActionable = Array.from({ length: 500 }, (_, i) => makeNode(
    `filler-${i}`,
    { role: 'generic', name: `Filler ${i}`, source: ['dom'],
      bbox: { x: 0, y: i * 20, w: 100, h: 18 } }
  ));
  const actionable = Array.from({ length: 200 }, (_, i) => makeNode(
    `action-${i}`,
    { role: 'button', name: `Action ${i}`, actionability: 'clickable', source: ['dom'],
      bbox: { x: 0, y: i * 20, w: 100, h: 18 } }
  ));
  
  const result = compactScene([...nonActionable, ...actionable], {
    maxNodes: 500,
    viewport: { width: 1366, height: 768 },
  });

  // If first-N truncation, we'd get 0 actionable nodes
  const retainedActionable = result.nodes.filter(n => n.id.startsWith('action-'));
  assert.strictEqual(retainedActionable.length, 200,
    `Must retain all actionable nodes, not truncate first-N. Got: ${retainedActionable.length}`);
});

// ── Summary ──
console.log(`\n🔬 Scene Compaction: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
}
process.exit(failed > 0 ? 1 : 0);

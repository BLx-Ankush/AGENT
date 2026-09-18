/**
 * ANTARDRISHTI — P0-B Node Identity Tests
 *
 * Verifies the invariant:
 *
 *   P0-B: nodeId → exact HTMLElement observed during THIS harvest.
 *
 * The harvester assigns nodeId during its single traversal and stores
 * nodeId → HTMLElement locally. The executor consumes a copy of that
 * authoritative map. The executor NEVER generates node IDs independently.
 *
 * These tests do NOT cover stale-plan/freshness rejection (that is P1-C).
 *
 * Run: npx tsx tests/test-node-identity.mts
 */

import assert from 'node:assert/strict';

// ── JSDOM setup ─────────────────────────────────────────────

import { JSDOM } from 'jsdom';

/**
 * Fixture HTML with elements that cause divergence under the old
 * independent-counter approach.
 *
 * <div id="d1">, <span id="s1">, and <p id="p1"> are harvested by the
 * TreeWalker but would be SKIPPED by the old executor's CSS selector,
 * shifting all subsequent IDs.
 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>P0-B Fixture</title></head>
<body>
  <div id="d1">Text content</div>
  <button id="b1">Click me</button>
  <span id="s1">Label text</span>
  <input id="i1" type="text" value="">
  <p id="p1">Paragraph</p>
  <a id="a1" href="#">Link</a>
  <select id="sel1"><option value="opt1">Option 1</option></select>
  <textarea id="ta1">Editable</textarea>
</body></html>`;

function createDOM(): JSDOM {
  const dom = new JSDOM(FIXTURE_HTML, {
    url: 'https://example.com',
    pretendToBeVisual: true,
  });

  let posCounter = 0;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const pos = posCounter++;
    return {
      x: 10, y: 10 + pos * 40, width: 100, height: 30,
      top: 10 + pos * 40, left: 10, bottom: 40 + pos * 40, right: 110,
      toJSON() { return this; },
    } as DOMRect;
  };

  (dom.window as Record<string, unknown>).getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    zIndex: '0',
  });

  Object.defineProperty(dom.window, 'innerWidth', { value: 1024 });
  Object.defineProperty(dom.window, 'innerHeight', { value: 768 });

  return dom;
}

/**
 * Install all JSDOM globals the harvester and executor need.
 * Returns previous values for restoration.
 */
function installDOMGlobals(dom: JSDOM): Record<string, unknown> {
  const saved: Record<string, unknown> = {};
  const globals: Record<string, unknown> = {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLImageElement: dom.window.HTMLImageElement,
    NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    // CSS.escape is used by the harvester for label[for] queries
    CSS: (dom.window as Record<string, unknown>).CSS ?? { escape: (s: string) => s },
  };
  for (const [key, val] of Object.entries(globals)) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = val;
  }
  return saved;
}

function restoreDOMGlobals(saved: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(saved)) {
    (globalThis as Record<string, unknown>)[key] = val;
  }
}

// ── Test runner ─────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ ${name}: ${msg}`);
    failed++;
    failures.push(`${name}: ${msg}`);
  }
}

// ── Tests ───────────────────────────────────────────────────

console.log('\n🔗 ANTARDRISHTI — P0-B Node Identity Tests\n');

// ── NI-01 ───────────────────────────────────────────────────

console.log('── Harvest → Element Map Consistency ──');

await runTest('NI-01: harvestDOM SceneNode IDs exactly match getLastHarvestElementMap keys', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');
    const result = harvestDOM('obs-ni01', 'doc-ni01', 0);
    const elementMap = getLastHarvestElementMap();

    const sceneIds = new Set(result.nodes.map((n: { id: string }) => n.id));
    const mapKeys = new Set(elementMap.keys());

    assert.deepStrictEqual(sceneIds, mapKeys,
      `SceneNode IDs ${JSON.stringify([...sceneIds])} ≠ map keys ${JSON.stringify([...mapKeys])}`);
    assert(sceneIds.size > 0, 'Harvest must produce at least one node');
    console.log(`    Harvested ${sceneIds.size} nodes, map has ${mapKeys.size} entries`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-02 ───────────────────────────────────────────────────

await runTest('NI-02: setNodeRegistry + executeAction resolves to the exact harvested element', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');
    const { setNodeRegistry, executeAction } = await import('../apps/extension/src/content/action-executor');

    const result = harvestDOM('obs-ni02', 'doc-ni02', 0);
    setNodeRegistry(getLastHarvestElementMap(), 'doc-ni02');

    const inputNode = result.nodes.find((n: { tag: string }) => n.tag === 'input');
    assert(inputNode, 'Harvest must include <input>');

    const actionResult = await executeAction({
      actionId: 'test-ni02', kind: 'type_text',
      targetNodeId: inputNode.id, value: 'NI02-test-value',
    });

    assert.strictEqual(actionResult.success, true, `Action failed: ${actionResult.error}`);
    const inputEl = dom.window.document.getElementById('i1') as HTMLInputElement;
    assert.strictEqual(inputEl?.value, 'NI02-test-value',
      `Expected input#i1 value "NI02-test-value", got "${inputEl?.value}"`);
    console.log(`    Typed into ${inputNode.id} → input#i1.value = "${inputEl.value}"`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-03 ───────────────────────────────────────────────────

await runTest('NI-03: getLastHarvestElementMap().size === result.nodes.length', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');
    const result = harvestDOM('obs-ni03', 'doc-ni03', 0);
    const elementMap = getLastHarvestElementMap();
    assert.strictEqual(elementMap.size, result.nodes.length,
      `Map size (${elementMap.size}) ≠ node count (${result.nodes.length})`);
    console.log(`    ${elementMap.size} entries, ${result.nodes.length} nodes`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-04 ───────────────────────────────────────────────────

console.log('\n── Harvest Replacement ──');

await runTest('NI-04: Second harvest completely replaces the previous element map', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');

    harvestDOM('obs-ni04a', 'doc-ni04a', 0);
    const keys1 = new Set(getLastHarvestElementMap().keys());

    const result2 = harvestDOM('obs-ni04b', 'doc-ni04b', 0);

    assert.strictEqual(getLastHarvestElementMap().size, result2.nodes.length);
    for (const node of result2.nodes) {
      assert(getLastHarvestElementMap().has(node.id), `Node ${node.id} missing from map`);
    }
    assert.deepStrictEqual(
      new Set(getLastHarvestElementMap().keys()),
      new Set(result2.nodes.map((n: { id: string }) => n.id)),
    );
    console.log(`    Harvest 1: ${keys1.size}, Harvest 2: ${getLastHarvestElementMap().size} — map is second harvest`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-05 ───────────────────────────────────────────────────

console.log('\n── Negative Cases ──');

await runTest('NI-05: executeAction returns failure for ID not in registry', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');
    const { setNodeRegistry, executeAction } = await import('../apps/extension/src/content/action-executor');

    harvestDOM('obs-ni05', 'doc-ni05', 0);
    setNodeRegistry(getLastHarvestElementMap(), 'doc-ni05');

    const result = await executeAction({
      actionId: 'test-ni05', kind: 'click', targetNodeId: 'node-99999',
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.outcome, 'failure');
    assert(result.error?.includes('not found'), `Expected "not found": ${result.error}`);
    console.log(`    node-99999 → failure: "${result.error}"`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-06 ───────────────────────────────────────────────────

await runTest('NI-06: executeAction returns failure for vis-* visual node IDs', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');
    const { setNodeRegistry, executeAction } = await import('../apps/extension/src/content/action-executor');

    harvestDOM('obs-ni06', 'doc-ni06', 0);
    setNodeRegistry(getLastHarvestElementMap(), 'doc-ni06');

    const result = await executeAction({
      actionId: 'test-ni06', kind: 'click', targetNodeId: 'vis-abc12345-1',
    });
    assert.strictEqual(result.success, false, 'vis-* node should not be executable');
    assert.strictEqual(result.outcome, 'failure');
    console.log(`    vis-abc12345-1 → failure (fail-closed): "${result.error}"`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-07 ───────────────────────────────────────────────────

console.log('\n── Adversarial ──');

await runTest('NI-07: Independent counter approach produces DIFFERENT element mappings (proves P0-B was necessary)', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');

    harvestDOM('obs-ni07', 'doc-ni07', 0);
    const harvesterMap = getLastHarvestElementMap();

    // Simulate the OLD rebuildNodeRegistry approach locally
    const oldApproachMap = new Map<string, Element>();
    let counter = 0;
    const selector =
      'a, button, input, select, textarea, [role], [tabindex], ' +
      'label, img, h1, h2, h3, h4, h5, h6, canvas, svg, nav, ' +
      'main, header, footer, aside, form, dialog, progress, meter';

    for (const el of dom.window.document.querySelectorAll(selector)) {
      if (!(el instanceof dom.window.HTMLElement)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = dom.window.getComputedStyle(el);
      if (style.display === 'none') continue;
      oldApproachMap.set(`node-${++counter}`, el);
    }

    assert(oldApproachMap.size < harvesterMap.size,
      `Old approach (${oldApproachMap.size}) should have fewer entries than harvester (${harvesterMap.size})`);

    let divergenceFound = false;
    for (const [nodeId, harvesterEl] of harvesterMap) {
      const oldEl = oldApproachMap.get(nodeId);
      if (oldEl && oldEl !== harvesterEl) {
        divergenceFound = true;
        console.log(
          `    DIVERGENCE at ${nodeId}: ` +
          `harvester→<${(harvesterEl as Element).tagName.toLowerCase()} id="${harvesterEl.id}"> ` +
          `vs old→<${oldEl.tagName.toLowerCase()} id="${(oldEl as HTMLElement).id}">`,
        );
        break;
      }
    }

    assert(divergenceFound,
      'Expected divergence — this proves the P0-B fix was necessary');
    console.log(`    Harvester: ${harvesterMap.size}, Old: ${oldApproachMap.size}`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── NI-08 ───────────────────────────────────────────────────

console.log('\n── Security Boundary ──');

await runTest('NI-08: nodeId resolves to the exact harvested element, not merely same numeric position', async () => {
  const dom = createDOM();
  const saved = installDOMGlobals(dom);
  try {
    const { harvestDOM, getLastHarvestElementMap } = await import('@antardrishti/scene-graph');
    const { setNodeRegistry, executeAction } = await import('../apps/extension/src/content/action-executor');

    const result = harvestDOM('obs-ni08', 'doc-ni08', 0);
    const elementMap = getLastHarvestElementMap();
    setNodeRegistry(elementMap, 'doc-ni08');

    const inputNode = result.nodes.find((n: { tag: string }) => n.tag === 'input');
    assert(inputNode, 'Must find input node');

    const harvesterEl = elementMap.get(inputNode.id);
    assert(harvesterEl, `Element map must have ${inputNode.id}`);

    // Verify exact DOM object identity
    const actualInputEl = dom.window.document.getElementById('i1');
    assert.strictEqual(harvesterEl, actualInputEl,
      `nodeId ${inputNode.id} must map to input#i1 by object identity`);

    // Verify correct DOM element was modified through executeAction
    const actionResult = await executeAction({
      actionId: 'test-ni08', kind: 'type_text',
      targetNodeId: inputNode.id, value: 'security-boundary-test',
    });
    assert.strictEqual(actionResult.success, true);
    assert.strictEqual((actualInputEl as HTMLInputElement).value, 'security-boundary-test',
      'Must modify the exact element, not an element at the same numeric position');

    console.log(`    ${inputNode.id} → input#i1 (object identity ✓) → value="${(actualInputEl as HTMLInputElement).value}"`);
  } finally {
    restoreDOMGlobals(saved);
  }
});

// ── Summary ─────────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
if (failed === 0) {
  console.log(`\n✅ P0-B Node Identity: ${passed} passed, ${failed} failed\n`);
} else {
  console.log(`\n❌ FAILED: ${failed} test(s)`);
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
  console.log();
  process.exit(1);
}

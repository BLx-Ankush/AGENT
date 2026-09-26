/**
 * ANTARDRISHTI — Scene Compaction
 *
 * General relevance-aware compaction that reduces large real-world page
 * scenes to fit the planner wire budget (max 500 nodes) without
 * site-specific rules.
 *
 * Runs AFTER sanitization — never before privacy classification.
 * Preserves node IDs/fingerprints exactly; creates no new execution identities.
 *
 * Priority tiers (highest first):
 *   1. Task-relevant actionable targets (name/role matches task terms)
 *   2. Actionable DOM targets (clickable, typeable, selectable)
 *   3. Viewport-visible targets (bbox within viewport)
 *   4. High-confidence visual↔DOM reconciled nodes
 *   5. Navigation/form controls
 *   6. Context/ancestor nodes for understanding target structure
 *   7. Informational nodes (headings, labels, landmarks)
 *   8. Offscreen / decorative / redundant nodes
 */

export interface SceneNode {
  id: string;
  role: string;
  name?: string;
  value?: string;
  actionability?: string;
  source?: string[];
  bbox?: { x: number; y: number; w: number; h: number };
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CompactionConfig {
  maxNodes: number;
  viewport?: { width: number; height: number };
  taskText?: string;
}

export interface CompactionResult {
  nodes: SceneNode[];
  compacted: boolean;
  originalCount: number;
  retainedCount: number;
  removedCount: number;
  tiers: Record<string, number>;
}

const ACTIONABLE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'treeitem',
]);

const ACTIONABLE_STATES = new Set([
  'clickable', 'typeable', 'selectable', 'focusable',
  'editable', 'checkable', 'toggleable',
]);

const NAV_FORM_ROLES = new Set([
  'navigation', 'search', 'form', 'menu', 'menubar',
  'toolbar', 'tablist',
]);

const STRUCTURE_ROLES = new Set([
  'heading', 'banner', 'main', 'contentinfo',
  'complementary', 'region', 'landmark', 'alert',
  'status', 'dialog', 'alertdialog', 'label',
]);

const LOW_INFO_ROLES = new Set([
  'presentation', 'none', 'separator', 'generic',
  'group', 'list', 'listitem', 'paragraph',
  'figure', 'img', 'image',
]);

/**
 * Extract lowercase task terms for relevance matching.
 * Strips common stop words and short tokens.
 */
function extractTaskTerms(taskText: string): Set<string> {
  const STOP = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'click', 'type', 'enter', 'search', 'find', 'go', 'open', 'navigate']);
  const terms = new Set<string>();
  const words = taskText.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  for (const w of words) {
    if (w.length >= 2 && !STOP.has(w)) {
      terms.add(w);
    }
  }
  return terms;
}

/**
 * Check if a node's text (name/value/role) matches any task terms.
 */
function matchesTaskTerms(node: SceneNode, terms: Set<string>): boolean {
  if (terms.size === 0) return false;
  const text = `${node.name || ''} ${node.value || ''} ${node.role || ''}`.toLowerCase();
  for (const term of terms) {
    if (text.includes(term)) return true;
  }
  return false;
}

function isActionable(node: SceneNode): boolean {
  if (ACTIONABLE_ROLES.has(node.role)) return true;
  if (node.actionability && ACTIONABLE_STATES.has(node.actionability)) return true;
  return false;
}

function isInViewport(node: SceneNode, vp: { width: number; height: number }): boolean {
  if (!node.bbox) return false;
  const { x, y, w, h } = node.bbox;
  // Node is at least partially visible in the viewport (with generous margin)
  const margin = 100;
  return x + w > -margin && y + h > -margin && x < vp.width + margin && y < vp.height + margin;
}

function isDomSource(node: SceneNode): boolean {
  if (!node.source) return false;
  return node.source.includes('dom') || node.source.includes('a11y');
}

function isVisualReconciled(node: SceneNode): boolean {
  if (!node.source) return false;
  return node.source.includes('dom') && node.source.includes('vision');
}

/**
 * Detect redundant/duplicate nodes by name+role.
 * Returns a set of node IDs that are duplicates (keeping first occurrence).
 */
function findDuplicates(nodes: SceneNode[]): Set<string> {
  const seen = new Map<string, string>(); // key -> first node ID
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (!node.name) continue;
    const key = `${node.role}:${node.name.toLowerCase().trim()}`;
    if (seen.has(key)) {
      duplicates.add(node.id);
    } else {
      seen.set(key, node.id);
    }
  }
  return duplicates;
}

/**
 * Compact a scene's nodes to fit within maxNodes budget.
 *
 * Assigns each node a priority tier (0 = highest), then retains
 * nodes in tier order until the budget is filled.
 *
 * Returns a new array; does NOT mutate the input.
 */
export function compactScene(
  nodes: SceneNode[],
  config: CompactionConfig,
): CompactionResult {
  const { maxNodes, viewport, taskText } = config;

  // No compaction needed
  if (nodes.length <= maxNodes) {
    return {
      nodes: [...nodes],
      compacted: false,
      originalCount: nodes.length,
      retainedCount: nodes.length,
      removedCount: 0,
      tiers: {},
    };
  }

  const taskTerms = taskText ? extractTaskTerms(taskText) : new Set<string>();
  const duplicates = findDuplicates(nodes);

  // Assign each node a priority tier (lower = higher priority)
  const scored: Array<{ node: SceneNode; tier: number }> = [];

  for (const node of nodes) {
    let tier: number;

    const actionable = isActionable(node);
    const taskMatch = matchesTaskTerms(node, taskTerms);
    const inViewport = viewport ? isInViewport(node, viewport) : true;
    const reconciled = isVisualReconciled(node);
    const isDom = isDomSource(node);
    const isDuplicate = duplicates.has(node.id);

    if (taskMatch && actionable) {
      // Tier 0: Task-relevant actionable targets — MUST keep
      tier = 0;
    } else if (actionable && inViewport && isDom) {
      // Tier 1: Viewport-visible actionable DOM targets
      tier = 1;
    } else if (actionable && isDom) {
      // Tier 2: Offscreen actionable DOM targets
      tier = 2;
    } else if (reconciled && inViewport) {
      // Tier 3: Visual↔DOM reconciled viewport nodes
      tier = 3;
    } else if (NAV_FORM_ROLES.has(node.role)) {
      // Tier 4: Navigation/form structure
      tier = 4;
    } else if (taskMatch) {
      // Tier 5: Task-relevant non-actionable (labels, headings matching task)
      tier = 5;
    } else if (STRUCTURE_ROLES.has(node.role) && inViewport) {
      // Tier 6: Structural landmarks in viewport
      tier = 6;
    } else if (isDom && inViewport && !isDuplicate) {
      // Tier 7: Visible non-actionable DOM nodes (unique)
      tier = 7;
    } else if (isDom && !isDuplicate) {
      // Tier 8: Offscreen non-actionable DOM nodes (unique)
      tier = 8;
    } else if (!isDom && inViewport && !isDuplicate) {
      // Tier 9: Visual-only viewport nodes (unique)
      tier = 9;
    } else if (isDuplicate) {
      // Tier 10: Duplicates
      tier = 10;
    } else {
      // Tier 11: Everything else (offscreen visual-only, decorative, etc.)
      tier = 11;
    }

    scored.push({ node, tier });
  }

  // Sort by tier (ascending = highest priority first)
  // Within same tier, preserve original order
  scored.sort((a, b) => a.tier - b.tier);

  // Take up to maxNodes
  const retained = scored.slice(0, maxNodes);
  const tierCounts: Record<string, number> = {};
  for (const { tier } of retained) {
    const key = `tier${tier}`;
    tierCounts[key] = (tierCounts[key] || 0) + 1;
  }

  return {
    nodes: retained.map(s => s.node),
    compacted: true,
    originalCount: nodes.length,
    retainedCount: retained.length,
    removedCount: nodes.length - retained.length,
    tiers: tierCounts,
  };
}

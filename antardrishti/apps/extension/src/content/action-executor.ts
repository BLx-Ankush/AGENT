/**
 * ANTARDRISHTI — Local Action Executor
 *
 * Executes validated, typed actions in the content script context.
 * Actions MUST have been validated by the ActionValidator before
 * reaching this module.
 *
 * Typed actions only — no eval, no arbitrary JS, no selectors.
 * The executor uses the scene-graph node registry to resolve
 * action targets by stable node ID.
 */

import {
  type TargetFingerprint,
  createTargetFingerprint,
  verifyTargetFingerprint,
} from '@antardrishti/protocol-v2';
import {
  computeAncestryFingerprint,
  inferRole as sceneGraphInferRole,
  computeAccessibleName as sceneGraphComputeAccessibleName,
  getAncestorTags,
} from '@antardrishti/scene-graph';

// ── Node registry (populated by harvester) ───────────────────

const nodeRegistry = new Map<string, HTMLElement>();
let registryGeneration = '';

/**
 * Install the authoritative nodeId → HTMLElement registry produced
 * by the harvester during harvestDOM().
 *
 * P0-B invariant: nodeId → exact HTMLElement observed during THIS harvest.
 * The executor NEVER generates node IDs independently.
 *
 * Entries are copied so the executor holds its own snapshot and is not
 * affected if the harvester's internal map is cleared on next harvest.
 */
export function setNodeRegistry(
  registry: ReadonlyMap<string, HTMLElement>,
  documentGeneration: string,
): void {
  nodeRegistry.clear();
  registryGeneration = documentGeneration;
  for (const [id, el] of registry) {
    nodeRegistry.set(id, el);
  }
  console.log(`[Executor] Registry set from harvester: ${nodeRegistry.size} nodes (gen=${documentGeneration})`);
}

// ── Target-bound action kinds ────────────────────────────────

const TARGET_BOUND_KINDS = new Set([
  'click', 'focus', 'type_text', 'type_token', 'select',
]);

// ── Action result ────────────────────────────────────────────

export interface ActionResult {
  actionId: string;
  success: boolean;
  outcome: 'success' | 'failure' | 'ambiguous' | 'navigated' | 'rejected' | 'toctou_rejected';
  newDocumentGeneration?: string;
  error?: string;
}

// ── Execute action ───────────────────────────────────────────

export async function executeAction(payload: {
  actionId: string;
  kind: string;
  targetNodeId?: string;
  value?: string;
  expectedRole?: string;
  expectedFingerprint?: TargetFingerprint;
}): Promise<ActionResult> {
  const { actionId, kind, targetNodeId, value, expectedRole, expectedFingerprint } = payload;

  // P1-C: Fail closed if target-bound action is missing expectedFingerprint
  if (TARGET_BOUND_KINDS.has(kind) && targetNodeId) {
    if (!expectedFingerprint) {
      return {
        actionId,
        success: false,
        outcome: 'toctou_rejected',
        error: 'P1-C: missing expectedFingerprint for target-bound action — fail closed',
      };
    }
    if (!expectedFingerprint.nodeId || !expectedFingerprint.role) {
      return {
        actionId,
        success: false,
        outcome: 'toctou_rejected',
        error: 'P1-C: malformed expectedFingerprint — fail closed',
      };
    }
  }

  try {
    switch (kind) {
      case 'click':
        return await executeClick(actionId, targetNodeId!, expectedRole, expectedFingerprint!);

      case 'focus':
        return executeFocus(actionId, targetNodeId!, expectedFingerprint!);

      case 'type_text':
        return executeTypeText(actionId, targetNodeId!, value || '', expectedFingerprint!);

      case 'type_token':
        return executeTypeToken(actionId, targetNodeId!, value || '', expectedFingerprint!);

      case 'select':
        return executeSelect(actionId, targetNodeId!, value || '', expectedFingerprint!);

      case 'scroll':
        return executeScroll(actionId, targetNodeId || undefined, value || 'down:small');

      case 'wait':
        return await executeWait(actionId, parseInt(value || '1000'));

      case 'request_observation':
        return { actionId, success: true, outcome: 'success' };

      case 'finish':
        return { actionId, success: true, outcome: 'success' };

      default:
        return {
          actionId,
          success: false,
          outcome: 'rejected',
          error: `Unknown action kind: ${kind}`,
        };
    }
  } catch (e) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: `Execution error: ${e}`,
    };
  }
}

// ── Action implementations ───────────────────────────────────

async function executeClick(
  actionId: string,
  targetNodeId: string,
  expectedRole: string | undefined,
  expectedFingerprint: TargetFingerprint,
): Promise<ActionResult> {
  const el = resolveTarget(targetNodeId);
  if (!el) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: `Target not found: ${targetNodeId}`,
    };
  }

  // Verify role if expected
  if (expectedRole) {
    const actualRole = el.getAttribute('role') || sceneGraphInferRole(el);
    if (actualRole !== expectedRole && expectedRole !== 'generic') {
      console.warn(
        `[Executor] Role mismatch: expected ${expectedRole}, got ${actualRole}`,
      );
    }
  }

  // Verify element is clickable via hit-test
  const rect = el.getBoundingClientRect();
  const hitEl = document.elementFromPoint(
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  );

  if (hitEl && !el.contains(hitEl) && !hitEl.contains(el)) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: 'Click target obscured by another element',
    };
  }

  // Scroll into view if needed
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(200);

  // P1-C TOCTOU: Final verification IMMEDIATELY before DOM mutation
  const toctouError = verifyTargetBeforeExecution(targetNodeId, expectedFingerprint);
  if (toctouError) {
    return { actionId, success: false, outcome: 'toctou_rejected', error: toctouError };
  }

  // Dispatch click events
  el.focus();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.click();

  // Check for navigation
  await sleep(100);
  const navigated = false; // Navigation detection via message from observer

  return {
    actionId,
    success: true,
    outcome: navigated ? 'navigated' : 'success',
  };
}

function executeFocus(
  actionId: string,
  targetNodeId: string,
  expectedFingerprint: TargetFingerprint,
): ActionResult {
  const el = resolveTarget(targetNodeId);
  if (!el) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: `Target not found: ${targetNodeId}`,
    };
  }

  // P1-C TOCTOU: Final verification IMMEDIATELY before focus
  const toctouError = verifyTargetBeforeExecution(targetNodeId, expectedFingerprint);
  if (toctouError) {
    return { actionId, success: false, outcome: 'toctou_rejected', error: toctouError };
  }

  el.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return { actionId, success: true, outcome: 'success' };
}

function executeTypeText(
  actionId: string,
  targetNodeId: string,
  text: string,
  expectedFingerprint: TargetFingerprint,
): ActionResult {
  const el = resolveTarget(targetNodeId);
  if (!el) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: `Target not found: ${targetNodeId}`,
    };
  }

  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el.getAttribute('contenteditable') === 'true'
    )
  ) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: 'Target is not a text input',
    };
  }

  // P1-C TOCTOU: Final verification IMMEDIATELY before value mutation
  const toctouError = verifyTargetBeforeExecution(targetNodeId, expectedFingerprint);
  if (toctouError) {
    return { actionId, success: false, outcome: 'toctou_rejected', error: toctouError };
  }

  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  return { actionId, success: true, outcome: 'success' };
}

function executeTypeToken(
  actionId: string,
  targetNodeId: string,
  token: string,
  expectedFingerprint: TargetFingerprint,
): ActionResult {
  // Token typing uses the same mechanism as type_text.
  // The actual value is redeemed from the vault by the coordinator
  // before being passed here. The executor only sees the raw value
  // AFTER capability redemption succeeds.
  //
  // At this point, `token` is actually the redeemed raw value
  // (the coordinator handles the redemption step).
  return executeTypeText(actionId, targetNodeId, token, expectedFingerprint);
}

function executeSelect(
  actionId: string,
  targetNodeId: string,
  optionId: string,
  expectedFingerprint: TargetFingerprint,
): ActionResult {
  const el = resolveTarget(targetNodeId);
  if (!el || !(el instanceof HTMLSelectElement)) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: 'Target is not a select element',
    };
  }

  const option = Array.from(el.options).find(
    (o) => o.value === optionId || o.text === optionId,
  );
  if (!option) {
    return {
      actionId,
      success: false,
      outcome: 'failure',
      error: `Option not found: ${optionId}`,
    };
  }

  // P1-C TOCTOU: Final verification IMMEDIATELY before select mutation
  const toctouError = verifyTargetBeforeExecution(targetNodeId, expectedFingerprint);
  if (toctouError) {
    return { actionId, success: false, outcome: 'toctou_rejected', error: toctouError };
  }

  el.value = option.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return { actionId, success: true, outcome: 'success' };
}

function executeScroll(
  actionId: string,
  containerNodeId: string | undefined,
  directionAmount: string,
): ActionResult {
  const [direction, amount] = directionAmount.split(':');
  const px = amount === 'page' ? window.innerHeight * 0.8 : 200;
  const dy = direction === 'up' ? -px : px;

  if (containerNodeId) {
    const el = resolveTarget(containerNodeId);
    if (el) {
      el.scrollBy({ top: dy, behavior: 'smooth' });
    }
  } else {
    window.scrollBy({ top: dy, behavior: 'smooth' });
  }

  return { actionId, success: true, outcome: 'success' };
}

async function executeWait(
  actionId: string,
  ms: number,
): Promise<ActionResult> {
  const capped = Math.min(ms, 30_000);
  await sleep(capped);
  return { actionId, success: true, outcome: 'success' };
}

function resolveTarget(nodeId: string): HTMLElement | null {
  return nodeRegistry.get(nodeId) || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── P1-C: Target state query ─────────────────────────────────

/**
 * Current state of a target element, read from the live DOM
 * via the P0-B authoritative registry.
 *
 * Uses the SAME inferRole, computeAccessibleName, getAncestorTags
 * as the harvester to guarantee ancestry/name/role consistency.
 */
export interface TargetCurrentState {
  found: true;
  fingerprint: TargetFingerprint;
}

export interface TargetNotFound {
  found: false;
  error: string;
}

/**
 * Query the CURRENT state of a target element using the P0-B
 * authoritative nodeId→HTMLElement registry.
 *
 * Does NOT re-target, does NOT use selectors, does NOT "find similar".
 * If the exact harvested element is no longer in the registry → not found.
 * If the element has been removed from the DOM → not found.
 *
 * Returns a TargetFingerprint built with the SAME functions used by
 * the harvester, ensuring consistency.
 */
export function queryTargetCurrentState(
  nodeId: string,
): TargetCurrentState | TargetNotFound {
  const el = nodeRegistry.get(nodeId);
  if (!el) {
    return { found: false, error: `Node ${nodeId} not in P0-B registry` };
  }

  // Verify element is still connected to the DOM
  if (!el.isConnected) {
    return { found: false, error: `Node ${nodeId} removed from DOM` };
  }

  const fingerprint = buildFingerprintFromElement(nodeId, el);
  return { found: true, fingerprint };
}

/**
 * Build a TargetFingerprint from the CURRENT live element using the
 * exact same functions the harvester used at observation time.
 */
function buildFingerprintFromElement(
  nodeId: string,
  el: HTMLElement,
): TargetFingerprint {
  const role = sceneGraphInferRole(el);
  const name = sceneGraphComputeAccessibleName(el);
  const ancestorTags = getAncestorTags(el);
  const ancestry = computeAncestryFingerprint(ancestorTags);
  const rect = el.getBoundingClientRect();
  const bbox = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };

  return createTargetFingerprint(
    nodeId, role, name, ancestry, bbox, 0, registryGeneration, '',
  );
}

// ── P1-C TOCTOU: Content-side final validation ───────────────

/**
 * P1-C TOCTOU defense: verify the target element has not mutated
 * between the background VERIFY_TARGET check and this content-side
 * execution. Called IMMEDIATELY before the DOM mutation.
 *
 * @param nodeId - The target node ID
 * @param expectedFingerprint - The fingerprint from VERIFY_TARGET
 * @returns null if valid, or an error string if stale
 */
export function verifyTargetBeforeExecution(
  nodeId: string,
  expectedFingerprint: TargetFingerprint,
): string | null {
  const el = nodeRegistry.get(nodeId);
  if (!el) {
    return `TOCTOU: node ${nodeId} no longer in P0-B registry`;
  }
  if (!el.isConnected) {
    return `TOCTOU: node ${nodeId} removed from DOM`;
  }

  const currentFp = buildFingerprintFromElement(nodeId, el);
  const mismatch = verifyTargetFingerprint(expectedFingerprint, currentFp);
  if (mismatch) {
    return `TOCTOU: ${mismatch}`;
  }
  return null;
}

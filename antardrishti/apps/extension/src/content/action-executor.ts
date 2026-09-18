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

// ── Action result ────────────────────────────────────────────

export interface ActionResult {
  actionId: string;
  success: boolean;
  outcome: 'success' | 'failure' | 'ambiguous' | 'navigated' | 'rejected';
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
}): Promise<ActionResult> {
  const { actionId, kind, targetNodeId, value, expectedRole } = payload;

  try {
    switch (kind) {
      case 'click':
        return await executeClick(actionId, targetNodeId!, expectedRole);

      case 'focus':
        return executeFocus(actionId, targetNodeId!);

      case 'type_text':
        return executeTypeText(actionId, targetNodeId!, value || '');

      case 'type_token':
        return executeTypeToken(actionId, targetNodeId!, value || '');

      case 'select':
        return executeSelect(actionId, targetNodeId!, value || '');

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
  expectedRole?: string,
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
    const actualRole = el.getAttribute('role') || inferRole(el);
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

  el.focus();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return { actionId, success: true, outcome: 'success' };
}

function executeTypeText(
  actionId: string,
  targetNodeId: string,
  text: string,
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
): ActionResult {
  // Token typing uses the same mechanism as type_text.
  // The actual value is redeemed from the vault by the coordinator
  // before being passed here. The executor only sees the raw value
  // AFTER capability redemption succeeds.
  //
  // At this point, `token` is actually the redeemed raw value
  // (the coordinator handles the redemption step).
  return executeTypeText(actionId, targetNodeId, token);
}

function executeSelect(
  actionId: string,
  targetNodeId: string,
  optionId: string,
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

// ── Target resolution ────────────────────────────────────────

function resolveTarget(nodeId: string): HTMLElement | null {
  return nodeRegistry.get(nodeId) || null;
}

function inferRole(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  return 'generic';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

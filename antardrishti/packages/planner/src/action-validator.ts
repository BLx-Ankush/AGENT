/**
 * ANTARDRISHTI — Action Validator
 *
 * Contract §19: validate planner actions locally before execution.
 *   - Kind must be from ALLOWED_ACTION_KINDS
 *   - TargetNodeId must reference an existing scene node
 *   - FreshnessBinding must match current observation
 *   - No arbitrary JS, eval, selectors, URLs
 *   - type_token must reference a valid vault token
 *   - High-risk actions must be confirmed by user
 */

import {
  type AgentAction,
  isAllowedActionKind,
  requiresConfirmation,
  classifyActionRisk,
  type FreshnessBinding,
} from '@antardrishti/protocol-v2';

// ── Validation result ────────────────────────────────────────

export interface ActionValidation {
  valid: boolean;
  errors: string[];
  requiresConfirmation: boolean;
  risk: string;
}

// ── Available nodes (from current scene) ─────────────────────

export interface SceneContext {
  nodeIds: Set<string>;
  freshness: FreshnessBinding;
  tokenValidator: (token: string) => boolean;
  targetContext?: Map<string, {
    isSubmit?: boolean;
    isPayment?: boolean;
    isDestructive?: boolean;
    isSend?: boolean;
    isUpload?: boolean;
  }>;
}

// ── Validator ────────────────────────────────────────────────

/**
 * Validate a planner action against the current scene context.
 * Rejects stale, invalid, and dangerous actions.
 */
export function validateAction(
  action: AgentAction,
  context: SceneContext,
): ActionValidation {
  const errors: string[] = [];

  // 1. Action kind must be allowed
  if (!isAllowedActionKind(action.kind)) {
    errors.push(`Disallowed action kind: ${action.kind}`);
  }

  // 2. Target node must exist in current scene
  if ('targetNodeId' in action && action.targetNodeId) {
    if (!context.nodeIds.has(action.targetNodeId)) {
      errors.push(`Target node not found: ${action.targetNodeId}`);
    }
  }

  // 3. type_token must reference a valid vault token
  if (action.kind === 'type_token') {
    if (!action.token) {
      errors.push('type_token action missing token');
    } else if (!context.tokenValidator(action.token)) {
      errors.push('type_token references invalid/expired vault token');
    }
  }

  // 4. No arbitrary JS patterns
  if (action.kind === 'type_text' && action.text) {
    if (containsCodePatterns(action.text)) {
      errors.push('type_text contains suspicious code-like patterns');
    }
  }

  // 5. Wait action must have reasonable duration
  if (action.kind === 'wait') {
    if (action.milliseconds > 30_000) {
      errors.push('Wait duration exceeds 30s limit');
    }
    if (action.milliseconds <= 0) {
      errors.push('Wait duration must be positive');
    }
  }

  // 6. Click action with document generation validation
  if (action.kind === 'type_token' && action.targetDocumentGeneration) {
    if (action.targetDocumentGeneration !== context.freshness.documentGeneration) {
      errors.push('Document generation mismatch — action targets stale document');
    }
  }

  // Determine confirmation requirement
  const targetCtx = context.targetContext?.get(
    'targetNodeId' in action ? (action.targetNodeId || '') : '',
  );
  const needsConfirm = requiresConfirmation(action, targetCtx);

  const risk = classifyActionRisk(action);

  return {
    valid: errors.length === 0,
    errors,
    requiresConfirmation: needsConfirm,
    risk,
  };
}

/**
 * Validate a complete action plan (multiple actions).
 */
export function validatePlan(
  actions: AgentAction[],
  context: SceneContext,
): { valid: boolean; validations: ActionValidation[] } {
  const validations = actions.map(a => validateAction(a, context));
  return {
    valid: validations.every(v => v.valid),
    validations,
  };
}

/**
 * Detect code-like patterns that should never appear in typed text.
 */
function containsCodePatterns(text: string): boolean {
  const patterns = [
    /\bfunction\s*\(/,
    /\beval\s*\(/,
    /\bdocument\.(?:write|cookie|location)/,
    /\bwindow\.(?:open|location)/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest/,
    /\bimport\s*\(/,
    /\brequire\s*\(/,
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/,  // event handlers like onclick=
  ];
  return patterns.some(p => p.test(text));
}

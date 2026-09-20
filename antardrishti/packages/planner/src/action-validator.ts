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
  type TargetFingerprint,
  verifyTargetFingerprint,
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
  /** P1-C: Target fingerprints from current observation, keyed by nodeId */
  targetFingerprints: Map<string, TargetFingerprint>;
  /** P1-C: The observationId from the planner response */
  planObservationId: string;
  tokenValidator: (token: string) => boolean;
  targetContext?: Map<string, {
    isSubmit?: boolean;
    isPayment?: boolean;
    isDestructive?: boolean;
    isSend?: boolean;
    isUpload?: boolean;
  }>;
}

// ── P1-H: Centralized execution authority check ──────────────

/**
 * P1-H: Determine if a target node has execution authority.
 *
 * Execution authority comes ONLY from the authoritative DOM harvest.
 * A node is execution-authoritative if and only if it has a valid
 * TargetFingerprint produced from the current DOM harvest.
 *
 * Visual-only, unresolved, nearby, and contains-only visual regions
 * do NOT have fingerprints and therefore CANNOT be executable.
 *
 * This check does NOT rely on:
 *   - ID prefixes (e.g. vis-*)
 *   - planner-provided source metadata
 *   - visual relation assertions
 *   - bbox/name similarity
 *   - candidateTargetId assertions
 *
 * It relies solely on whether the local authoritative harvest state
 * includes this nodeId with a valid fingerprint.
 */
export function isAuthoritativeDomTarget(
  nodeId: string,
  targetFingerprints: Map<string, TargetFingerprint>,
): boolean {
  return targetFingerprints.has(nodeId);
}

// ── Validator ────────────────────────────────────────────────

/**
 * Validate a planner action against the current scene context.
 * Rejects stale, invalid, and dangerous actions.
 *
 * P1-C: Now validates freshness binding for ALL actions.
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

  // P1-H: Visual execution authority boundary.
  // Target-bound actions MUST target an execution-authoritative DOM node.
  // Visual-only, unresolved, and non-DOM nodes are planning-visible but
  // non-executable. Authority is established by the presence of a valid
  // TargetFingerprint from the current authoritative DOM harvest.
  if (TARGET_BOUND_ACTIONS.has(action.kind) && 'targetNodeId' in action && action.targetNodeId) {
    if (!isAuthoritativeDomTarget(action.targetNodeId, context.targetFingerprints)) {
      errors.push(`P1-H: target ${action.targetNodeId} is not an execution-authoritative DOM node`);
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

  // ── P1-C: Freshness binding validation ───────────────────

  // 6. Plan observationId must match current observation
  if (context.planObservationId !== context.freshness.observationId) {
    errors.push(`Observation mismatch: plan from ${context.planObservationId}, current ${context.freshness.observationId}`);
  }

  // 7. Document generation must match for ALL target-bound actions
  if ('targetNodeId' in action && action.targetNodeId) {
    // Check target fingerprint
    const fingerprint = context.targetFingerprints.get(action.targetNodeId);
    if (!fingerprint) {
      errors.push(`Missing target fingerprint for ${action.targetNodeId}`);
    } else {
      // Verify document generation from fingerprint
      if (fingerprint.documentGeneration !== context.freshness.documentGeneration) {
        errors.push('Document generation mismatch — action targets stale document');
      }
      // Verify observation binding
      if (fingerprint.observationId !== context.freshness.observationId) {
        errors.push('Target fingerprint from different observation');
      }
    }
  }

  // 8. type_token targetDocumentGeneration (legacy compatibility)
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

// ── P1-C: Final pre-execution freshness check ────────────────

/**
 * Actions that require a target node for execution.
 * Non-targeted actions: wait, finish, request_observation, scroll (without container)
 */
const TARGET_BOUND_ACTIONS = new Set([
  'click', 'focus', 'type_text', 'type_token', 'select',
]);

/**
 * Final freshness check immediately before execution.
 * This MUST be called AFTER confirmation (P0-A) and BEFORE execution.
 *
 * Returns null if fresh, or an error string if stale.
 *
 * P1-C invariant: a user approval MUST NOT substitute for freshness validation.
 */
export function checkActionFreshness(
  action: AgentAction,
  currentFreshness: FreshnessBinding,
  planObservationId: string,
  targetFingerprints: Map<string, TargetFingerprint>,
  currentTargetState?: {
    role: string;
    name: string;
    ancestry: string;
    bbox: { x: number; y: number; w: number; h: number };
    frameId: number;
    documentGeneration: string;
  },
): string | null {
  // 1. Observation binding
  if (planObservationId !== currentFreshness.observationId) {
    return `Stale observation: plan from ${planObservationId}, current ${currentFreshness.observationId}`;
  }

  // 2. Session binding
  if (!currentFreshness.sessionId) {
    return 'Missing session binding';
  }

  // 3. Document generation binding
  const isTargetBound = TARGET_BOUND_ACTIONS.has(action.kind);
  const targetNodeId = 'targetNodeId' in action ? action.targetNodeId : undefined;

  if (isTargetBound && targetNodeId) {
    const fingerprint = targetFingerprints.get(targetNodeId);
    if (!fingerprint) {
      return `Missing target fingerprint for ${targetNodeId}`;
    }

    // Document generation must match
    if (fingerprint.documentGeneration !== currentFreshness.documentGeneration) {
      return 'Document generation changed since observation';
    }

    // If current target state is provided, verify fingerprint
    if (currentTargetState) {
      const mismatch = verifyTargetFingerprint(fingerprint, currentTargetState);
      if (mismatch) {
        return `Target stale: ${mismatch}`;
      }
    }
  }

  return null; // fresh
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

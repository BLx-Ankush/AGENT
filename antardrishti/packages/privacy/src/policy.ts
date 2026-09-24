/**
 * ANTARDRISHTI — Recipient-Aware Policy Engine
 *
 * Decision = f(sensitivity, confidence, task necessity, recipient,
 *              origin, action, user policy, ambiguity, retention)
 *
 * Contract §10: Recipient-aware policy.
 *   REMOTE PLANNER: password → never, OTP → never, CVV → never,
 *     raw payment card → never, raw biometric → never
 *   TASK WEBSITE: allowed only with local authorization
 *   LOCAL LOGS: category/result only, no raw secret
 */

import type { SensitivityFinding } from '@antardrishti/scene-graph';

// ── Policy decision ──────────────────────────────────────────

export type PolicyDecision =
  | 'ALLOW_LITERAL'
  | 'ABSTRACT'
  | 'TOKENIZE'
  | 'MASK_VISUAL'
  | 'OMIT'
  | 'ASK_LOCAL'
  | 'BLOCK';

export type Recipient = 'remote-planner' | 'task-website' | 'local-logs' | 'local-display';

export interface PolicyInput {
  sensitivity: SensitivityFinding;
  taskNecessity: 'required' | 'helpful' | 'irrelevant' | 'unknown';
  recipient: Recipient;
  origin: string;
  hasUserAuthorization: boolean;
  ambiguity: 'none' | 'low' | 'high';
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  requiresUserConfirmation: boolean;
}

// ── Never-allow rules (hard-coded) ───────────────────────────

const NEVER_TO_PLANNER = new Set([
  'credential', 'payment', 'biometric',
]);

const NEVER_CATEGORIES = new Set([
  'password', 'otp', 'cvv', 'private-key',
  'api-key', 'jwt', 'cloud-credential',
]);

// ── Policy engine ────────────────────────────────────────────

/**
 * Evaluate privacy policy for a sensitivity finding.
 * Unknown/contradictory/high-risk ambiguous → fail closed (contract §1.19).
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { sensitivity, taskNecessity, recipient, hasUserAuthorization, ambiguity } = input;
  const { category, confidence, validationTier } = sensitivity;

  // ── Fail closed for ambiguous/unknown ──────────────────
  if (ambiguity === 'high' || confidence < 0.3) {
    return {
      decision: 'OMIT',
      reason: 'High ambiguity or low confidence — fail closed',
      requiresUserConfirmation: false,
    };
  }

  // ── Remote planner rules ───────────────────────────────
  if (recipient === 'remote-planner') {
    // P0.3: Biometric visual data → MASK_VISUAL (mask face in image)
    if (category === 'face') {
      return {
        decision: 'MASK_VISUAL',
        reason: 'face: mask visual biometric data',
        requiresUserConfirmation: false,
      };
    }

    // Hard never: credential, payment, biometric raw data
    // Also matches PII subcategories that belong to these parent groups
    if (NEVER_TO_PLANNER.has(category) ||
        category === 'credit-card' || category === 'iban' ||
        category === 'ifsc' || category === 'account-number') {
      // Can tokenize if task-required
      if (taskNecessity === 'required' && confidence >= 0.7) {
        return {
          decision: 'TOKENIZE',
          reason: `${category}: tokenized for planner (task-required)`,
          requiresUserConfirmation: false,
        };
      }
      return {
        decision: 'OMIT',
        reason: `${category}: never send raw to planner`,
        requiresUserConfirmation: false,
      };
    }

    // Contact info: abstract shape, tokenize value
    if (category === 'contact' || category === 'email' || category === 'phone') {
      if (taskNecessity === 'required') {
        return {
          decision: 'TOKENIZE',
          reason: `${category}: tokenized (task-required)`,
          requiresUserConfirmation: false,
        };
      }
      return {
        decision: 'ABSTRACT',
        reason: `${category}: abstracted for planner`,
        requiresUserConfirmation: false,
      };
    }

    // Financial / identity-document identifiers (includes PII subcategories)
    if (category === 'financial' || category === 'identity-document' ||
        category === 'aadhaar' || category === 'pan' ||
        category === 'ssn' || category === 'dob') {
      return {
        decision: 'TOKENIZE',
        reason: `${category}: always tokenized for planner`,
        requiresUserConfirmation: false,
      };
    }

    // Health
    if (category === 'health') {
      return {
        decision: 'OMIT',
        reason: 'Health data: omit from planner',
        requiresUserConfirmation: false,
      };
    }

    // Secret/API keys
    if (category === 'secret' || NEVER_CATEGORIES.has(category)) {
      return {
        decision: 'BLOCK',
        reason: `${category}: blocked from planner`,
        requiresUserConfirmation: false,
      };
    }

    // Checksum-verified high confidence
    if (validationTier === 'checksum-verified' && confidence >= 0.9) {
      return {
        decision: 'TOKENIZE',
        reason: `${category}: checksum-verified, tokenized`,
        requiresUserConfirmation: false,
      };
    }

    // Pattern-matched medium confidence
    if (validationTier === 'pattern-matched' && confidence >= 0.7) {
      return {
        decision: 'TOKENIZE',
        reason: `${category}: pattern-matched, tokenized`,
        requiresUserConfirmation: false,
      };
    }

    // Default for planner: abstract
    return {
      decision: 'ABSTRACT',
      reason: `${category}: default abstract for planner`,
      requiresUserConfirmation: false,
    };
  }

  // ── Task website rules ─────────────────────────────────
  if (recipient === 'task-website') {
    if (!hasUserAuthorization) {
      return {
        decision: 'ASK_LOCAL',
        reason: `${category}: requires user authorization for website`,
        requiresUserConfirmation: true,
      };
    }
    // User authorized → allow literal via capability grant
    return {
      decision: 'ALLOW_LITERAL',
      reason: `${category}: user-authorized for task website`,
      requiresUserConfirmation: false,
    };
  }

  // ── Local logs ─────────────────────────────────────────
  if (recipient === 'local-logs') {
    return {
      decision: 'ABSTRACT',
      reason: `${category}: category/result only in logs`,
      requiresUserConfirmation: false,
    };
  }

  // ── Local display ──────────────────────────────────────
  return {
    decision: 'ALLOW_LITERAL',
    reason: 'Local display: allow',
    requiresUserConfirmation: false,
  };
}

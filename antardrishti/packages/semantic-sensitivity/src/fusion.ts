/**
 * ANTARDRISHTI — Semantic Sensitivity — Conservative Fusion Layer
 *
 * Merges deterministic PII detections with semantic detections into
 * unified SensitivityDecision records. Implements the conservative
 * fail-closed policy from the architecture contract.
 *
 * Escalation trigger (OR — any one is sufficient):
 *   • high-risk category context
 *   • OOD candidate (no keyword but value pattern matched)
 *   • semantic uncertainty (multiple categories overlap)
 *   • OCR-derived entity with weak deterministic evidence
 *
 * Fusion hierarchy (confidence):
 *   deterministic high (≥0.85) > semantic high (≥0.75) > medium (0.45–0.75)
 *
 * For high-risk categories (critical/high riskLevel):
 *   ambiguous results → fail-closed → tokenize
 */

import type { PiiDetection } from '@antardrishti/pii-rules';
import type { SemanticDetection } from './detector.ts';
import type { SensitivityDecision, DetectionSource } from './provenance.ts';

// ── Fusion configuration ─────────────────────────────────────

export interface FusionConfig {
  /** Minimum deterministic confidence to treat as "high" */
  deterministicHighThreshold: number;
  /** Minimum semantic confidence to tokenize without further checks */
  semanticHighThreshold: number;
  /** Minimum semantic confidence to tokenize for high-risk categories */
  semanticMediumThreshold: number;
  /** Minimum semantic confidence floor — below this → allow-literal (non-high-risk) */
  semanticFloorThreshold: number;
}

const DEFAULT_CONFIG: FusionConfig = {
  deterministicHighThreshold: 0.85,
  semanticHighThreshold: 0.75,
  semanticMediumThreshold: 0.45,
  semanticFloorThreshold: 0.45,
};

// ── Escalation decision ──────────────────────────────────────

export interface EscalationDecision {
  /** Whether neural NER should be invoked */
  shouldEscalate: boolean;
  /** Which OR-trigger fired */
  trigger?: 'high-risk' | 'ood-candidate' | 'semantic-uncertainty' | 'ocr-weak';
}

/**
 * Determine whether neural NER escalation should occur.
 *
 * Escalates when context scorer is ambiguous AND at least ONE of:
 *   1. High-risk category context (credential/financial/health/identity/biometric)
 *   2. OOD candidate (no keyword matched, value pattern present)
 *   3. Semantic uncertainty (multiple categories partially overlap)
 *   4. OCR-derived entity with weak deterministic evidence
 *
 * Hard gates (AND, always required):
 *   • Neural model must be ready
 *   • Within per-observation escalation budget
 */
export function shouldEscalateToNeural(
  deterministicResults: PiiDetection[],
  semanticResults: SemanticDetection[],
  cfg: FusionConfig = DEFAULT_CONFIG,
  opts?: { fromOcr?: boolean; semanticReady?: boolean },
): EscalationDecision {
  const NO = { shouldEscalate: false };

  // Hard gate: neural model must be available
  if (!opts?.semanticReady) return NO;

  // Deterministic confidence is high → stop, no escalation needed
  const detMaxConf = deterministicResults.reduce(
    (mx, d) => Math.max(mx, d.confidence), 0,
  );
  if (detMaxConf >= cfg.deterministicHighThreshold) return NO;

  // Context scorer is confident → stop
  const semMaxConf = semanticResults.reduce(
    (mx, d) => Math.max(mx, d.confidence), 0,
  );
  if (semMaxConf >= cfg.semanticHighThreshold) return NO;

  // Context scorer is ambiguous → check OR triggers

  // Trigger 1: any high-risk category in semantic results
  const hasHighRisk = semanticResults.some(
    d => d.riskLevel === 'critical' || d.riskLevel === 'high',
  );
  if (hasHighRisk) return { shouldEscalate: true, trigger: 'high-risk' };

  // Trigger 2: OOD candidate (value pattern matched but no keyword)
  const hasOod = semanticResults.some(d => d.oodCandidate);
  if (hasOod) return { shouldEscalate: true, trigger: 'ood-candidate' };

  // Trigger 3: semantic uncertainty (≥2 different categories above floor)
  const aboveFloor = semanticResults.filter(
    d => d.confidence >= cfg.semanticFloorThreshold,
  );
  const uniqueCategories = new Set(aboveFloor.map(d => d.category)).size;
  if (uniqueCategories >= 2) return { shouldEscalate: true, trigger: 'semantic-uncertainty' };

  // Trigger 4: OCR-derived with weak deterministic evidence
  if (opts?.fromOcr && detMaxConf < 0.5) {
    return { shouldEscalate: true, trigger: 'ocr-weak' };
  }

  return NO;
}

// ── Main fusion function ─────────────────────────────────────

/**
 * Fuse deterministic and semantic detection results into final
 * SensitivityDecision records.
 *
 * Returns one SensitivityDecision per unique sensitive span.
 * Non-sensitive text produces no entry (caller treats absence as "allow").
 */
export function fuse(
  deterministic: PiiDetection[],
  semantic: SemanticDetection[],
  cfg: FusionConfig = DEFAULT_CONFIG,
): SensitivityDecision[] {
  const decisions: SensitivityDecision[] = [];

  // ── Pass 1: deterministic → always emit (existing behaviour preserved) ──
  for (const det of deterministic) {
    const source: DetectionSource = 'deterministic';
    decisions.push({
      sensitive: true,
      category: _piiCategoryToSemanticCategory(det.category),
      subtype: det.category,
      confidence: det.confidence,
      source,
      detectorIds: [det.rule],
      span: { start: det.startOffset, end: det.endOffset },
      reasoning: `deterministic rule "${det.rule}" (${det.validationTier})`,
      policyDecision: 'tokenize',
    });
  }

  // ── Pass 2: semantic → apply conservative fusion policy ────
  for (const sem of semantic) {
    // Skip if this span is already covered by a high-confidence deterministic result
    const alreadyCoveredByDet = deterministic.some(
      d =>
        d.confidence >= cfg.deterministicHighThreshold &&
        d.startOffset <= sem.startOffset &&
        d.endOffset   >= sem.endOffset,
    );
    if (alreadyCoveredByDet) continue;

    const policy = _semanticPolicy(sem, cfg);
    if (policy === 'skip') continue;

    const source: DetectionSource = 'semantic';
    decisions.push({
      sensitive: policy !== 'allow',
      category: sem.category,
      subtype: sem.subtype,
      confidence: sem.confidence,
      source,
      detectorIds: [sem.detectorId],
      span: { start: sem.startOffset, end: sem.endOffset },
      reasoning: sem.reasoning,
      policyDecision: policy === 'allow' ? 'allow' : 'tokenize',
    });
  }

  return decisions;
}

/**
 * Determine the policy for a semantic detection.
 * Returns:
 *   'tokenize' → protect (add to vault)
 *   'allow'    → do not protect
 *   'skip'     → discard (below floor, non-high-risk)
 */
function _semanticPolicy(
  sem: SemanticDetection,
  cfg: FusionConfig,
): 'tokenize' | 'allow' | 'skip' {
  const isHighRisk = sem.riskLevel === 'critical' || sem.riskLevel === 'high';

  // High confidence → tokenize regardless of risk level
  if (sem.confidence >= cfg.semanticHighThreshold) return 'tokenize';

  // Medium confidence
  if (sem.confidence >= cfg.semanticMediumThreshold) {
    // Fail-closed for high-risk categories
    return isHighRisk ? 'tokenize' : 'allow';
  }

  // Below floor → skip (non-high-risk) or fail-closed (high-risk critical)
  if (sem.riskLevel === 'critical') return 'tokenize'; // never let critical slip
  return 'skip';
}

/** Map pii-rules PiiCategory to the semantic sensitivity category namespace. */
function _piiCategoryToSemanticCategory(piiCategory: string): string {
  const map: Record<string, string> = {
    email: 'contact',
    phone: 'contact',
    address: 'location',
    'credit-card': 'financial',
    'account-number': 'financial',
    aadhaar: 'identity_document',
    pan: 'identity_document',
    ifsc: 'financial',
    iban: 'financial',
    password: 'authentication',
    otp: 'authentication',
    'api-key': 'authentication',
    jwt: 'authentication',
    'private-key': 'authentication',
    'cloud-credential': 'authentication',
    ssn: 'identity_document',
    dob: 'personal',
    'unknown-pii': 'unknown',
  };
  return map[piiCategory] ?? piiCategory;
}

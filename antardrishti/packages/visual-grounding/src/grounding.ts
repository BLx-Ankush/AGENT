/**
 * ANTARDRISHTI — Visual Grounding Record Types
 *
 * Every visual region MUST establish:
 *   1. PRESENCE — a visual region actually exists
 *   2. MEANING — semantic meaning from visual evidence
 *   3. LOCATION — precise region/bbox
 *   4. ACTIONABILITY — whether it maps to an actionable browser target
 *
 * This module MUST NOT import any network client.
 */

// ── Visual Grounding Record ─────────────────────────────────

export interface VisualGrounding {
  /** Unique visual region ID */
  visualRegionId: string;
  /** Observation that produced this grounding */
  observationId: string;
  /** Frame that contains this region */
  frameId: number;
  /** Document generation at time of detection */
  documentGeneration: string;
  /** Bounding box in viewport coordinates */
  bbox: { x: number; y: number; w: number; h: number };

  // ── Semantic meaning (contract §6) ────────────────────

  /** Visual region class */
  class: VisualRegionClass;
  /** Semantic label assigned from visual evidence */
  semanticLabel: string;
  /** Confidence of semantic assignment (0–1) */
  confidence: number;
  /** Evidence chain: which detectors produced this result */
  evidence: VisualEvidence[];

  // ── Grounding to DOM ──────────────────────────────────

  /** Candidate scene node ID (null if unresolved) */
  candidateTargetId: string | null;
  /** Relationship between visual region and DOM node */
  targetRelation: TargetRelation;
  /** Actionability of the visual region */
  actionability: VisualActionability;
  /** Conflict flags (DOM/visual disagreements) */
  conflictFlags: ConflictFlag[];
}

// ── Enumerations ─────────────────────────────────────────────

export type VisualRegionClass =
  | 'text'
  | 'face'
  | 'qr'
  | 'document'
  | 'signature'
  | 'control'
  | 'payment-control'
  | 'image'
  | 'identifier'
  | 'unknown';

export type TargetRelation =
  | 'exact'       // visual region perfectly matches one DOM node
  | 'contains'    // visual region contains the DOM node
  | 'nearby'      // visual region is near a DOM node
  | 'visual-only' // no DOM node corresponds to this visual content
  | 'unresolved'; // matching attempt failed or was ambiguous

export type VisualActionability =
  | 'clickable'
  | 'typable'
  | 'selectable'
  | 'readable'
  | 'non-actionable'
  | 'unknown';

export type ConflictFlag =
  | 'aria-painted-disagreement'    // ARIA says X, visual shows Y
  | 'dom-absent-visual-content'   // visual content not in DOM
  | 'overlay-interception'        // overlay blocking the region
  | 'canvas-content'              // content is canvas-rendered
  | 'background-image-text'       // text is in CSS background
  | 'pseudo-element-content'      // content from ::before/::after
  | 'transformed-content'         // CSS transform applied
  | 'cross-origin-ambiguity';     // cross-origin frame content

// ── Evidence ─────────────────────────────────────────────────

export interface VisualEvidence {
  /** Detector that produced this evidence */
  source: string;
  /** What the detector found */
  finding: string;
  /** Confidence of this specific detection */
  confidence: number;
  /** Model used (if applicable) */
  model?: string;
  /** Detection latency in ms */
  latencyMs?: number;
}

// ── Factory functions ────────────────────────────────────────

let vrCounter = 0;

export function createVisualRegionId(): string {
  return `vr-${++vrCounter}`;
}

export function resetVisualRegionCounter(): void {
  vrCounter = 0;
}

/**
 * Create a visual grounding record.
 * A visual region that cannot be safely grounded remains
 * visual-only or unresolved and MUST NOT be auto-executed.
 */
export function createVisualGrounding(
  observationId: string,
  frameId: number,
  documentGeneration: string,
  bbox: { x: number; y: number; w: number; h: number },
  regionClass: VisualRegionClass,
  semanticLabel: string,
  confidence: number,
  evidence: VisualEvidence[],
): VisualGrounding {
  return {
    visualRegionId: createVisualRegionId(),
    observationId,
    frameId,
    documentGeneration,
    bbox,
    class: regionClass,
    semanticLabel,
    confidence,
    evidence,
    candidateTargetId: null,
    targetRelation: 'unresolved',
    actionability: 'unknown',
    conflictFlags: [],
  };
}

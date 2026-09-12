/**
 * ANTARDRISHTI — Scene Node Types
 *
 * Unified ID space for structural nodes, visual regions,
 * redaction masks, and action targets. This is the LOCAL
 * scene graph — contains full detail including sensitive hints.
 * The planner-visible scene is a sanitized projection.
 */

import type { ObservationId } from '@antardrishti/protocol-v2';

// ── Scene Node ───────────────────────────────────────────────

/**
 * Full local scene node — may contain sensitivity hints and
 * raw evidence that must NEVER be serialized to planner.
 */
export interface SceneNode {
  /** Stable local node ID */
  id: string;
  /** Observation that produced this node */
  observationId: string;
  /** Evidence sources */
  source: Array<'dom' | 'a11y-reconstructed' | 'ocr' | 'vision'>;
  /** Frame ID */
  frameId: number;
  /** Document generation (changes on navigation) */
  documentGeneration: string;
  /** Origin classification */
  originClass: 'top' | 'same-origin-frame' | 'cross-origin-frame' | 'unknown';

  // ── Structural properties ──────────────────────────────

  /** HTML tag name */
  tag: string;
  /** ARIA role or inferred role */
  role: string;
  /** Computed accessible name (safe text only in planner view) */
  name: string;
  /** Accessible description */
  description: string;
  /** Visible text content (truncated) */
  visibleText: string;

  // ── Geometry ───────────────────────────────────────────

  /** Bounding box in viewport coordinates */
  bbox: { x: number; y: number; w: number; h: number };
  /** Whether the element is clipped by an ancestor */
  isClipped: boolean;
  /** Approximate z-index for stacking context */
  zIndex: number;
  /** CSS opacity */
  opacity: number;
  /** CSS visibility */
  visibility: 'visible' | 'hidden' | 'collapse';

  // ── Interactivity ──────────────────────────────────────

  /** Available affordances */
  affordances: Affordance[];
  /** Whether the node is focusable */
  isFocusable: boolean;
  /** Whether the node is disabled */
  isDisabled: boolean;
  /** Whether the node is read-only */
  isReadOnly: boolean;
  /** Tab order hint */
  tabIndex: number | null;

  // ── Form state ─────────────────────────────────────────

  /** Input type if applicable */
  inputType?: string;
  /** Autocomplete hint */
  autocomplete?: string;
  /** Validation state */
  validationState?: 'valid' | 'invalid' | 'pending';
  /** Whether the field has user-entered value (not initial markup) */
  hasUserValue?: boolean;

  // ── Privacy / Sensitivity ──────────────────────────────

  /** Sensitivity findings from deterministic + ML detection */
  sensitivity: SensitivityFinding[];
  /** Task necessity classification */
  necessity: 'required' | 'helpful' | 'irrelevant' | 'unknown';
  /** Conflict flags (DOM vs visual disagreement, overlays, etc) */
  conflictFlags: string[];

  // ── Ancestry ───────────────────────────────────────────

  /** Form ancestor ID if in a form */
  formAncestorId?: string;
  /** Landmark ancestor type */
  landmarkType?: string;

  // ── Target stability ───────────────────────────────────

  /** Stable target reference for action resolution */
  stableTargetRef: string;
  /** Visual evidence hash for target verification */
  visualEvidenceHash?: string;
  /** DOM ancestry fingerprint */
  ancestryFingerprint: string;

  // ── Mutation tracking ──────────────────────────────────

  /** Mutation version at time of harvest */
  mutationVersion: number;
  /** Timestamp of harvest */
  harvestedAt: string;
}

// ── Supporting types ─────────────────────────────────────────

export type Affordance =
  | 'focus'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'check'
  | 'upload';

export interface SensitivityFinding {
  /** Category: credential, contact, financial, biometric, etc */
  category: string;
  /** Confidence 0–1 */
  confidence: number;
  /** How was this detected */
  validationTier: 'checksum-verified' | 'pattern-matched' | 'context-inferred' | 'visual';
  /** Evidence: which detector / rule produced this */
  evidenceSource: string;
  /** Span of sensitive content (character indices or description) */
  span?: string;
}

// ── Actionability ────────────────────────────────────────────

export type Actionability =
  | 'clickable'
  | 'typable'
  | 'selectable'
  | 'readable'
  | 'scrollable'
  | 'non-actionable'
  | 'unknown';

export function classifyActionability(node: SceneNode): Actionability {
  if (node.isDisabled) return 'non-actionable';
  if (node.visibility !== 'visible' || node.opacity === 0) return 'non-actionable';

  const { affordances, role, inputType } = node;

  if (affordances.includes('type') || role === 'textbox' || role === 'searchbox') {
    return node.isReadOnly ? 'readable' : 'typable';
  }
  if (role === 'combobox' || affordances.includes('select')) return 'selectable';
  if (affordances.includes('click') || role === 'button' || role === 'link') return 'clickable';
  if (affordances.includes('scroll')) return 'scrollable';
  if (role === 'heading' || role === 'img' || node.visibleText) return 'readable';

  return 'unknown';
}

// ── Scene Graph ──────────────────────────────────────────────

/**
 * Complete local scene graph for one observation.
 * Contains full detail — NEVER serialized to planner as-is.
 */
export interface LocalSceneGraph {
  observationId: string;
  documentGeneration: string;
  origin: string;
  timestamp: string;
  nodes: SceneNode[];
  /** Regions detected visually but not mapped to DOM */
  unexplainedRegions: UnexplainedRegion[];
  /** Mutation version at time of graph construction */
  mutationVersion: number;
}

export interface UnexplainedRegion {
  id: string;
  bbox: { x: number; y: number; w: number; h: number };
  source: 'ocr' | 'vision' | 'detector';
  description: string;
  sensitivity: SensitivityFinding[];
}

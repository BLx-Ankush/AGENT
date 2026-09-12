/**
 * ANTARDRISHTI — DOM ↔ Visual Reconciliation
 *
 * Uses one unified scene graph / ID space (contract §9).
 *
 * Rules:
 *   PIXELS: authoritative for what is visually painted.
 *   DOM: authoritative for structural/programmatic semantics
 *        only when visually consistent.
 *   OCR: authoritative for visual text above measured confidence.
 *   Contradictions: raise risk.
 *
 * This module MUST NOT import any network client.
 */

import type { SceneNode } from '@antardrishti/scene-graph';
import type {
  VisualGrounding,
  ConflictFlag,
  TargetRelation,
} from './grounding';

// ── Reconciliation result ────────────────────────────────────

export interface ReconciliationResult {
  /** Visual region ID */
  visualRegionId: string;
  /** Matched scene node ID (null if no match) */
  matchedNodeId: string | null;
  /** Target relation */
  relation: TargetRelation;
  /** Confidence of the match */
  matchConfidence: number;
  /** Conflict flags detected */
  conflicts: ConflictFlag[];
  /** Text agreement between OCR and DOM */
  textAgreement: 'match' | 'partial' | 'contradiction' | 'not-applicable';
  /** Notes for debugging */
  notes: string[];
}

// ── Configuration ────────────────────────────────────────────

const BOX_OVERLAP_THRESHOLD = 0.5; // IoU threshold for bbox matching
const TEXT_MATCH_THRESHOLD = 0.8;   // Normalized edit distance threshold

// ── Reconciliation engine ────────────────────────────────────

/**
 * Reconcile visual grounding records with DOM scene nodes.
 * Maps each visual region to its best DOM match and detects conflicts.
 */
export function reconcile(
  visualRegions: VisualGrounding[],
  sceneNodes: SceneNode[],
): ReconciliationResult[] {
  const results: ReconciliationResult[] = [];

  for (const vr of visualRegions) {
    const result = reconcileRegion(vr, sceneNodes);
    results.push(result);
  }

  return results;
}

function reconcileRegion(
  vr: VisualGrounding,
  nodes: SceneNode[],
): ReconciliationResult {
  const notes: string[] = [];
  const conflicts: ConflictFlag[] = [];

  // Find candidate nodes by bounding-box overlap
  const candidates = findOverlappingNodes(vr.bbox, nodes);

  if (candidates.length === 0) {
    // Visual content with no DOM correspondence
    conflicts.push('dom-absent-visual-content');
    notes.push('No DOM node overlaps this visual region');

    return {
      visualRegionId: vr.visualRegionId,
      matchedNodeId: null,
      relation: 'visual-only',
      matchConfidence: 0,
      conflicts,
      textAgreement: 'not-applicable',
      notes,
    };
  }

  // Score candidates
  let bestMatch: {
    node: SceneNode;
    iou: number;
    textSim: number;
  } | null = null;

  for (const { node, iou } of candidates) {
    let textSim = 0;

    // Text agreement: OCR text vs DOM/name text
    if (vr.semanticLabel && node.name) {
      textSim = normalizedSimilarity(
        vr.semanticLabel.toLowerCase(),
        node.name.toLowerCase(),
      );
    }

    const score = iou * 0.6 + textSim * 0.4;

    if (!bestMatch || score > bestMatch.iou * 0.6 + bestMatch.textSim * 0.4) {
      bestMatch = { node, iou, textSim };
    }
  }

  if (!bestMatch) {
    return {
      visualRegionId: vr.visualRegionId,
      matchedNodeId: null,
      relation: 'unresolved',
      matchConfidence: 0,
      conflicts,
      textAgreement: 'not-applicable',
      notes: ['No candidate scored above threshold'],
    };
  }

  const { node, iou, textSim } = bestMatch;

  // Determine relation
  let relation: TargetRelation = 'unresolved';
  if (iou > 0.8) relation = 'exact';
  else if (iou > BOX_OVERLAP_THRESHOLD) relation = 'contains';
  else relation = 'nearby';

  // Detect conflicts
  const textAgreement = textSim > TEXT_MATCH_THRESHOLD
    ? 'match' as const
    : textSim > 0.3
    ? 'partial' as const
    : (vr.semanticLabel && node.name) ? 'contradiction' as const : 'not-applicable' as const;

  if (textAgreement === 'contradiction') {
    conflicts.push('aria-painted-disagreement');
    notes.push(
      `DOM name "${node.name.substring(0, 30)}" ≠ visual "${vr.semanticLabel.substring(0, 30)}"`,
    );
  }

  // Canvas content
  if (node.tag === 'canvas') {
    conflicts.push('canvas-content');
    notes.push('Content is canvas-rendered');
  }

  // Overlay detection
  if (node.conflictFlags?.length) {
    conflicts.push(...node.conflictFlags as ConflictFlag[]);
  }

  return {
    visualRegionId: vr.visualRegionId,
    matchedNodeId: node.id,
    relation,
    matchConfidence: iou * 0.6 + textSim * 0.4,
    conflicts,
    textAgreement,
    notes,
  };
}

// ── Geometric helpers ────────────────────────────────────────

interface OverlapCandidate {
  node: SceneNode;
  iou: number;
}

function findOverlappingNodes(
  vrBbox: { x: number; y: number; w: number; h: number },
  nodes: SceneNode[],
): OverlapCandidate[] {
  const candidates: OverlapCandidate[] = [];

  for (const node of nodes) {
    const iou = computeIoU(vrBbox, node.bbox);
    if (iou > 0.1) {
      candidates.push({ node, iou });
    }
  }

  // Sort by IoU descending
  candidates.sort((a, b) => b.iou - a.iou);
  return candidates.slice(0, 5); // top 5
}

function computeIoU(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);

  if (x2 <= x1 || y2 <= y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

// ── Text similarity ──────────────────────────────────────────

function normalizedSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Simple longest-common-subsequence ratio
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const lcs = lcsLength(a, b);
  return lcs / maxLen;
}

function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimize for short strings
  if (m === 0 || n === 0) return 0;

  // Use two rows for O(n) space
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return prev[n];
}

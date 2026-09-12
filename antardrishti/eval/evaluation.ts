/**
 * ANTARDRISHTI — Evaluation Framework
 *
 * V2 §12: Metrics by SIH weight:
 *   Visual context accuracy (25%)
 *   PII recall and precision (20%)
 *   Redaction precision (20%)
 *   Client resources (20%)
 *   End-to-end latency (15%)
 *
 * V2 §12.4: Must Ship ablations (exactly 4):
 *   1. DOM-only baseline
 *   2. DOM + OCR/PII without visual grounding
 *   3. DOM + mandatory visual grounding + privacy gate
 *   4. Full Must Ship vertical slice with planner + local execution
 */

// ── Evaluation result ────────────────────────────────────────

export interface EvaluationResult {
  configuration: AblationConfig;
  timestamp: string;
  visual: VisualContextMetrics;
  pii: PiiMetrics;
  redaction: RedactionMetrics;
  resources: ResourceMetrics;
  latency: LatencyMetrics;
  utilityPairs: UtilityPair[];
}

export type AblationConfig =
  | 'dom-only'           // Ablation 1
  | 'dom-ocr-pii'        // Ablation 2
  | 'dom-visual-privacy'  // Ablation 3
  | 'full-vertical';      // Ablation 4 (Must Ship)

// ── Visual context accuracy (25%) ────────────────────────────

export interface VisualContextMetrics {
  /** Grounded-region recall: detected visual regions / total visual regions */
  groundedRegionRecall: number;
  /** Target mapping accuracy: correctly mapped regions / total mapped */
  targetMappingAccuracy: number;
  /** Actionable-node accuracy: correct actionability / total nodes */
  actionableNodeAccuracy: number;
  /** DOM-only ablation gap: full vs dom-only recall difference */
  domOnlyAblationGap: number;
  /** Total visual regions detected */
  totalVisualRegions: number;
  /** Regions grounded to scene nodes */
  groundedRegions: number;
  /** Unresolved regions (visual-only, no DOM target) */
  unresolvedRegions: number;
  /** Contradiction count (DOM vs visual disagreement) */
  contradictions: number;
}

// ── PII precision and recall (20%) ───────────────────────────

export interface PiiMetrics {
  /** Entity-level precision: correct PII detections / total detections */
  entityPrecision: number;
  /** Entity-level recall: correct PII detections / total PII in ground truth */
  entityRecall: number;
  /** Entity-level F1 */
  entityF1: number;
  /** Region-level precision */
  regionPrecision: number;
  /** Region-level recall */
  regionRecall: number;
  /** Region-level F1 */
  regionF1: number;
  /** By-category breakdown */
  byCategory: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number }>;
}

// ── Redaction precision (20%) ────────────────────────────────

export interface RedactionMetrics {
  /** Protected-region pixel coverage */
  protectedPixelCoverage: number;
  /** Over-redaction rate: unnecessarily redacted regions / total */
  overRedactionRate: number;
  /** Residual recovery: OCR on redacted output found raw values */
  residualRecovery: number;
  /** Zero raw values in planner bytes */
  zeroRawValuesInPlannerBytes: boolean;
  /** Redaction declarations present in all requests */
  redactionDeclarationsPresent: boolean;
  /** Total redacted regions */
  totalRedactedRegions: number;
  /** Redaction declarations count */
  redactionDeclarationCount: number;
}

// ── Client resources (20%) ───────────────────────────────────

export interface ResourceMetrics {
  /** Total model bytes loaded */
  modelBytes: number;
  /** Peak memory (MB) */
  peakMemoryMB: number;
  /** CPU usage estimate */
  cpuEstimate: number;
  /** Total processed pixels */
  processedPixels: number;
  /** Inference backend used */
  backend: string;
  /** Extension bundle sizes */
  bundleSizes: {
    serviceWorkerKB: number;
    contentScriptKB: number;
    popupKB: number;
  };
}

// ── End-to-end latency (15%) ─────────────────────────────────

export interface LatencyMetrics {
  /** p50 from observation trigger to action proposal */
  p50ObservationToProposalMs: number;
  /** p95 from observation trigger to action proposal */
  p95ObservationToProposalMs: number;
  /** p50 from observation trigger to local execution */
  p50ObservationToExecutionMs: number;
  /** p95 from observation trigger to local execution */
  p95ObservationToExecutionMs: number;
  /** Individual stage timings */
  stages: {
    captureMs: number;
    harvestMs: number;
    perceptionMs: number;
    sanitizationMs: number;
    egressVerificationMs: number;
    plannerRoundtripMs: number;
    actionValidationMs: number;
    executionMs: number;
  };
}

// ── Privacy-utility pairs (V2 §12.3) ─────────────────────────

export interface UtilityPair {
  metricA: string;
  valueA: number;
  metricB: string;
  valueB: number;
  relationship: string;
}

// ── Ground truth for the demo fixture ────────────────────────

export interface GroundTruth {
  /** All PII entities present on the page */
  entities: GroundTruthEntity[];
  /** Visual-only content not in DOM */
  visualOnly: VisualOnlyContent[];
  /** Canvas controls */
  canvasControls: CanvasControl[];
  /** Attack vectors */
  attackVectors: AttackVector[];
}

export interface GroundTruthEntity {
  id: string;
  category: string;
  value: string;
  location: 'dom' | 'canvas' | 'image' | 'css';
  nodeId?: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface VisualOnlyContent {
  id: string;
  type: string;
  description: string;
  canvasId: string;
}

export interface CanvasControl {
  id: string;
  label: string;
  canvasId: string;
  action: string;
}

export interface AttackVector {
  id: string;
  type: 'prompt-injection' | 'canary' | 'replay' | 'stale' | 'wrong-target';
  description: string;
  expectedResult: 'blocked' | 'contained' | 'rejected';
}

// ── Demo fixture ground truth ────────────────────────────────

export const DEMO_GROUND_TRUTH: GroundTruth = {
  entities: [
    { id: 'gt-email', category: 'email', value: 'ravi.shankar@example.com', location: 'dom', nodeId: 'email' },
    { id: 'gt-phone', category: 'phone', value: '+91 98765 43210', location: 'dom', nodeId: 'phone' },
    { id: 'gt-pan', category: 'pan', value: 'ABCDE1234F', location: 'dom', nodeId: 'pan' },
    { id: 'gt-aadhaar', category: 'aadhaar', value: '2234 5679 8012', location: 'dom', nodeId: 'aadhaar' },
    { id: 'gt-card', category: 'credit-card', value: '4111 1111 1111 1111', location: 'dom', nodeId: 'card-number' },
    { id: 'gt-cvv', category: 'credential', value: '123', location: 'dom', nodeId: 'card-cvv' },
    { id: 'gt-ifsc', category: 'ifsc', value: 'SBIN0001234', location: 'dom', nodeId: 'ifsc' },
    { id: 'gt-password', category: 'credential', value: 'SuperSecret@123!', location: 'dom', nodeId: 'password' },
    { id: 'gt-otp-text', category: 'otp', value: '847291', location: 'dom' },
    { id: 'gt-api-key', category: 'api-key', value: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456', location: 'dom', nodeId: 'api-key' },
    { id: 'gt-jwt', category: 'jwt', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', location: 'dom' },
    { id: 'gt-address', category: 'address', value: '42 MG Road, Bengaluru, Karnataka 560001', location: 'dom', nodeId: 'address' },
    { id: 'gt-face', category: 'biometric', value: 'face-avatar', location: 'canvas', nodeId: 'face-avatar' },
    { id: 'gt-account-visual', category: 'account-number', value: '1234 5678 9012 3456', location: 'canvas', nodeId: 'account-canvas' },
  ],
  visualOnly: [
    { id: 'vo-account', type: 'account-number', description: 'Account number rendered as canvas pixels', canvasId: 'account-canvas' },
    { id: 'vo-face', type: 'face', description: 'Face avatar rendered as canvas drawing', canvasId: 'face-avatar' },
  ],
  canvasControls: [
    { id: 'cc-pay', label: 'Pay Now', canvasId: 'pay-now-btn', action: 'click' },
  ],
  attackVectors: [
    { id: 'av-injection', type: 'prompt-injection', description: 'Malicious instructions in page text', expectedResult: 'contained' },
    { id: 'av-replay', type: 'replay', description: 'Re-use consumed capability grant', expectedResult: 'rejected' },
    { id: 'av-stale', type: 'stale', description: 'Execute plan after page navigation', expectedResult: 'rejected' },
    { id: 'av-wrong-target', type: 'wrong-target', description: 'Type into wrong DOM node', expectedResult: 'rejected' },
  ],
};

// ── Evaluator ────────────────────────────────────────────────

/**
 * Compute PII metrics from detections vs ground truth.
 */
export function computePiiMetrics(
  detections: Array<{ category: string; matchedText: string; startOffset: number }>,
  groundTruth: GroundTruthEntity[],
): PiiMetrics {
  const domEntities = groundTruth.filter(e => e.location === 'dom');
  const byCategory: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number }> = {};

  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  // Group ground truth by category
  const gtByCategory = new Map<string, GroundTruthEntity[]>();
  for (const e of domEntities) {
    const list = gtByCategory.get(e.category) || [];
    list.push(e);
    gtByCategory.set(e.category, list);
  }

  // Group detections by category
  const detByCategory = new Map<string, typeof detections>();
  for (const d of detections) {
    const list = detByCategory.get(d.category) || [];
    list.push(d);
    detByCategory.set(d.category, list);
  }

  // Merge all categories
  const allCategories = new Set([...gtByCategory.keys(), ...detByCategory.keys()]);

  for (const cat of allCategories) {
    const gt = gtByCategory.get(cat) || [];
    const det = detByCategory.get(cat) || [];

    const tp = Math.min(gt.length, det.length);
    const fp = Math.max(0, det.length - gt.length);
    const fn = Math.max(0, gt.length - det.length);

    byCategory[cat] = {
      tp, fp, fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    };

    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
  }

  const entityPrecision = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : 0;
  const entityRecall = totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : 0;
  const entityF1 = entityPrecision + entityRecall > 0
    ? 2 * (entityPrecision * entityRecall) / (entityPrecision + entityRecall) : 0;

  return {
    entityPrecision,
    entityRecall,
    entityF1,
    regionPrecision: entityPrecision,
    regionRecall: entityRecall,
    regionF1: entityF1,
    byCategory,
  };
}

/**
 * Format evaluation results as a human-readable report.
 */
export function formatReport(result: EvaluationResult): string {
  const lines: string[] = [];

  lines.push('═'.repeat(60));
  lines.push(`ANTARDRISHTI Evaluation Report — ${result.configuration}`);
  lines.push(`Timestamp: ${result.timestamp}`);
  lines.push('═'.repeat(60));

  lines.push('\n── Visual Context Accuracy (25%) ──');
  lines.push(`  Grounded-region recall:    ${(result.visual.groundedRegionRecall * 100).toFixed(1)}%`);
  lines.push(`  Target mapping accuracy:   ${(result.visual.targetMappingAccuracy * 100).toFixed(1)}%`);
  lines.push(`  Actionable-node accuracy:  ${(result.visual.actionableNodeAccuracy * 100).toFixed(1)}%`);
  lines.push(`  DOM-only ablation gap:     ${(result.visual.domOnlyAblationGap * 100).toFixed(1)}%`);
  lines.push(`  Total regions: ${result.visual.totalVisualRegions} | Grounded: ${result.visual.groundedRegions} | Unresolved: ${result.visual.unresolvedRegions}`);

  lines.push('\n── PII Precision & Recall (20%) ──');
  lines.push(`  Entity P/R/F1: ${(result.pii.entityPrecision * 100).toFixed(1)}% / ${(result.pii.entityRecall * 100).toFixed(1)}% / ${(result.pii.entityF1 * 100).toFixed(1)}%`);
  for (const [cat, m] of Object.entries(result.pii.byCategory)) {
    lines.push(`    ${cat}: TP=${m.tp} FP=${m.fp} FN=${m.fn} P=${(m.precision * 100).toFixed(0)}% R=${(m.recall * 100).toFixed(0)}%`);
  }

  lines.push('\n── Redaction Precision (20%) ──');
  lines.push(`  Protected-pixel coverage:  ${(result.redaction.protectedPixelCoverage * 100).toFixed(1)}%`);
  lines.push(`  Over-redaction rate:       ${(result.redaction.overRedactionRate * 100).toFixed(1)}%`);
  lines.push(`  Residual recovery:         ${result.redaction.residualRecovery}`);
  lines.push(`  Zero raw in planner:       ${result.redaction.zeroRawValuesInPlannerBytes ? '✅' : '❌'}`);
  lines.push(`  Declarations present:      ${result.redaction.redactionDeclarationsPresent ? '✅' : '❌'}`);

  lines.push('\n── Client Resources (20%) ──');
  lines.push(`  Model bytes: ${(result.resources.modelBytes / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`  Peak memory: ${result.resources.peakMemoryMB.toFixed(1)} MB`);
  lines.push(`  Backend: ${result.resources.backend}`);
  lines.push(`  Bundle: SW=${result.resources.bundleSizes.serviceWorkerKB}kb CS=${result.resources.bundleSizes.contentScriptKB}kb`);

  lines.push('\n── End-to-End Latency (15%) ──');
  lines.push(`  p50 obs→proposal: ${result.latency.p50ObservationToProposalMs}ms`);
  lines.push(`  p95 obs→proposal: ${result.latency.p95ObservationToProposalMs}ms`);
  lines.push(`  p50 obs→execute:  ${result.latency.p50ObservationToExecutionMs}ms`);
  lines.push(`  p95 obs→execute:  ${result.latency.p95ObservationToExecutionMs}ms`);

  if (result.utilityPairs.length > 0) {
    lines.push('\n── Privacy-Utility Pairs ──');
    for (const p of result.utilityPairs) {
      lines.push(`  ${p.metricA}=${(p.valueA * 100).toFixed(1)}% ↔ ${p.metricB}=${(p.valueB * 100).toFixed(1)}% (${p.relationship})`);
    }
  }

  lines.push('\n' + '═'.repeat(60));
  return lines.join('\n');
}

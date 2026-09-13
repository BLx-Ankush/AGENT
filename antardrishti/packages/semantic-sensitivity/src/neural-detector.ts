/**
 * ANTARDRISHTI — Semantic Sensitivity — Neural NER Detector (Stub)
 *
 * Implements SemanticDetector so the sanitizer and fusion layer need
 * zero changes when a real neural NER model is loaded.
 *
 * Current state: session is always null → ready = false → never invoked.
 *
 * To activate:
 *   1. Select a compact ONNX NER model (e.g. GLiNER-small-v2 int8).
 *   2. Add it to model-manifests.ts with SHA-256 integrity verification.
 *   3. Load via the existing PerceptionPipeline / OnnxSession infrastructure.
 *   4. Pass the live session handle to NeuralNerDetector constructor.
 *   5. The escalation flow in fusion.ts automatically activates it.
 *
 * Escalation conditions (OR — any one triggers escalation to this detector):
 *   • high-risk category context (credential/financial/health/identity/biometric)
 *   • OOD candidate: no keyword matched but value pattern present
 *   • semantic uncertainty: multiple categories partially overlap
 *   • OCR-derived entity with weak deterministic evidence
 *
 * Hard gates (AND — must hold regardless):
 *   • this.ready === true (session !== null)
 *   • invocation count within per-observation budget (default 5)
 */

import type { SemanticDetector, SemanticDetection, DetectionHints } from './detector.ts';

/** Minimal handle for an ONNX inference session (matches model-runner OnnxSession). */
export interface NerModelHandle {
  run(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispose?(): void;
}

/** Escalation metrics recorded per observation — injected into the audit log. */
export interface NeuralEscalationMetrics {
  invocations: number;
  skippedBudgetExceeded: number;
  latenciesMs: number[];
  modelSizeMB: number | null;
}

export class NeuralNerDetector implements SemanticDetector {
  readonly id = 'neural-ner-v1';

  private _session: NerModelHandle | null;
  private _budget: number;
  private _invocations = 0;
  private _metrics: NeuralEscalationMetrics = {
    invocations: 0,
    skippedBudgetExceeded: 0,
    latenciesMs: [],
    modelSizeMB: null,
  };

  constructor(session: NerModelHandle | null = null, budgetPerObservation = 5) {
    this._session = session;
    this._budget  = budgetPerObservation;
  }

  get ready(): boolean {
    return this._session !== null;
  }

  /** Reset per-observation invocation counter. Call at the start of each observation. */
  resetBudget(): void {
    this._invocations = 0;
  }

  /** Read escalation metrics (for harness/audit — does not expose raw values). */
  getMetrics(): Readonly<NeuralEscalationMetrics> {
    return { ...this._metrics, latenciesMs: [...this._metrics.latenciesMs] };
  }

  async detect(
    text: string,
    _hints?: DetectionHints,
  ): Promise<SemanticDetection[]> {
    if (!this._session) return [];
    if (this._invocations >= this._budget) {
      this._metrics.skippedBudgetExceeded++;
      return [];
    }

    this._invocations++;
    this._metrics.invocations++;
    const t0 = performance.now();

    try {
      // ── Placeholder inference path ──────────────────────────
      // Replace this block with real tokenisation + ONNX session.run()
      // when a model is selected and integrated via model-manifests.ts.
      //
      // Expected inputs:  { input_ids: Int64Array, attention_mask: Int64Array }
      // Expected outputs: { logits: Float32Array }  (NER token classification)
      //
      // const tokenised = tokenise(text);
      // const outputs = await this._session.run({
      //   input_ids:      new ort.Tensor('int64', tokenised.ids, [1, tokenised.length]),
      //   attention_mask: new ort.Tensor('int64', tokenised.mask, [1, tokenised.length]),
      // });
      // return this._decodeNerOutput(outputs, text, tokenised);

      // Stub: always returns empty until a real model is loaded.
      void text;
      return [];
    } finally {
      const lat = performance.now() - t0;
      this._metrics.latenciesMs.push(lat);
    }
  }

  // ── Private helpers (implement when model is selected) ──────

  // private _decodeNerOutput(outputs, text, tokenised): SemanticDetection[] { ... }
}

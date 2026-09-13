/**
 * ANTARDRISHTI — Neural NER Feasibility Evaluation Stub
 *
 * This script documents the evaluation criteria for a compact
 * neural NER model (e.g. GLiNER-compatible) as an optional
 * escalation path for the SemanticDetector interface.
 *
 * Current status: NO model is loaded. All metrics below are
 * marked [NOT_MEASURED] until a model is selected and integrated
 * via the existing model-manifests.ts / OnnxSession infrastructure.
 *
 * Evaluation criteria (per implementation plan §11):
 *
 *   Model size (fp32)         — MB
 *   Model size (int8 quant)   — MB   [target: incremental < 20 MB]
 *   ONNX conversion           — pass/fail
 *   Load time (cold, WASM)    — ms   [target: < 300 ms additional]
 *   Inference latency p50/p95 — ms   [target: < 50 ms]
 *   Peak memory delta         — MB   [target: < 50 MB RSS]
 *   Browser feasibility       — pass/fail
 *   Entity recall (gen bench) — %
 *   Entity precision          — %
 *
 * Go/no-go: based on generalization gain per resource cost.
 * Budget thresholds are engineering starting points, not hard limits.
 *
 * Run: npx tsx eval/test-neural-ner-feasibility.mts
 */

import { NeuralNerDetector } from '../packages/semantic-sensitivity/src/neural-detector.ts';

const detector = new NeuralNerDetector(null);

console.log('═'.repeat(62));
console.log('  ANTARDRISHTI — Neural NER Feasibility Evaluation');
console.log('═'.repeat(62));
console.log();
console.log(`  Detector ID: ${detector.id}`);
console.log(`  Ready:       ${detector.ready}  (no model loaded)`);
console.log();
console.log('  Status: NO MODEL INTEGRATED');
console.log();
console.log('  To integrate a model:');
console.log('  1. Select a compact ONNX NER model candidate.');
console.log('  2. Add to apps/extension/assets/models/ with SHA-256 hash.');
console.log('  3. Register in apps/extension/src/background/model-manifests.ts.');
console.log('  4. Load via existing PerceptionPipeline / OnnxSession infrastructure.');
console.log('  5. Pass the live session handle to NeuralNerDetector constructor.');
console.log('  6. Run this script again to measure real metrics.');
console.log();
console.log('  Feasibility Dimensions          Target           Measured');
console.log('  ─────────────────────────────────────────────────────────');
console.log('  Model size fp32                 <100 MB          [NOT_MEASURED]');
console.log('  Model size int8                 <20 MB incr.     [NOT_MEASURED]');
console.log('  ONNX conversion                 pass             [NOT_MEASURED]');
console.log('  Load time (WASM cold)           <300 ms add.     [NOT_MEASURED]');
console.log('  Inference p50                   <50 ms           [NOT_MEASURED]');
console.log('  Inference p95                   <100 ms          [NOT_MEASURED]');
console.log('  Memory delta (RSS)              <50 MB           [NOT_MEASURED]');
console.log('  Browser execution               pass             [NOT_MEASURED]');
console.log('  Entity recall (gen bench)       >config-B        [NOT_MEASURED]');
console.log('  Entity precision                ≥config-B        [NOT_MEASURED]');
console.log();
console.log('  Neural escalation metrics (current session):');
const m = detector.getMetrics();
console.log(`    Invocations:         ${m.invocations}`);
console.log(`    Budget exceeded:     ${m.skippedBudgetExceeded}`);
console.log(`    Model size on disk:  ${m.modelSizeMB ?? '[NOT_MEASURED]'} MB`);
console.log();
console.log('  Note: The ContextSensitivityDetector (Config B) is the');
console.log('  production default until neural NER is evaluated and');
console.log('  shown to provide material generalization gain.');
console.log('═'.repeat(62));

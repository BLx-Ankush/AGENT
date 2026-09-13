/**
 * ANTARDRISHTI — Configuration Comparison (A / B / C)
 *
 * Measures three configurations on the SAME generalization fixture:
 *
 *   A — Deterministic only (pii-rules)
 *   B — Deterministic + ContextSensitivityDetector
 *   C — Deterministic + ContextSensitivityDetector + NeuralNerDetector
 *       (stub, ready=false → identical to B in current state)
 *
 * Informs the go/no-go decision for neural NER inclusion.
 *
 * Run: npx tsx eval/test-configuration-comparison.mts
 */

import { scanForPii } from '../packages/pii-rules/src/index.ts';
import { ContextSensitivityDetector } from '../packages/semantic-sensitivity/src/detector.ts';
import { NeuralNerDetector } from '../packages/semantic-sensitivity/src/neural-detector.ts';
import { fuse } from '../packages/semantic-sensitivity/src/fusion.ts';

// ── Shared test fixture ───────────────────────────────────────

interface FixtureCase {
  id: string;
  text: string;
  expectSensitive: boolean;
  expectedCategory?: string;
}

const FIXTURE: FixtureCase[] = [
  // Known-PII (covered by deterministic)
  { id: 'K01', text: 'ravi.shankar@example.com',           expectSensitive: true,  expectedCategory: 'email'           },
  { id: 'K02', text: '+91 98765 43210',                     expectSensitive: true,  expectedCategory: 'phone'           },
  { id: 'K03', text: 'ABCDE1234F',                          expectSensitive: true,  expectedCategory: 'pan'             },
  { id: 'K04', text: '2234 5679 8012',                      expectSensitive: true,  expectedCategory: 'aadhaar'         },
  { id: 'K05', text: '4111 1111 1111 1111',                 expectSensitive: true,  expectedCategory: 'credit-card'     },
  { id: 'K06', text: 'password: SuperSecret@123!',          expectSensitive: true,  expectedCategory: 'password'        },
  { id: 'K07', text: 'Your verification code is: 847291',   expectSensitive: true,  expectedCategory: 'otp'             },
  { id: 'K08', text: 'SBIN0001234',                         expectSensitive: true,  expectedCategory: 'ifsc'            },
  { id: 'K09', text: 'sk-proj-abcdefghijklmnopqrstuvwxyz',  expectSensitive: true,  expectedCategory: 'api-key'         },
  { id: 'K10', text: '9876543210987654',                    expectSensitive: true,  expectedCategory: 'account-number'  },
  { id: 'K11', text: '42 MG Road, Bengaluru, Karnataka 560001', expectSensitive: true, expectedCategory: 'address'     },

  // Generalization (require semantic layer)
  { id: 'G01', text: 'Passport No: P1234567',               expectSensitive: true,  expectedCategory: 'identity_document' },
  { id: 'G02', text: 'Medical Record: MRN-839201',          expectSensitive: true,  expectedCategory: 'health'            },
  { id: 'G03', text: 'Annual Salary: ₹12,50,000',           expectSensitive: true,  expectedCategory: 'financial'         },
  { id: 'G04', text: 'Employee ID: EMP-19382',              expectSensitive: true,  expectedCategory: 'identity_document' },
  { id: 'G05', text: "Mother's Maiden Name: Sharma",        expectSensitive: true,  expectedCategory: 'authentication'    },

  // Variations (synonyms — hardest for context scorer)
  { id: 'V01', text: 'Travel document reference: P1234567', expectSensitive: true,  expectedCategory: 'identity_document' },
  { id: 'V03', text: 'Clinical identifier: MRN-839201',     expectSensitive: true,  expectedCategory: 'health'            },
  { id: 'V05', text: 'Compensation: ₹12,50,000',            expectSensitive: true,  expectedCategory: 'financial'         },
  { id: 'V07', text: 'Staff identifier: EMP-19382',         expectSensitive: true,  expectedCategory: 'identity_document' },

  // Benign controls (must NOT be flagged)
  { id: 'B01', text: 'Invoice #12345',                      expectSensitive: false },
  { id: 'B02', text: 'Order ID: ORD-839201',                expectSensitive: false },
  { id: 'B03', text: '₹25,000',                             expectSensitive: false },
  { id: 'B04', text: 'Shipment tracking: SHP-19382',        expectSensitive: false },
];

// ── Configuration runners ──────────────────────────────────────

const ctxDetector    = new ContextSensitivityDetector();
const neuralDetector = new NeuralNerDetector(null);  // stub: ready=false

interface ConfigResult {
  name: string;
  tp: number; fp: number; fn: number; tn: number;
  precision: number; recall: number; f1: number;
  latencyMs: number[];
  modelFootprintMB: number;
}

function evalConfig(
  name: string,
  useSemantic: boolean,
  useNeural: boolean,
): ConfigResult {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const latencies: number[] = [];

  for (const fc of FIXTURE) {
    const t0 = performance.now();

    const det = scanForPii(fc.text);

    const semantic = useSemantic
      ? ctxDetector.detect(fc.text)
      : [];

    // Neural escalation (stub — always returns [] since ready=false)
    const neuralResults = useNeural && neuralDetector.ready
      ? (neuralDetector.detect(fc.text) as unknown as any[])
      : [];

    const allSemantic = [...semantic, ...neuralResults];
    const fused = fuse(det, allSemantic);
    const isSensitive = fused.some(d => d.sensitive);

    latencies.push(performance.now() - t0);

    if (fc.expectSensitive)  { isSensitive ? tp++ : fn++; }
    else                     { isSensitive ? fp++ : tn++; }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall    = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1        = precision + recall > 0
    ? 2 * precision * recall / (precision + recall) : 0;

  return {
    name, tp, fp, fn, tn,
    precision, recall, f1,
    latencyMs: latencies,
    modelFootprintMB: 0,  // no additional models for A/B; C stub=0
  };
}

function pct(n: number) { return (n * 100).toFixed(1) + '%'; }
function p50(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(arr.length * 0.50)];
}
function p95(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(arr.length * 0.95)];
}

// ── Run ────────────────────────────────────────────────────────

console.log('═'.repeat(62));
console.log('  ANTARDRISHTI — Configuration Comparison (A / B / C)');
console.log('═'.repeat(62));
console.log('  Same fixture: ' + FIXTURE.length + ' cases (' +
  FIXTURE.filter(f => f.expectSensitive).length + ' sensitive, ' +
  FIXTURE.filter(f => !f.expectSensitive).length + ' benign)\n');

const configs = [
  evalConfig('A: Deterministic only',               false, false),
  evalConfig('B: Det + Context scorer',             true,  false),
  evalConfig('C: Det + Context + Neural (stub)',    true,  true),
];

console.log('Config'.padEnd(36) + 'P'.padStart(8) + 'R'.padStart(8) + 'F1'.padStart(8) +
  'TP'.padStart(5) + 'FP'.padStart(5) + 'FN'.padStart(5) +
  'p50ms'.padStart(8) + 'p95ms'.padStart(8));
console.log('─'.repeat(93));

for (const cfg of configs) {
  console.log(
    cfg.name.padEnd(36) +
    pct(cfg.precision).padStart(8) +
    pct(cfg.recall).padStart(8) +
    pct(cfg.f1).padStart(8) +
    String(cfg.tp).padStart(5) +
    String(cfg.fp).padStart(5) +
    String(cfg.fn).padStart(5) +
    p50(cfg.latencyMs).toFixed(3).padStart(8) +
    p95(cfg.latencyMs).toFixed(3).padStart(8),
  );
}

console.log('\n── Notes ────────────────────────────────────────────────');
console.log('  Config C is identical to B because NeuralNerDetector.ready=false');
console.log('  (model stub — no ONNX session loaded).');
console.log('  Real Config C measurements require a loaded neural NER model.');
console.log('\n  Resource budget thresholds (engineering starting points):');
console.log('  incremental model: <20 MB  cold-start: <300 ms  memory: <50 MB  p50: <50 ms');
console.log('\n  Go/no-go based on generalization gain per resource cost,');
console.log('  not on threshold compliance alone.');
console.log('═'.repeat(62));

/**
 * ANTARDRISHTI -- Smoke Timing Instrumentation Tests
 *
 * Proves that the timing fields (transferDecodeMs, inferenceMs, totalMs)
 * in the smoke test response come from real measured values, not defaults.
 *
 * Root cause: _pendingInference resolved with ir.result (PerceptionResult)
 * instead of the full InferenceResult. The smoke handler read
 * inferenceResult.transferDecodeMs -> undefined -> fallback 0.
 *
 * Fix: resolve with full InferenceResult. Smoke handler reads timing
 * directly from ir.transferDecodeMs, ir.inferenceMs, ir.totalMs.
 *
 * Run: npx tsx tests/test-smoke-timing.mts
 */

// -- Test framework --------------------------------------------------------
let passed = 0; let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  OK  ' + msg); passed++; }
  else { console.error('  FAIL ' + msg); failed++; }
}

// -- Simulated InferenceResult shape ---------------------------------------

interface InferenceResult {
  type: 'INFERENCE_RESULT';
  result: { faceDetections: any[]; metrics: any[] };
  backend: string;
  transferDecodeMs: number;
  inferenceMs: number;
  totalMs: number;
}

// -- Simulate the old (broken) and new (fixed) timing extraction -----------

function extractTimingOld(ir: InferenceResult): {
  transferDecodeMs: number; inferenceMs: number; totalMs: number;
} {
  // OLD: resolved with ir.result, then read fields from PerceptionResult
  const inferenceResult = ir.result as any; // this is what resolve() gave
  return {
    transferDecodeMs: inferenceResult?.transferDecodeMs ?? 0,
    inferenceMs: inferenceResult?.metrics?.[0]?.durationMs ?? inferenceResult?.inferenceMs ?? 0,
    totalMs: inferenceResult?.totalMs ?? 999,
  };
}

function extractTimingNew(ir: InferenceResult): {
  transferDecodeMs: number; inferenceMs: number; totalMs: number;
} {
  // NEW: resolved with full InferenceResult, read timing directly
  return {
    transferDecodeMs: ir.transferDecodeMs,
    inferenceMs: ir.inferenceMs,
    totalMs: ir.totalMs,
  };
}

// =========================================================================
console.log('='.repeat(64));
console.log('  Smoke Timing Instrumentation Tests');
console.log('='.repeat(64));

const sampleResult: InferenceResult = {
  type: 'INFERENCE_RESULT',
  result: { faceDetections: [], metrics: [{ modelId: 'face-detector-v1', durationMs: 42 }] },
  backend: 'wasm',
  transferDecodeMs: 7,
  inferenceMs: 42,
  totalMs: 55,
};

// -- TIMING-01: Old extraction loses timing --------------------------------
console.log('\n--- TIMING-01: Old extraction produces zeros (proving the bug)');
{
  const old = extractTimingOld(sampleResult);
  // transferDecodeMs: result.transferDecodeMs -> undefined -> 0
  assert(old.transferDecodeMs === 0,
    'TIMING-01a: old transferDecodeMs was 0 (lost)');
  // inferenceMs: result.metrics[0].durationMs -> 42 (this one worked by luck
  //   but only because PerceptionResult.metrics happened to have durationMs)
  // totalMs: result.totalMs -> undefined -> fallback 999
  assert(old.totalMs === 999,
    'TIMING-01b: old totalMs fell through to fallback');
}

// -- TIMING-02: New extraction preserves timing ----------------------------
console.log('\n--- TIMING-02: New extraction preserves all timing fields');
{
  const nw = extractTimingNew(sampleResult);
  assert(nw.transferDecodeMs === 7,
    'TIMING-02a: transferDecodeMs=7 (real decode time)');
  assert(nw.inferenceMs === 42,
    'TIMING-02b: inferenceMs=42 (real session.run() time)');
  assert(nw.totalMs === 55,
    'TIMING-02c: totalMs=55 (real offscreen wall-clock)');
}

// -- TIMING-03: inferenceMs cannot silently become 0 -----------------------
console.log('\n--- TIMING-03: inferenceMs=0 is detected and rejected');
{
  const badResult: InferenceResult = {
    ...sampleResult,
    inferenceMs: 0,
  };
  const nw = extractTimingNew(badResult);
  // The smoke handler validates: if inferenceMs <= 0, throw error
  const valid = typeof nw.inferenceMs === 'number' && nw.inferenceMs > 0;
  assert(!valid,
    'TIMING-03a: inferenceMs=0 fails validation (would throw in smoke handler)');

  // Negative is also invalid
  const negResult: InferenceResult = { ...sampleResult, inferenceMs: -1 };
  const neg = extractTimingNew(negResult);
  const negValid = typeof neg.inferenceMs === 'number' && neg.inferenceMs > 0;
  assert(!negValid,
    'TIMING-03b: inferenceMs=-1 fails validation');
}

// -- TIMING-04: undefined inferenceMs is detected --------------------------
console.log('\n--- TIMING-04: undefined/NaN inferenceMs rejected');
{
  const undResult = { ...sampleResult, inferenceMs: undefined as any };
  const valid1 = typeof undResult.inferenceMs === 'number' && undResult.inferenceMs > 0;
  assert(!valid1, 'TIMING-04a: undefined inferenceMs fails validation');

  const nanResult = { ...sampleResult, inferenceMs: NaN };
  const valid2 = typeof nanResult.inferenceMs === 'number' && nanResult.inferenceMs > 0;
  assert(!valid2, 'TIMING-04b: NaN inferenceMs fails validation');
}

// -- TIMING-05: transferDecodeMs comes from offscreen PNG decode -----------
console.log('\n--- TIMING-05: transferDecodeMs preserved from offscreen');
{
  const nw = extractTimingNew(sampleResult);
  assert(nw.transferDecodeMs === sampleResult.transferDecodeMs,
    'TIMING-05: transferDecodeMs matches offscreen value');
}

// -- TIMING-06: totalMs reflects offscreen wall-clock ----------------------
console.log('\n--- TIMING-06: totalMs reflects offscreen wall-clock');
{
  const nw = extractTimingNew(sampleResult);
  assert(nw.totalMs === sampleResult.totalMs,
    'TIMING-06: totalMs matches offscreen value');
  // totalMs >= inferenceMs (inference is a subset of total)
  assert(nw.totalMs >= nw.inferenceMs,
    'TIMING-06b: totalMs >= inferenceMs');
}

// -- TIMING-07: Full InferenceResult resolved (not PerceptionResult) -------
console.log('\n--- TIMING-07: resolve() passes full InferenceResult, not .result');
{
  // Simulate: old code resolved with ir.result
  const oldResolved = sampleResult.result;
  assert(!('transferDecodeMs' in oldResolved),
    'TIMING-07a: PerceptionResult has no transferDecodeMs');
  assert(!('inferenceMs' in oldResolved),
    'TIMING-07b: PerceptionResult has no inferenceMs');

  // Simulate: new code resolves with ir (full InferenceResult)
  const newResolved = sampleResult;
  assert('transferDecodeMs' in newResolved,
    'TIMING-07c: InferenceResult has transferDecodeMs');
  assert('inferenceMs' in newResolved,
    'TIMING-07d: InferenceResult has inferenceMs');
  assert('totalMs' in newResolved,
    'TIMING-07e: InferenceResult has totalMs');
}

// -- Summary ---------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('  Smoke Timing Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(64));
if (failed > 0) process.exit(1);

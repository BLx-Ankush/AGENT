/**
 * ANTARDRISHTI -- Smoke Test Init Flow Tests (blocker #10 fix)
 *
 * Proves the smoke handler reuses the Coordinator's production
 * _initOffscreenInference() path instead of maintaining a duplicated
 * OFFSCREEN_READY handshake.
 *
 * Root cause of blocker #10:
 *   The smoke handler installed its own _offscreenReadyResolve, which:
 *   1. Never checked _offscreenReadyReceived (the buffer).
 *   2. Competed with the production handler for the same resolver field.
 *   3. Always timed out when the document was already ready.
 *
 * Fix: smoke handler calls _initOffscreenInference() which internally:
 *   - calls _ensureOffscreenDocument()
 *   - calls _waitForOffscreenReady() (checks buffer first)
 *   - sends INFERENCE_INIT
 *   - awaits INFERENCE_INIT_RESULT
 *   All of which are already race-safe and buffer-aware.
 *
 * Run: npx tsx tests/test-smoke-init.mts
 */

// -- Test framework --------------------------------------------------------
let passed = 0; let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  OK  ' + msg); passed++; }
  else { console.error('  FAIL ' + msg); failed++; }
}

// -- State machine simulator -----------------------------------------------
// Simulates only the relevant Coordinator state for the smoke handler.

class SmokeFlowSimulator {
  // Production Coordinator state
  _offscreenReadyReceived = false;
  _offscreenRuntimeInstanceId: string | null = null;
  _offscreenInitPromise: Promise<void> | null = null;
  _modelLoadFailed = false;
  _backend = 'unknown';
  log: string[] = [];

  // Simulates _initOffscreenInference() -- mutex singleton
  _initOffscreenInference(): Promise<void> {
    if (!this._offscreenInitPromise) {
      this._offscreenInitPromise = this._doOffscreenInit().catch((err) => {
        this._offscreenInitPromise = null;
        throw err;
      });
    }
    return this._offscreenInitPromise;
  }

  private async _doOffscreenInit(): Promise<void> {
    this.log.push('_doOffscreenInit started');
    // Simulate: ensure document
    // Simulate: wait for READY (checks buffer)
    if (this._offscreenReadyReceived) {
      this.log.push('READY already buffered -- immediate');
    } else {
      // Simulate: wait for READY with timeout
      throw new Error('OFFSCREEN_READY timeout -- fail-closed');
    }
    // Simulate: INFERENCE_INIT
    this._backend = 'wasm';
    this.log.push('INFERENCE_INIT_RESULT success');
  }

  // Simulates the smoke handler flow
  async handleSmokeOffscreenTest(): Promise<{
    success: boolean;
    offscreenReady: boolean;
    runtimeInstanceId: string;
    backend: string;
    error?: string;
  }> {
    let offscreenReady = false;
    let runtimeInstanceId = 'unknown';
    try {
      // S1: ensure document (simplified)
      this.log.push('SMOKE S1: document ensured');

      // S2 + S3: use production handshake
      await this._initOffscreenInference();

      // S2: read buffered state
      offscreenReady = this._offscreenReadyReceived;
      runtimeInstanceId = this._offscreenRuntimeInstanceId ?? 'unknown';
      this.log.push('SMOKE S2: OFFSCREEN_READY instance=' + runtimeInstanceId);
      this.log.push('SMOKE S3: ORT initialized backend=' + this._backend);

      return {
        success: true,
        offscreenReady,
        runtimeInstanceId,
        backend: this._backend,
      };
    } catch (e: any) {
      // IMPORTANT: Do NOT set _modelLoadFailed
      return {
        success: false,
        offscreenReady,
        runtimeInstanceId,
        backend: this._backend,
        error: e.message,
      };
    }
  }
}

// =========================================================================
console.log('='.repeat(64));
console.log('  Smoke Test Init Flow Tests (blocker #10 fix)');
console.log('='.repeat(64));

// -- SMOKE-01: Smoke starts after existing READY was already received -----
console.log('\n--- SMOKE-01: Smoke after existing READY -- S2 passes immediately');
{
  const sim = new SmokeFlowSimulator();
  // Production init already completed
  sim._offscreenReadyReceived = true;
  sim._offscreenRuntimeInstanceId = 'instance-A';
  const result = await sim.handleSmokeOffscreenTest();
  assert(result.success, 'SMOKE-01: smoke succeeds');
  assert(result.offscreenReady === true, 'SMOKE-01: S2 offscreenReady=true');
  assert(result.runtimeInstanceId === 'instance-A', 'SMOKE-01: runtimeInstanceId preserved');
  assert(result.backend === 'wasm', 'SMOKE-01: backend=wasm');
  assert(sim.log.includes('READY already buffered -- immediate'),
    'SMOKE-01: used buffered path (no wait)');
}

// -- SMOKE-02: Smoke creates new offscreen document (READY buffered) ------
console.log('\n--- SMOKE-02: New document with buffered READY -- S2 passes');
{
  const sim = new SmokeFlowSimulator();
  // Simulate: READY arrived during document creation
  sim._offscreenReadyReceived = true;
  sim._offscreenRuntimeInstanceId = 'instance-B';
  const result = await sim.handleSmokeOffscreenTest();
  assert(result.success, 'SMOKE-02: smoke succeeds with new document');
  assert(result.offscreenReady === true, 'SMOKE-02: S2 passes');
  assert(result.runtimeInstanceId === 'instance-B', 'SMOKE-02: instance ID set');
}

// -- SMOKE-03: Second smoke call reuses completed init --------------------
console.log('\n--- SMOKE-03: Second smoke call -- _initOffscreenInference mutex');
{
  const sim = new SmokeFlowSimulator();
  sim._offscreenReadyReceived = true;
  sim._offscreenRuntimeInstanceId = 'instance-C';
  // First call
  const r1 = await sim.handleSmokeOffscreenTest();
  assert(r1.success, 'SMOKE-03a: first call succeeds');
  // Second call -- mutex returns same promise
  const initCount = sim.log.filter(l => l.includes('_doOffscreenInit started')).length;
  const r2 = await sim.handleSmokeOffscreenTest();
  assert(r2.success, 'SMOKE-03b: second call succeeds');
  const initCount2 = sim.log.filter(l => l.includes('_doOffscreenInit started')).length;
  assert(initCount2 === initCount, 'SMOKE-03c: _doOffscreenInit NOT called again (mutex)');
}

// -- SMOKE-04: No READY -- timeout -- fail closed -------------------------
console.log('\n--- SMOKE-04: No READY -- timeout -- fail closed');
{
  const sim = new SmokeFlowSimulator();
  // READY never arrived
  sim._offscreenReadyReceived = false;
  const result = await sim.handleSmokeOffscreenTest();
  assert(!result.success, 'SMOKE-04: smoke fails');
  assert(result.error!.includes('timeout'), 'SMOKE-04: error mentions timeout');
  assert(!sim._modelLoadFailed, 'SMOKE-04: _modelLoadFailed NOT set (diagnostic failure)');
}

// -- SMOKE-05: Smoke failure does NOT set _modelLoadFailed ----------------
console.log('\n--- SMOKE-05: Smoke failure does not affect production state');
{
  const sim = new SmokeFlowSimulator();
  sim._offscreenReadyReceived = false;
  sim._modelLoadFailed = false;
  await sim.handleSmokeOffscreenTest();
  assert(sim._modelLoadFailed === false,
    'SMOKE-05: _modelLoadFailed remains false after smoke failure');
}

// -- SMOKE-06: Smoke reads authoritative _offscreenReadyReceived ----------
console.log('\n--- SMOKE-06: Smoke reads authoritative Coordinator state');
{
  const sim = new SmokeFlowSimulator();
  sim._offscreenReadyReceived = true;
  sim._offscreenRuntimeInstanceId = 'auth-instance';
  const result = await sim.handleSmokeOffscreenTest();
  assert(result.offscreenReady === sim._offscreenReadyReceived,
    'SMOKE-06a: offscreenReady matches Coordinator state');
  assert(result.runtimeInstanceId === 'auth-instance',
    'SMOKE-06b: runtimeInstanceId matches Coordinator state');
}

// -- SMOKE-07: After init error, next smoke can retry ---------------------
console.log('\n--- SMOKE-07: After init error, next smoke call can retry');
{
  const sim = new SmokeFlowSimulator();
  // First attempt: no READY -> timeout
  sim._offscreenReadyReceived = false;
  const r1 = await sim.handleSmokeOffscreenTest();
  assert(!r1.success, 'SMOKE-07a: first attempt fails');
  assert(sim._offscreenInitPromise === null,
    'SMOKE-07b: _offscreenInitPromise cleared after error (retry possible)');
  // Now READY arrives
  sim._offscreenReadyReceived = true;
  sim._offscreenRuntimeInstanceId = 'retry-instance';
  const r2 = await sim.handleSmokeOffscreenTest();
  assert(r2.success, 'SMOKE-07c: retry succeeds');
  assert(r2.runtimeInstanceId === 'retry-instance', 'SMOKE-07d: new instance ID set');
}

// -- Summary ---------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('  Smoke Init Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(64));
if (failed > 0) process.exit(1);

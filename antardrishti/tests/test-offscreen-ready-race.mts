/**
 * ANTARDRISHTI -- Offscreen Ready Race Condition Tests
 *
 * Proves the buffer fix for Phase 9 blocker #7.
 *
 * Root cause of the race:
 *   OFFSCREEN_READY can arrive DURING _ensureOffscreenDocument() await,
 *   BEFORE _waitForOffscreenReady() installs its resolver.
 *   Without buffering, the signal is lost and the 10s timeout fires.
 *
 * The fix: _offscreenReadyReceived persists the signal.
 *   _waitForOffscreenReady() checks it first and resolves immediately
 *   if READY already arrived.
 *
 * Run: npx tsx tests/test-offscreen-ready-race.mts
 */

// -- Test framework --------------------------------------------------------
let passed = 0; let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  OK  ' + msg); passed++; }
  else { console.error('  FAIL ' + msg); failed++; }
}
async function assertRejects(fn: () => Promise<void>, msg: string): Promise<void> {
  try { await fn(); console.error('  FAIL (no throw) ' + msg); failed++; }
  catch { console.log('  OK  ' + msg); passed++; }
}

// -- Minimal coordinator state simulator -----------------------------------
// Simulates only the _offscreenReadyReceived / _waitForOffscreenReady logic.
// No Chrome API required.

class OffscreenReadyStateMachine {
  _offscreenReadyReceived = false;
  _offscreenRuntimeInstanceId: string | null = null;
  _offscreenReadyResolve: (() => void) | null = null;
  _offscreenReadyReject: ((err: Error) => void) | null = null;
  log: string[] = [];

  // Simulates _handleOffscreenMessage for OFFSCREEN_READY
  receiveReady(runtimeInstanceId: string): void {
    this.log.push('READY received instance=' + runtimeInstanceId);
    // Buffer the signal -- idempotent
    this._offscreenReadyReceived = true;
    this._offscreenRuntimeInstanceId = runtimeInstanceId;
    // Resolve waiting promise if installed
    if (this._offscreenReadyResolve) {
      this._offscreenReadyResolve();
      this._offscreenReadyResolve = null;
      this._offscreenReadyReject = null;
    }
  }

  // Simulates _waitForOffscreenReady(timeoutMs)
  waitForReady(timeoutMs: number): Promise<void> {
    // Buffer check: READY may have arrived before this waiter
    if (this._offscreenReadyReceived) {
      this.log.push('READY already buffered -- immediate resolve instance=' +
        this._offscreenRuntimeInstanceId);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this._offscreenReadyResolve = resolve;
      this._offscreenReadyReject = reject;
      setTimeout(() => {
        if (this._offscreenReadyResolve) {
          this.log.push('READY TIMEOUT after ' + timeoutMs + 'ms');
          this._offscreenReadyResolve = null;
          this._offscreenReadyReject = null;
          reject(new Error('Offscreen READY timeout -- fail-closed'));
        }
      }, timeoutMs);
    });
  }

  // Simulates disposal (INFERENCE_ERROR or explicit dispose)
  dispose(): void {
    this._offscreenReadyReceived = false;
    this._offscreenRuntimeInstanceId = null;
    this._offscreenReadyResolve = null;
    this._offscreenReadyReject = null;
    this.log.push('disposed -- ready state reset');
  }
}

// ==========================================================================
console.log('='.repeat(64));
console.log('  Offscreen READY Race Condition Tests (blocker #7 fix)');
console.log('='.repeat(64));

// -- RACE-01: READY arrives BEFORE waitForReady() is called ---------------
console.log('\n--- RACE-01: READY arrives before waitForReady()');
{
  const sm = new OffscreenReadyStateMachine();
  // Simulate: READY arrives during _ensureOffscreenDocument() await
  sm.receiveReady('instance-A');
  // Then _waitForOffscreenReady() is called -- must resolve immediately
  const t0 = Date.now();
  await sm.waitForReady(10000);
  const elapsed = Date.now() - t0;
  assert(elapsed < 50, 'RACE-01: waitForReady() resolves immediately when READY already buffered (elapsed=' + elapsed + 'ms)');
  assert(sm._offscreenReadyReceived === true, 'RACE-01: _offscreenReadyReceived remains true');
  assert(sm._offscreenRuntimeInstanceId === 'instance-A', 'RACE-01: runtimeInstanceId preserved');
  assert(sm.log[0].includes('READY received'), 'RACE-01: READY was logged');
  assert(sm.log[1].includes('already buffered'), 'RACE-01: buffer path was taken');
}

// -- RACE-02: waitForReady() installs BEFORE READY arrives ----------------
console.log('\n--- RACE-02: waitForReady() installs before READY arrives');
{
  const sm = new OffscreenReadyStateMachine();
  let resolved = false;
  const waitPromise = sm.waitForReady(5000).then(() => { resolved = true; });
  // READY arrives 10ms later
  await new Promise<void>(r => setTimeout(r, 10));
  assert(!resolved, 'RACE-02: not yet resolved before READY arrives');
  sm.receiveReady('instance-B');
  await waitPromise;
  assert(resolved, 'RACE-02: resolved after READY arrives');
  assert(sm._offscreenRuntimeInstanceId === 'instance-B', 'RACE-02: instance ID set');
  assert(sm._offscreenReadyResolve === null, 'RACE-02: resolver cleared after use');
}

// -- RACE-03: READY arrives multiple times -- idempotent ------------------
console.log('\n--- RACE-03: Multiple READY messages are idempotent');
{
  const sm = new OffscreenReadyStateMachine();
  sm.receiveReady('instance-C');
  sm.receiveReady('instance-C');
  sm.receiveReady('instance-C');
  assert(sm._offscreenReadyReceived === true, 'RACE-03: state still ready after 3x READY');
  assert(sm._offscreenRuntimeInstanceId === 'instance-C', 'RACE-03: instance ID unchanged');
  // Must resolve immediately
  const t0 = Date.now();
  await sm.waitForReady(5000);
  assert(Date.now() - t0 < 50, 'RACE-03: waitForReady still resolves immediately');
}

// -- RACE-03b: New instance ID in second READY updates instanceId ----------
console.log('\n--- RACE-03b: New instance ID updates _offscreenRuntimeInstanceId');
{
  const sm = new OffscreenReadyStateMachine();
  sm.receiveReady('instance-old');
  sm.receiveReady('instance-new');
  assert(sm._offscreenRuntimeInstanceId === 'instance-new',
    'RACE-03b: New instance ID replaces old one');
}

// -- RACE-04: Existing document -- PING -> READY -> resolves --------------
console.log('\n--- RACE-04: Existing document -- PING causes READY, waiter resolves');
{
  const sm = new OffscreenReadyStateMachine();
  // Document already existed -- coordinator sends PING
  // PING travels to offscreen which responds with READY
  // Simulate the READY arriving after the waiter is set
  const waitPromise = sm.waitForReady(5000);
  // (Simulating PING round-trip latency: 5ms)
  setTimeout(() => sm.receiveReady('instance-existing'), 5);
  await waitPromise;
  assert(sm._offscreenReadyReceived === true, 'RACE-04: READY received via PING round-trip');
  assert(sm._offscreenRuntimeInstanceId === 'instance-existing', 'RACE-04: instance ID set');
}

// -- RACE-05: Timeout when READY never arrives -- fail closed --------------
console.log('\n--- RACE-05: Timeout fires when READY never arrives');
{
  const sm = new OffscreenReadyStateMachine();
  let timedOut = false;
  let errorMsg = '';
  try {
    await sm.waitForReady(50);  // very short timeout for test
  } catch (e: any) {
    timedOut = true;
    errorMsg = e.message;
  }
  assert(timedOut, 'RACE-05: timeout throws');
  assert(errorMsg.includes('timeout'), 'RACE-05: error message mentions timeout');
  assert(sm._offscreenReadyReceived === false, 'RACE-05: ready state not set on timeout');
  assert(sm._offscreenReadyResolve === null, 'RACE-05: resolver cleared after timeout');
  assert(sm.log.some(l => l.includes('TIMEOUT')), 'RACE-05: TIMEOUT logged');
}

// -- RACE-06: Dispose resets state -- next lifecycle needs fresh READY ----
console.log('\n--- RACE-06: Dispose/recreate resets ready state');
{
  const sm = new OffscreenReadyStateMachine();
  // First lifecycle
  sm.receiveReady('instance-D');
  assert(sm._offscreenReadyReceived === true, 'RACE-06: ready before dispose');
  // Dispose (e.g. INFERENCE_ERROR fatal)
  sm.dispose();
  assert(sm._offscreenReadyReceived === false, 'RACE-06: ready cleared after dispose');
  assert(sm._offscreenRuntimeInstanceId === null, 'RACE-06: instanceId cleared after dispose');
  // Next lifecycle: waitForReady() must wait, not resolve immediately
  let earlyResolve = false;
  const p = sm.waitForReady(5000);
  p.then(() => { earlyResolve = true; });
  // Check 5ms later -- should NOT have resolved yet
  await new Promise<void>(r => setTimeout(r, 5));
  assert(!earlyResolve, 'RACE-06: after dispose, waitForReady() does NOT resolve immediately');
  // Now READY arrives for new instance
  sm.receiveReady('instance-E');
  await p;
  assert(earlyResolve, 'RACE-06: resolves after new READY on fresh lifecycle');
  assert(sm._offscreenRuntimeInstanceId === 'instance-E', 'RACE-06: new instance ID set');
}

// -- RACE-07: waitForReady with buffered READY + fresh waiter is idempotent
console.log('\n--- RACE-07: Buffered READY is idempotent for multiple waiters');
{
  const sm = new OffscreenReadyStateMachine();
  sm.receiveReady('instance-F');
  // Multiple callers can await -- all resolve immediately
  await Promise.all([
    sm.waitForReady(5000),
    sm.waitForReady(5000),
    sm.waitForReady(5000),
  ]);
  assert(sm._offscreenReadyReceived === true, 'RACE-07: state still ready after multiple awaits');
}

// -- Summary ---------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log('  Race Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(64));
if (failed > 0) process.exit(1);

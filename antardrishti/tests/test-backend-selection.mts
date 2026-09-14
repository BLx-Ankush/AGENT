import { detectRuntime } from '../packages/model-runner/src/runtime.js';

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log('  PASS: ' + msg); passed++; }
  else       { console.error('  FAIL: ' + msg); failed++; }
}
function section(title) { console.log('\n-- ' + title + ' --'); }
function mockNavigator(cfg) {
  const gpu = cfg.hasGpu
    ? { requestAdapter: async () => cfg.adapterNull ? null : { name: 'MockGPU' } }
    : undefined;
  // Node.js v24+ makes navigator a read-only getter; use defineProperty to override
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: cfg.ua, ...(gpu ? { gpu } : {}) },
    configurable: true,
    writable: true,
  });
}
function clearNavigator() {
  Object.defineProperty(globalThis, 'navigator', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// A. Forced WASM
section('A. forced wasm');
mockNavigator({ hasGpu: true, adapterNull: false, ua: 'chrome/120' });
{ const rt = await detectRuntime('wasm');
  assert(rt.requestedBackend === 'wasm',  'A1 requestedBackend=wasm');
  assert(rt.selectedBackend  === 'wasm',  'A1 selectedBackend=wasm (WebGPU available but forced)');
  assert(rt.webgpuAvailable  === true,    'A1 webgpuAvailable=true'); }
mockNavigator({ hasGpu: true, adapterNull: true, ua: 'chrome/120' });
{ const rt = await detectRuntime('wasm');
  assert(rt.requestedBackend === 'wasm',  'A2 requestedBackend=wasm');
  assert(rt.selectedBackend  === 'wasm',  'A2 selectedBackend=wasm (adapter null, forced)');
  assert(rt.webgpuAvailable  === false,   'A2 webgpuAvailable=false'); }
mockNavigator({ hasGpu: false, adapterNull: false, ua: 'chrome/120' });
{ const rt = await detectRuntime('wasm');
  assert(rt.requestedBackend === 'wasm',  'A3 requestedBackend=wasm');
  assert(rt.selectedBackend  === 'wasm',  'A3 selectedBackend=wasm (no GPU)'); }
clearNavigator();

// B. Forced WebGPU
section('B. forced webgpu');
mockNavigator({ hasGpu: true, adapterNull: false, ua: 'chrome/120' });
{ const rt = await detectRuntime('webgpu');
  assert(rt.requestedBackend === 'webgpu', 'B1 requestedBackend=webgpu');
  assert(rt.selectedBackend  === 'webgpu', 'B1 selectedBackend=webgpu (adapter ok)');
  assert(rt.webgpuAvailable  === true,     'B1 webgpuAvailable=true'); }
mockNavigator({ hasGpu: true, adapterNull: true, ua: 'chrome/120' });
{ const rt = await detectRuntime('webgpu');
  assert(rt.requestedBackend === 'webgpu', 'B2 requestedBackend=webgpu');
  assert(rt.selectedBackend  === 'wasm',   'B2 selectedBackend=wasm fallback (adapter null)');
  assert(rt.webgpuAvailable  === false,    'B2 webgpuAvailable=false'); }
clearNavigator();

// C. Auto / Chrome
section('C. auto Chrome');
mockNavigator({ hasGpu: true, adapterNull: false, ua: 'Mozilla/5.0 chrome/120' });
{ const rt = await detectRuntime('auto');
  assert(rt.requestedBackend === 'auto',   'C1 requestedBackend=auto');
  assert(rt.browser          === 'chrome', 'C1 browser=chrome');
  assert(rt.selectedBackend  === 'webgpu', 'C1 Chrome auto -> WebGPU when available'); }
mockNavigator({ hasGpu: false, adapterNull: false, ua: 'Mozilla/5.0 chrome/120' });
{ const rt = await detectRuntime('auto');
  assert(rt.requestedBackend === 'auto',   'C2 requestedBackend=auto');
  assert(rt.browser          === 'chrome', 'C2 browser=chrome');
  assert(rt.selectedBackend  === 'wasm',   'C2 Chrome auto -> WASM when no WebGPU'); }
clearNavigator();

// D. Auto / Firefox
section('D. auto Firefox');
mockNavigator({ hasGpu: true, adapterNull: false, ua: 'Mozilla/5.0 firefox/120' });
{ const rt = await detectRuntime('auto');
  assert(rt.requestedBackend === 'auto',    'D1 requestedBackend=auto');
  assert(rt.browser          === 'firefox', 'D1 browser=firefox');
  assert(rt.selectedBackend  === 'wasm',    'D1 Firefox auto -> WASM-first even with WebGPU'); }
mockNavigator({ hasGpu: true, adapterNull: false, ua: 'Mozilla/5.0 firefox/120' });
{ const rt = await detectRuntime('webgpu');
  assert(rt.requestedBackend === 'webgpu',  'D2 requestedBackend=webgpu');
  assert(rt.browser          === 'firefox', 'D2 browser=firefox');
  assert(rt.selectedBackend  === 'webgpu',  'D2 Firefox forced webgpu -> webgpu'); }
clearNavigator();

// Summary
console.log('');
console.log('=====================================================');
console.log('  Backend Selection Tests: ' + passed + ' passed, ' + failed + ' failed');
console.log('=====================================================');
if (failed > 0) process.exit(1);
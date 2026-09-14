/**
 * ANTARDRISHTI — Runtime Backend Detection
 *
 * Detects available inference backends (WebGPU, WASM) at runtime.
 * Supports an explicit backend override via chrome.storage.local
 * so Phase 9 benchmarking can force a specific backend without
 * depending on Chrome command-line flags or hardware availability.
 *
 * Storage key: 'antardrishti_backend'
 * Valid values: 'wasm' | 'webgpu' | 'auto'
 *
 * To force WASM in DevTools Service Worker console:
 *   chrome.storage.local.set({ antardrishti_backend: 'wasm' })
 * Then reload the extension.
 *
 * To revert to auto:
 *   chrome.storage.local.remove('antardrishti_backend')
 */

import type { RuntimeCapabilities, InferenceBackend, BackendRequest } from './types';

/** Chrome storage key for the backend override. */
export const BACKEND_OVERRIDE_KEY = 'antardrishti_backend';

/**
 * Read an explicit backend override from chrome.storage.local.
 *
 * Returns 'auto' if:
 *   - not in an extension context (no chrome API)
 *   - key is not set
 *   - value is unrecognised
 *
 * Set with:
 *   chrome.storage.local.set({ antardrishti_backend: 'wasm' })
 */
export async function readBackendOverride(): Promise<BackendRequest> {
  try {
    const chrome_ = (globalThis as any).chrome;
    if (!chrome_?.storage?.local) return 'auto';

    // Chrome MV3 (Chrome 88+): chrome.storage.local.get() returns a Promise.
    // This also works with Node.js test shims that return Promise.resolve({}).
    // The callback form would hang in test context because shims don't invoke it.
    const result = await chrome_.storage.local.get([BACKEND_OVERRIDE_KEY]);
    const val = result?.[BACKEND_OVERRIDE_KEY];
    if (val === 'wasm' || val === 'webgpu' || val === 'auto') {
      return val as BackendRequest;
    }
    return 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Detect available ML inference backends and select the best one.
 *
 * @param forcedBackend - explicit backend request ('auto' = hardware-driven).
 *   Read from chrome.storage.local by the caller (loadProductionModels).
 *
 * Selection logic:
 *   forced='wasm'   → selectedBackend='wasm'  (ignores WebGPU availability)
 *   forced='webgpu' → selectedBackend='webgpu' if available, else 'wasm'
 *   forced='auto'   → Chrome: WebGPU→WASM; Firefox: WASM→WebGPU
 */
export async function detectRuntime(
  forcedBackend: BackendRequest = 'auto',
): Promise<RuntimeCapabilities> {
  const browser = detectBrowser();
  const webgpuAvailable = await checkWebGPU();
  const wasmAvailable = checkWASM();

  let selectedBackend: InferenceBackend;

  if (forcedBackend === 'wasm') {
    // Explicit WASM request — skip WebGPU entirely, no fallback attempt
    selectedBackend = 'wasm';
  } else if (forcedBackend === 'webgpu') {
    // Explicit WebGPU request — use WebGPU if available, otherwise WASM
    selectedBackend = webgpuAvailable ? 'webgpu' : 'wasm';
  } else {
    // Auto: browser-preference heuristic
    if (browser === 'firefox') {
      // Firefox: WASM-first (contract §3)
      selectedBackend = wasmAvailable ? 'wasm' : webgpuAvailable ? 'webgpu' : 'cpu';
    } else {
      // Chrome: WebGPU preferred (contract §3)
      selectedBackend = webgpuAvailable ? 'webgpu' : wasmAvailable ? 'wasm' : 'cpu';
    }
  }

  const result: RuntimeCapabilities = {
    webgpuAvailable,
    wasmAvailable,
    requestedBackend: forcedBackend,
    selectedBackend,
    browser,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  };

  // Required startup log sequence (§6)
  console.log(`[ModelRuntime] browser=${browser}`);
  console.log(`[ModelRuntime] requestedBackend=${forcedBackend}`);
  console.log(`[ModelRuntime] webgpuAvailable=${webgpuAvailable}`);
  console.log(`[ModelRuntime] wasmAvailable=${wasmAvailable}`);
  console.log(`[ModelRuntime] selectedBackend=${selectedBackend}`);
  if (forcedBackend !== 'auto' && forcedBackend !== selectedBackend) {
    // Only if forced backend was unavailable and we fell back
    console.warn(`[ModelRuntime] requestedBackend=${forcedBackend} unavailable; fell back to ${selectedBackend}`);
  }

  return result;
}

async function checkWebGPU(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined') return false;
    if (!('gpu' in navigator)) return false;
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

function checkWASM(): boolean {
  try {
    return typeof WebAssembly !== 'undefined' &&
      typeof WebAssembly.instantiate === 'function';
  } catch {
    return false;
  }
}

function detectBrowser(): 'chrome' | 'firefox' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('firefox')) return 'firefox';
  if (ua.includes('chrome') || ua.includes('chromium')) return 'chrome';
  return 'unknown';
}

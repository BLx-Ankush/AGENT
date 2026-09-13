/**
 * ANTARDRISHTI — Runtime Backend Detection
 *
 * Detects available inference backends (WebGPU, WASM)
 * at runtime. Does not assume any backend is available.
 */

import type { RuntimeCapabilities, InferenceBackend } from './types';

/**
 * Detect available ML inference backends.
 * Chrome: prefer WebGPU, fallback WASM
 * Firefox: WASM-first, WebGPU optional
 */
export async function detectRuntime(): Promise<RuntimeCapabilities> {
  const browser = detectBrowser();
  const webgpuAvailable = await checkWebGPU();
  const wasmAvailable = checkWASM();

  let selectedBackend: InferenceBackend;

  if (browser === 'firefox') {
    // Firefox: WASM-first (contract §3)
    selectedBackend = wasmAvailable ? 'wasm' : webgpuAvailable ? 'webgpu' : 'cpu';
  } else {
    // Chrome: WebGPU preferred (contract §3)
    selectedBackend = webgpuAvailable ? 'webgpu' : wasmAvailable ? 'wasm' : 'cpu';
  }

  const result: RuntimeCapabilities = {
    webgpuAvailable,
    wasmAvailable,
    selectedBackend,
    browser,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  };

  // Required startup log sequence (Phase 9 §7)
  console.log(`[ModelRuntime] browser=${browser}`);
  console.log(`[ModelRuntime] webgpu=${webgpuAvailable}`);
  console.log(`[ModelRuntime] wasm=${wasmAvailable}`);
  console.log(`[ModelRuntime] selectedBackend=${selectedBackend}`);
  console.log('[ModelRunner] Runtime capabilities:', result);
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

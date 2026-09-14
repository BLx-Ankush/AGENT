/**
 * ANTARDRISHTI — ONNX Session Wrapper
 *
 * Wraps ONNX Runtime Web behind the InferenceSession interface.
 * Handles model loading, SHA-256 hash verification, backend selection,
 * and per-inference metrics.
 *
 * ONNX Runtime Web is statically imported so esbuild bundles it at
 * compile time. This is required for Chrome MV3 service workers, which
 * reject any service worker code that CONTAINS a dynamic import() call
 * — even inside dead-code paths that are never executed.
 *
 * The ortMv3Plugin in build.mjs patches ORT's internal dynamic import()
 * (the thread worker loader, dead at numThreads=1) out of the bundle
 * before esbuild processes it, eliminating all import() from the SW.
 */

import type {
  InferenceSession,
  InferenceMetrics,
  ModelManifest,
  InferenceBackend,
} from './types';

// STATIC import of WASM-only ORT bundle.
// esbuild resolves this to ort.wasm.bundle.min.mjs (71KB) at build time.
// No runtime import() call is emitted by our code.
// The ortMv3Plugin in build.mjs patches out ORT's own dead-code import()
// so the final service-worker.js contains zero import() expressions.
import * as _ortWasm from 'onnxruntime-web/wasm';

/**
 * ONNX Runtime Web inference session implementation.
 *
 * Usage:
 *   const session = new OnnxSession(manifest, backend);
 *   await session.initialize();
 *   const { outputs, metrics } = await session.run(inputs, shapes);
 *   session.dispose();
 */
export class OnnxSession implements InferenceSession {
  readonly manifest: ModelManifest;
  private _backend: InferenceBackend;
  private _isInitialized = false;
  private _initTimeMs = 0;
  private _inferenceCount = 0;
  private _onnxSession: any = null;
  private _ort: any = null;

  constructor(manifest: ModelManifest, backend: InferenceBackend) {
    this.manifest = manifest;
    this._backend = backend;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get backend(): InferenceBackend {
    return this._backend;
  }

  async initialize(): Promise<InferenceMetrics> {
    const startTime = performance.now();

    // ── Load + configure ONNX Runtime ───────────────────────────
    // CRITICAL: ORT env (wasmPaths, numThreads) MUST be configured
    // before any InferenceSession.create() call. Doing it inside
    // loadOnnxRuntime() ensures it is always applied first.
    try {
      this._ort = await this.loadOnnxRuntime();
    } catch (e) {
      console.error('[OnnxSession] Failed to load ONNX Runtime:', e);
      throw new Error(`ONNX Runtime load failed: ${e}`);
    }

    // ── Load + verify model bytes ────────────────────────────────
    const modelBytes = await this.loadModelBytes();
    await this.verifyModelHash(modelBytes);

    // ── Configure execution providers ───────────────────────────
    const executionProviders = this.getExecutionProviders();
    const sessionOptions: any = {
      executionProviders,
      graphOptimizationLevel: 'all',
    };

    // ── Create ONNX session ──────────────────────────────────────
    try {
      this._onnxSession = await this._ort.InferenceSession.create(
        modelBytes,
        sessionOptions,
      );
      console.log(`[ModelRuntime] backend=${this._backend} model=${this.manifest.id}`);
    } catch (e) {
      // WebGPU session creation failed → fall back to WASM
      // The ORT env is already configured for WASM, so this is safe.
      if (this._backend === 'webgpu') {
        console.warn(
          '[OnnxSession] WebGPU session creation failed, falling back to WASM.',
          'Error:', (e as Error).message,
        );
        this._backend = 'wasm';
        sessionOptions.executionProviders = [{ name: 'wasm' }];
        this._onnxSession = await this._ort.InferenceSession.create(
          modelBytes,
          sessionOptions,
        );
        console.log(`[ModelRuntime] backend=wasm (fallback) model=${this.manifest.id}`);
      } else {
        throw e;
      }
    }

    this._isInitialized = true;
    this._initTimeMs = performance.now() - startTime;

    const metrics: InferenceMetrics = {
      modelId: this.manifest.id,
      backend: this._backend,
      modelSizeBytes: this.manifest.sizeBytes,
      initTimeMs: this._initTimeMs,
      isCold: true,
      inferenceMs: 0,
      preprocessMs: 0,
      postprocessMs: 0,
      totalMs: this._initTimeMs,
      processedPixels: 0,
      timestamp: new Date().toISOString(),
    };

    // Required log format (Phase 9 §7): [OnnxSession] Initialized: {model} backend={backend}
    console.log(`[OnnxSession] Initialized: ${this.manifest.id} backend=${this._backend} initMs=${Math.round(this._initTimeMs)}`);


    return metrics;
  }

  async run(
    inputs: Map<string, Float32Array>,
    inputShapes: Map<string, number[]>,
  ): Promise<{
    outputs: Map<string, Float32Array>;
    outputShapes: Map<string, number[]>;
    metrics: InferenceMetrics;
  }> {
    if (!this._isInitialized || !this._onnxSession || !this._ort) {
      throw new Error('Session not initialized');
    }

    const preprocessStart = performance.now();

    // Create ONNX tensors from inputs
    const feeds: Record<string, any> = {};
    let processedPixels = 0;

    for (const [name, data] of inputs) {
      const shape = inputShapes.get(name);
      if (!shape) throw new Error(`Missing shape for input: ${name}`);
      feeds[name] = new this._ort.Tensor('float32', data, shape);

      // Estimate processed pixels from tensor shape
      if (shape.length >= 3) {
        processedPixels += shape[shape.length - 1] * shape[shape.length - 2];
      }
    }

    const preprocessMs = performance.now() - preprocessStart;
    const inferenceStart = performance.now();

    // Run inference
    const results = await this._onnxSession.run(feeds);

    const inferenceMs = performance.now() - inferenceStart;
    const postprocessStart = performance.now();

    // Extract outputs
    const outputs = new Map<string, Float32Array>();
    const outputShapes = new Map<string, number[]>();

    for (const [name, tensor] of Object.entries(results)) {
      const t = tensor as any;
      outputs.set(name, new Float32Array(t.data));
      outputShapes.set(name, [...t.dims]);
    }

    const postprocessMs = performance.now() - postprocessStart;
    this._inferenceCount++;

    const metrics: InferenceMetrics = {
      modelId: this.manifest.id,
      backend: this._backend,
      modelSizeBytes: this.manifest.sizeBytes,
      initTimeMs: this._initTimeMs,
      isCold: this._inferenceCount === 1,
      inferenceMs,
      preprocessMs,
      postprocessMs,
      totalMs: preprocessMs + inferenceMs + postprocessMs,
      processedPixels,
      timestamp: new Date().toISOString(),
    };

    return { outputs, outputShapes, metrics };
  }

  dispose(): void {
    if (this._onnxSession) {
      try {
        this._onnxSession.release?.();
      } catch {
        // Ignore disposal errors
      }
      this._onnxSession = null;
    }
    this._isInitialized = false;
    console.log('[OnnxSession] Disposed:', this.manifest.id);
  }

  // ── Private helpers ────────────────────────────────────

  private getExecutionProviders(): Array<{ name: string } | string> {
    switch (this._backend) {
      case 'webgpu':
        return [{ name: 'webgpu' }, { name: 'wasm' }];
      case 'wasm':
        return [{ name: 'wasm' }];
      default:
        return [{ name: 'wasm' }];
    }
  }

  /**
   * Load ONNX Runtime Web for MV3 service worker.
   *
   * THIRD ROOT CAUSE FIX (import() is disallowed on ServiceWorkerGlobalScope):
   *
   *   Chrome MV3 rejects any service worker that CONTAINS `import()` syntax
   *   at PARSE TIME — even inside dead code that is never executed.
   *
   *   ORT 1.29.0 WASM bundle contains:
   *     us = async n => (await import(webpackIgnore n)).default
   *   This is a dead-code worker loader (0 call sites at numThreads=1).
   *   But Chrome sees `import(` and immediately throws TypeError.
   *
   *   FIX 1 (build time): ortMv3Plugin in build.mjs replaces ORT's
   *     import() with a stub before esbuild bundles the code.
   *
   *   FIX 2 (this file): Static `import * as _ortWasm from 'onnxruntime-web/wasm'`
   *     at module level. esbuild bundles ORT inline at compile time.
   *     Our own code emits zero import() calls.
   *
   *   FIX 3 (runtime): Set proxy=false + wasmBinary to prevent ORT from
   *     ever trying to load a worker or blob URL.
   *
   * WASM runtime assets (extension-local, no CDN):
   *   ort-wasm-simd-threaded.mjs   → worker bootstrap (not used at numThreads=1)
   *   ort-wasm-simd-threaded.wasm  → WASM binary (pre-fetched into wasmBinary)
   */
  private async loadOnnxRuntime(): Promise<any> {
    // ORT is statically imported at module level (_ortWasm).
    // No runtime import() call. MV3-safe.
    const ort = _ortWasm;

    // Configure ORT env exactly once across all 4 parallel sessions.
    // Uses a singleton Promise to prevent race on concurrent Promise.all()
    // initialization (4 sessions initialised simultaneously by coordinator).
    await OnnxSession.getOrtConfigPromise(ort);

    console.log('[OnnxSession] ORT runtime loaded (static import, WASM-only, MV3-safe)');
    return ort;
  }

  /**
   * Configure ORT WASM environment for MV3 service worker compatibility.
   *
   * MUST complete before any InferenceSession.create().
   * Singleton Promise ensures configuration runs exactly once even when
   * 4 sessions are initialised in parallel via Promise.all().
   *
   * Key settings:
   *   numThreads=1  — disables thread workers (no SharedArrayBuffer needed)
   *   proxy=false   — disables proxy worker (prevents blob URL + import())
   *   wasmBinary    — pre-fetched Uint8Array; ORT uses it directly, skipping
   *                   all URL-based loading and any internal import() calls
   *   wasmPaths     — set for internal path refs (defense-in-depth)
   */
  private static _ortConfigPromise: Promise<void> | null = null;

  private static getOrtConfigPromise(ort: any): Promise<void> {
    if (!OnnxSession._ortConfigPromise) {
      OnnxSession._ortConfigPromise = OnnxSession._doConfigureOrt(ort);
    }
    return OnnxSession._ortConfigPromise;
  }

  private static async _doConfigureOrt(ort: any): Promise<void> {
    // ── 1. Disable threading ─────────────────────────────────────────
    // numThreads=1: disables SIMD thread worker creation.
    // MV3 service workers have no SharedArrayBuffer / Atomics.wait().
    ort.env.wasm.numThreads = 1;

    // ── 2. Disable proxy worker ──────────────────────────────────
    // proxy=false (explicit, matching default): prevents ORT from creating
    // a blob URL worker and calling import(blobUrl) — which would also fail.
    ort.env.wasm.proxy = false;

    try {
      const chrome_ = (globalThis as any).chrome;
      const getUrl = chrome_?.runtime?.getURL;

      if (typeof getUrl === 'function') {
        const wasmUrl = getUrl.call(chrome_.runtime, 'ort/ort-wasm-simd-threaded.wasm');
        const mjsUrl  = getUrl.call(chrome_.runtime, 'ort/ort-wasm-simd-threaded.mjs');

        // ── 3. Pre-fetch WASM binary ──────────────────────────────
        // Provide WASM binary as Uint8Array so ORT skips all URL loading.
        // ORT code path: if (g) v.wasmBinary = g, v.locateFile = O => O
        // This prevents ORT from issuing any fetch or import() for the binary.
        const wasmResp = await fetch(wasmUrl);
        if (!wasmResp.ok) {
          throw new Error(`[OnnxSession] WASM binary fetch failed: HTTP ${wasmResp.status} ${wasmUrl}`);
        }
        const wasmBuf = await wasmResp.arrayBuffer();
        ort.env.wasm.wasmBinary = new Uint8Array(wasmBuf);

        // ── 4. Set explicit wasmPaths (defense-in-depth) ────────────
        // Covers any internal ORT path resolution that bypasses wasmBinary.
        // ORT 1.29 object format: { mjs: string, wasm: string }
        ort.env.wasm.wasmPaths = { mjs: mjsUrl, wasm: wasmUrl };

        console.log('[OnnxSession] WASM mjs  path=', mjsUrl);
        console.log('[OnnxSession] WASM wasm path=', wasmUrl);
        console.log('[OnnxSession] WASM binary pre-loaded:', wasmBuf.byteLength, 'bytes');

      } else {
        // ── Node.js test context: no chrome API ────────────────────
        // ORT uses its own WASM resolution (Node.js compatible path).
        console.log('[ModelRuntime] Non-extension context: default ORT path resolution');
      }
    } catch (err) {
      // Configuration error is fatal — surface it clearly.
      console.error('[OnnxSession] ORT env configuration failed:', err);
      throw err;
    }

    console.log('[ModelRuntime] ORT env configured:', {
      numThreads: ort.env.wasm.numThreads,
      proxy: ort.env.wasm.proxy,
      wasmBinary: ort.env.wasm.wasmBinary
        ? `Uint8Array(${ort.env.wasm.wasmBinary.byteLength} bytes)`
        : 'not set',
      wasmPaths: ort.env.wasm.wasmPaths ?? '(default)',
      simd: true,
    });
  }

  // Legacy public static kept for smoke-test compatibility
  static configureOrtEnv(_ort: any): void {
    // Configuration is now async (WASM binary pre-fetch).
    // Use getOrtConfigPromise() internally; this shim no-ops for external callers.
    console.warn('[OnnxSession] configureOrtEnv() is deprecated; configuration happens automatically.');
  }

  private async loadModelBytes(): Promise<ArrayBuffer> {
    // Load model from extension's local assets
    const url = chrome.runtime.getURL(this.manifest.modelPath);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Model load failed: ${response.status} ${this.manifest.modelPath}`);
    }
    return response.arrayBuffer();
  }

  /**
   * Verify model integrity against pinned SHA-256 hash.
   * Prevents tampered models from being loaded.
   */
  private async verifyModelHash(modelBytes: ArrayBuffer): Promise<void> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', modelBytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (hashHex !== this.manifest.sha256) {
      throw new Error(
        `Model integrity check failed for ${this.manifest.id}. ` +
        `Expected: ${this.manifest.sha256.substring(0, 16)}…, ` +
        `Got: ${hashHex.substring(0, 16)}…`,
      );
    }

    console.log('[OnnxSession] Model integrity verified:', this.manifest.id);
  }
}

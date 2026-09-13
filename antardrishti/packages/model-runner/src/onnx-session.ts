/**
 * ANTARDRISHTI — ONNX Session Wrapper
 *
 * Wraps ONNX Runtime Web behind the InferenceSession interface.
 * Handles model loading, SHA-256 hash verification, backend selection,
 * and per-inference metrics.
 *
 * ONNX Runtime Web is loaded dynamically to keep the bundle size
 * manageable and to support offscreen document / extension page hosts.
 */

import type {
  InferenceSession,
  InferenceMetrics,
  ModelManifest,
  InferenceBackend,
} from './types';

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
   * Load ONNX Runtime Web (WASM-only entry point) for MV3 service worker.
   *
   * SECOND ROOT CAUSE FIX:
   *   import('onnxruntime-web') loads ort.bundle.min.mjs (404KB) which
   *   includes the full JSEP/WebGPU execution provider. ORT auto-initialises
   *   the JSEP backend and loads ort-wasm-simd-threaded.jsep.mjs whose
   *   internal loader falls back to XMLHttpRequest (not in service workers).
   *
   *   FIX: import('onnxruntime-web/wasm') → ort.wasm.bundle.min.mjs (71KB).
   *   This is the WASM-EP-only bundle. JSEP/WebGPU EP is never registered.
   *   ort-wasm-simd-threaded.jsep.mjs is never touched.
   *
   * WASM runtime assets (extension-local, no CDN):
   *   ort-wasm-simd-threaded.mjs   → thread worker bootstrap (24KB)
   *   ort-wasm-simd-threaded.wasm  → WASM binary (13.3MB, SIMD)
   *
   * For a future WebGPU path, switch to import('onnxruntime-web/webgpu')
   * and configure jsep.mjs + jsep.wasm paths separately.
   */
  private async loadOnnxRuntime(): Promise<any> {
    let ort: any;
    try {
      // WASM-only ORT bundle — esbuild resolves to ort.wasm.bundle.min.mjs.
      // No JSEP/WebGPU EP registered. No jsep.mjs ever loaded.
      ort = await import('onnxruntime-web/wasm');
    } catch {
      // Fallback: ort loaded as global via script tag (offscreen page context)
      if ((globalThis as any).ort) {
        ort = (globalThis as any).ort;
      } else {
        throw new Error(
          'ONNX Runtime Web not available. Ensure onnxruntime-web/wasm is bundled.',
        );
      }
    }

    console.log('[OnnxSession] ORT runtime loaded (WASM-only bundle)');

    // Configure ORT WASM environment (once per extension lifetime)
    OnnxSession.configureOrtEnv(ort);

    return ort;
  }

  /**
   * Configure ORT WASM environment for MV3 service worker compatibility.
   *
   * MUST be called before any InferenceSession.create().
   * Static flag ensures configuration runs exactly once even when
   * 4 sessions are initialised in parallel via Promise.all().
   *
   * wasmPaths OBJECT format (confirmed from ORT 1.29 source):
   *   let c = o?.mjs   ← property key 'mjs'
   *   let m = o?.wasm  ← property key 'wasm'
   * NOT filename-keyed. NOT a string map.
   *
   * numThreads=1 ensures no SharedArrayBuffer is required:
   *   - MV3 service workers have no SAB and cannot call Atomics.wait()
   *   - ort-wasm-simd-threaded.wasm works at numThreads=1 (no threads activated)
   */
  private static _ortEnvConfigured = false;

  static configureOrtEnv(ort: any): void {
    if (OnnxSession._ortEnvConfigured) return;
    OnnxSession._ortEnvConfigured = true;

    // ── Disable threading (no SharedArrayBuffer in MV3 SW) ────
    ort.env.wasm.numThreads = 1;

    // ── Explicit WASM asset paths ─────────────────────────────
    // ORT 1.29 wasmPaths object API: { mjs: string, wasm: string }
    //   mjs  → thread worker bootstrap (loaded via new URL(O, mjs).href)
    //   wasm → WASM binary (loaded via locateFile returning this URL)
    // With numThreads=1 no worker thread is created, but providing
    // both URLs prevents any fallback URL-derivation that could hit XHR.
    try {
      const getUrl = (globalThis as any).chrome?.runtime?.getURL;
      if (typeof getUrl === 'function') {
        const mjsPath  = getUrl.call((globalThis as any).chrome.runtime, 'ort/ort-wasm-simd-threaded.mjs');
        const wasmPath = getUrl.call((globalThis as any).chrome.runtime, 'ort/ort-wasm-simd-threaded.wasm');

        ort.env.wasm.wasmPaths = { mjs: mjsPath, wasm: wasmPath };

        console.log('[OnnxSession] WASM mjs  path=', mjsPath);
        console.log('[OnnxSession] WASM wasm path=', wasmPath);
      }
    } catch {
      // Node.js test context — no chrome API. ORT uses its own resolver.
      console.log('[ModelRuntime] Non-extension context: default ORT path resolution');
    }

    console.log('[ModelRuntime] ORT env configured:', {
      numThreads: ort.env.wasm.numThreads,
      wasmPaths: ort.env.wasm.wasmPaths ?? '(default)',
      simd: true,
      threaded: false,
    });
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

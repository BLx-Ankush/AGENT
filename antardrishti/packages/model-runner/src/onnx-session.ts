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
   * Load ONNX Runtime Web and configure the WASM environment for
   * Chrome MV3 service worker compatibility.
   *
   * ROOT CAUSE FIX for "XMLHttpRequest is not defined":
   *   ORT 1.29 attempts to load its .wasm binary from a URL derived
   *   from import.meta.url. In service workers, window/document are
   *   absent. ORT's fallback path uses XMLHttpRequest, which is NOT
   *   available in service workers.
   *
   * FIX:
   *   1. Set ort.env.wasm.wasmPaths to chrome.runtime.getURL('ort/')
   *      → ORT uses fetch() on this explicit URL (no XHR fallback)
   *   2. Set ort.env.wasm.numThreads = 1
   *      → Disables SharedArrayBuffer/Worker threading requirement
   *      → Compatible with MV3 service workers (no SAB, no Atomics.wait)
   *   3. WASM binaries bundled extension-local in dist/ort/:
   *      ort-wasm-simd-threaded.wasm      → WASM backend
   *      ort-wasm-simd-threaded.jsep.wasm → WebGPU/JSEP backend
   *
   * SIMD: enabled (SIMD is supported in all Chromium service workers).
   * Threads: DISABLED (numThreads=1) — no SharedArrayBuffer required.
   * WebGPU (JSEP): available if navigator.gpu is present.
   */
  private async loadOnnxRuntime(): Promise<any> {
    let ort: any;
    try {
      // esbuild bundles onnxruntime-web inline into service-worker.js.
      // The .wasm binary is NOT inlined — it is loaded at runtime via
      // the configured wasmPaths URL.
      ort = await import('onnxruntime-web');
    } catch {
      // Fallback: ort loaded as global via script tag (offscreen page)
      if ((globalThis as any).ort) {
        ort = (globalThis as any).ort;
      } else {
        throw new Error(
          'ONNX Runtime Web not available. Ensure it is bundled with the extension.',
        );
      }
    }

    // Configure ORT WASM environment (once per extension lifetime)
    OnnxSession.configureOrtEnv(ort);

    return ort;
  }

  /**
   * Configure ORT WASM environment for MV3 service worker compatibility.
   * Must be called before any InferenceSession.create().
   *
   * This is a static method to guarantee it is only configured once
   * regardless of how many OnnxSession instances are created in parallel.
   */
  private static _ortEnvConfigured = false;

  static configureOrtEnv(ort: any): void {
    if (OnnxSession._ortEnvConfigured) return;
    OnnxSession._ortEnvConfigured = true;

    // ── WASM thread configuration ─────────────────────────────
    // numThreads=1: disables SharedArrayBuffer threading.
    // MV3 service workers do not have SharedArrayBuffer or Atomics.wait().
    // The threaded WASM binary (ort-wasm-simd-threaded.wasm) still works
    // correctly with numThreads=1 — threading is simply not activated.
    ort.env.wasm.numThreads = 1;

    // ── WASM binary path configuration ───────────────────────
    // Points ORT to the extension-local WASM binaries.
    // Prevents ORT from attempting to derive the path from import.meta.url
    // (which would produce a chrome-extension:// URL that ORT can't find)
    // and then falling back to the XHR loader (not available in SW).
    //
    // With an explicit string prefix, ORT uses fetch() on:
    //   <prefix>ort-wasm-simd-threaded.wasm        (WASM backend)
    //   <prefix>ort-wasm-simd-threaded.jsep.wasm   (WebGPU/JSEP backend)
    try {
      const wasmBase = (globalThis as any).chrome?.runtime?.getURL('ort/');
      if (wasmBase) {
        ort.env.wasm.wasmPaths = wasmBase;
        console.log('[ModelRuntime] ORT WASM paths configured:', wasmBase);
      }
    } catch {
      // Non-extension context (Node.js test): leave wasmPaths unset,
      // ORT will use the Node.js file resolver.
      console.log('[ModelRuntime] Non-extension context: using default ORT path resolution');
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

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

    // Dynamic import of ONNX Runtime Web
    // In production, this will be bundled with the extension
    try {
      this._ort = await this.loadOnnxRuntime();
    } catch (e) {
      console.error('[OnnxSession] Failed to load ONNX Runtime:', e);
      throw new Error(`ONNX Runtime load failed: ${e}`);
    }

    // Configure execution providers based on backend
    const executionProviders = this.getExecutionProviders();

    // Load model bytes
    const modelBytes = await this.loadModelBytes();

    // Verify model integrity
    await this.verifyModelHash(modelBytes);

    // Create ONNX session
    const sessionOptions: any = {
      executionProviders,
      graphOptimizationLevel: 'all',
    };

    try {
      this._onnxSession = await this._ort.InferenceSession.create(
        modelBytes,
        sessionOptions,
      );
    } catch (e) {
      // Fallback to WASM if WebGPU fails
      if (this._backend === 'webgpu') {
        console.warn('[OnnxSession] WebGPU failed, falling back to WASM');
        this._backend = 'wasm';
        sessionOptions.executionProviders = [{ name: 'wasm' }];
        this._onnxSession = await this._ort.InferenceSession.create(
          modelBytes,
          sessionOptions,
        );
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

    console.log('[OnnxSession] Initialized:', {
      model: this.manifest.id,
      backend: this._backend,
      initMs: Math.round(this._initTimeMs),
    });

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

  private async loadOnnxRuntime(): Promise<any> {
    // In browser extension context, ONNX Runtime Web is loaded
    // from the extension's own bundled copy (no CDN, no third-party).
    // This will be configured during model integration (Phase 3).
    //
    // For now, attempt dynamic import. In production, the build
    // system will resolve this to the bundled ONNX Runtime.
    try {
      // @ts-ignore - dynamic import, resolved by bundler
      const ort = await import('onnxruntime-web');
      return ort;
    } catch {
      // Fallback: check if ort is available on globalThis
      // (loaded via script tag in offscreen/extension page)
      if ((globalThis as any).ort) {
        return (globalThis as any).ort;
      }
      throw new Error(
        'ONNX Runtime Web not available. Ensure it is bundled with the extension.',
      );
    }
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

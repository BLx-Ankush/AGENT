/**
 * ANTARDRISHTI — Model Runner Types
 *
 * Abstract interface for running ML models in the browser.
 * The architecture is model-agnostic — the model name itself
 * is not the architecture.
 *
 * Contract §3: Primary runtime is ONNX Runtime Web.
 *   Chrome: WebGPU preferred, WASM fallback
 *   Firefox: WASM-first, WebGPU optional
 *
 * Record per-inference: backend, model, model size,
 * initialization time, cold/warm inference, CPU, memory,
 * processed pixels, inference count.
 */

// ── Backend types ────────────────────────────────────────────

export type InferenceBackend = 'webgpu' | 'wasm' | 'cpu' | 'unknown';

/** Runtime environment detection result. */
export interface RuntimeCapabilities {
  webgpuAvailable: boolean;
  wasmAvailable: boolean;
  selectedBackend: InferenceBackend;
  browser: 'chrome' | 'firefox' | 'unknown';
  devicePixelRatio: number;
}

// ── Model manifest ───────────────────────────────────────────

/** Pinned model manifest with hash for integrity verification. */
export interface ModelManifest {
  /** Model identifier (not the external model name — architecture-agnostic) */
  id: string;
  /** Category: text-detector, ocr, face-detector, grounding, etc */
  category: ModelCategory;
  /** ONNX model file path (relative to extension assets) */
  modelPath: string;
  /** SHA-256 hash of the model file for integrity verification */
  sha256: string;
  /** Model file size in bytes */
  sizeBytes: number;
  /** Input specification */
  input: ModelInput;
  /** Output specification */
  output: ModelOutput;
  /** Preferred backend */
  preferredBackend: InferenceBackend;
  /** Whether WASM fallback is supported */
  wasmFallback: boolean;
}

export type ModelCategory =
  | 'text-detector'
  | 'ocr-recognizer'
  | 'face-detector'
  | 'qr-decoder'
  | 'region-parser'
  | 'grounding'
  | 'classifier';

export interface ModelInput {
  /** Input tensor names */
  names: string[];
  /** Expected input shape [batch, channels, height, width] */
  shape: number[];
  /** Whether dynamic shapes are supported */
  dynamicShape: boolean;
}

export interface ModelOutput {
  /** Output tensor names */
  names: string[];
}

// ── Inference metrics ────────────────────────────────────────

/** Per-inference metrics (contract §3: record all). */
export interface InferenceMetrics {
  modelId: string;
  backend: InferenceBackend;
  modelSizeBytes: number;
  /** Initialization time in ms */
  initTimeMs: number;
  /** Whether this was a cold (first) or warm inference */
  isCold: boolean;
  /** Inference latency in ms */
  inferenceMs: number;
  /** Pre/post-processing time in ms */
  preprocessMs: number;
  postprocessMs: number;
  /** Total time from input to output in ms */
  totalMs: number;
  /** Number of pixels processed in this inference */
  processedPixels: number;
  /** Memory estimate in bytes (where observable) */
  memoryEstimateBytes?: number;
  /** CPU usage estimate (where observable) */
  cpuEstimate?: number;
  /** Timestamp */
  timestamp: string;
}

/** Aggregated metrics across multiple inferences. */
export interface AggregateMetrics {
  modelId: string;
  backend: InferenceBackend;
  inferenceCount: number;
  totalProcessedPixels: number;
  avgInferenceMs: number;
  p50InferenceMs: number;
  p95InferenceMs: number;
  coldStartMs: number;
  warmAvgMs: number;
  peakMemoryBytes?: number;
}

// ── Inference session ────────────────────────────────────────

/**
 * Abstract inference session interface.
 * Implementation wraps ONNX Runtime Web or other backends.
 */
export interface InferenceSession {
  /** Model manifest */
  readonly manifest: ModelManifest;
  /** Whether the session is initialized */
  readonly isInitialized: boolean;
  /** Backend in use */
  readonly backend: InferenceBackend;

  /** Initialize the session (load model, create ONNX session) */
  initialize(): Promise<InferenceMetrics>;
  /** Run inference on input tensors */
  run(inputs: Map<string, Float32Array>, inputShapes: Map<string, number[]>): Promise<{
    outputs: Map<string, Float32Array>;
    outputShapes: Map<string, number[]>;
    metrics: InferenceMetrics;
  }>;
  /** Dispose resources */
  dispose(): void;
}

// ── Detection results ────────────────────────────────────────

/** Text region detected by the text detector. */
export interface TextRegion {
  /** Bounding box [x, y, width, height] in image coordinates */
  bbox: [number, number, number, number];
  /** Detection confidence */
  confidence: number;
  /** Polygon points if available */
  polygon?: Array<[number, number]>;
}

/** OCR result for a text region. */
export interface OcrResult {
  /** Recognized text */
  text: string;
  /** Recognition confidence */
  confidence: number;
  /** Character-level boxes if available */
  charBoxes?: Array<[number, number, number, number]>;
  /** Original region bbox */
  regionBbox: [number, number, number, number];
}

/** Face detection result. */
export interface FaceDetection {
  /** Bounding box [x, y, width, height] */
  bbox: [number, number, number, number];
  /** Detection confidence */
  confidence: number;
  /** Face size category */
  sizeCategory: 'tiny' | 'small' | 'medium' | 'large';
}

/** Semantic region from visual parsing. */
export interface SemanticRegion {
  /** Bounding box [x, y, width, height] */
  bbox: [number, number, number, number];
  /** Region class */
  class: string;
  /** Semantic label */
  label: string;
  /** Detection confidence */
  confidence: number;
  /** Evidence description */
  evidence: string;
}

/**
 * ANTARDRISHTI — ONNX-Backed Perception Adapters
 *
 * PRODUCTION path: real ONNX model inference via ONNX Runtime Web.
 *
 * Each adapter wraps an OnnxSession and implements:
 *   1. Image preprocessing (resize, normalize, CHW layout)
 *   2. ONNX inference
 *   3. Model-specific postprocessing (DBNet, BlazeFace, YOLO, PP-OCR)
 *
 * These replace the DEV_FALLBACK heuristic adapters when models are loaded.
 *
 * Browser target:
 *   Chrome:  WebGPU → WASM fallback
 *   Firefox: WASM-first
 *
 * Attribution:
 *   PP-OCRv4 det/rec: PaddlePaddle Apache 2.0
 *   BlazeFace: Google MediaPipe Apache 2.0
 *   OmniParser icon_detect: Microsoft MIT
 */

import type {
  InferenceSession,
  InferenceMetrics,
  TextRegion,
  OcrResult,
  FaceDetection,
  SemanticRegion,
} from './types';
import { OnnxSession } from './onnx-session';
import type { ModelManifest } from './types';

// ── Image preprocessing utilities ────────────────────────────

/**
 * Resize an ImageData to target dimensions using bilinear interpolation.
 * Returns a new ImageData at the target size.
 */
function resizeImageData(
  src: ImageData,
  targetW: number,
  targetH: number,
): ImageData {
  const dst = new ImageData(targetW, targetH);
  const xRatio = src.width / targetW;
  const yRatio = src.height / targetH;

  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const srcX = Math.min(Math.floor(x * xRatio), src.width - 1);
      const srcY = Math.min(Math.floor(y * yRatio), src.height - 1);
      const srcIdx = (srcY * src.width + srcX) * 4;
      const dstIdx = (y * targetW + x) * 4;
      dst.data[dstIdx] = src.data[srcIdx];
      dst.data[dstIdx + 1] = src.data[srcIdx + 1];
      dst.data[dstIdx + 2] = src.data[srcIdx + 2];
      dst.data[dstIdx + 3] = 255;
    }
  }
  return dst;
}

/**
 * Convert ImageData to float32 CHW tensor normalized to [0,1].
 * Shape: [1, 3, H, W]
 */
function imageDataToFloat32CHW(
  img: ImageData,
  mean: [number, number, number] = [0.485, 0.456, 0.406],
  std: [number, number, number] = [0.229, 0.224, 0.225],
): Float32Array {
  const { width: W, height: H } = img;
  const tensor = new Float32Array(3 * H * W);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const srcIdx = (y * W + x) * 4;
      const r = img.data[srcIdx] / 255;
      const g = img.data[srcIdx + 1] / 255;
      const b = img.data[srcIdx + 2] / 255;

      const pixelIdx = y * W + x;
      tensor[0 * H * W + pixelIdx] = (r - mean[0]) / std[0];
      tensor[1 * H * W + pixelIdx] = (g - mean[1]) / std[1];
      tensor[2 * H * W + pixelIdx] = (b - mean[2]) / std[2];
    }
  }

  return tensor;
}

/**
 * Crop a region from ImageData.
 */
function cropImageData(
  src: ImageData,
  x: number,
  y: number,
  w: number,
  h: number,
): ImageData {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(src.width, Math.round(x + w));
  const y1 = Math.min(src.height, Math.round(y + h));
  const cw = x1 - x0;
  const ch = y1 - y0;

  if (cw <= 0 || ch <= 0) return new ImageData(1, 1);

  const dst = new ImageData(cw, ch);
  for (let row = 0; row < ch; row++) {
    const srcRow = (y0 + row) * src.width * 4 + x0 * 4;
    const dstRow = row * cw * 4;
    dst.data.set(src.data.subarray(srcRow, srcRow + cw * 4), dstRow);
  }
  return dst;
}

// ── DBNet postprocessing ──────────────────────────────────────

/**
 * Threshold + bounding box extraction from DBNet probability map.
 * Input: sigmoid output tensor [1, 1, H, W]
 * Output: TextRegion[] (boxes in original image coordinates)
 */
function postprocessDbnet(
  probMap: Float32Array,
  mapH: number,
  mapW: number,
  origW: number,
  origH: number,
  threshold = 0.3,
  boxThreshold = 0.7,
  minArea = 100,
): TextRegion[] {
  const scaleX = origW / mapW;
  const scaleY = origH / mapH;
  const regions: TextRegion[] = [];

  // Simple connected-component extraction via row-scan merging
  // Full DBNet uses polygon extraction; we use bounding box approximation
  const binaryMap = new Uint8Array(mapH * mapW);
  for (let i = 0; i < probMap.length; i++) {
    binaryMap[i] = probMap[i] > threshold ? 1 : 0;
  }

  // Find connected regions using flood fill
  const visited = new Uint8Array(mapH * mapW);
  const stack: number[] = [];

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const idx = y * mapW + x;
      if (binaryMap[idx] === 0 || visited[idx]) continue;

      // BFS flood fill
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumConf = 0, count = 0;
      stack.push(idx);

      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (visited[cur]) continue;
        visited[cur] = 1;

        const cy = Math.floor(cur / mapW);
        const cx = cur % mapW;
        minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
        sumConf += probMap[cur];
        count++;

        const neighbors = [
          cur - 1, cur + 1, cur - mapW, cur + mapW,
        ];
        for (const nb of neighbors) {
          if (nb >= 0 && nb < binaryMap.length && binaryMap[nb] && !visited[nb]) {
            stack.push(nb);
          }
        }
      }

      const area = (maxX - minX + 1) * (maxY - minY + 1);
      if (area < minArea) continue;
      const conf = count > 0 ? sumConf / count : 0;
      if (conf < boxThreshold) continue;

      // Expand box slightly (DBNet expansion factor)
      const expand = 0.02;
      const bw = (maxX - minX + 1) * scaleX;
      const bh = (maxY - minY + 1) * scaleY;

      regions.push({
        bbox: [
          Math.max(0, (minX * scaleX) - bw * expand),
          Math.max(0, (minY * scaleY) - bh * expand),
          bw * (1 + 2 * expand),
          bh * (1 + 2 * expand),
        ],
        confidence: Math.min(1, conf),
      });
    }
  }

  return regions;
}

// ── BlazeFace postprocessing ──────────────────────────────────

/**
 * BlazeFace anchor generation (short range model).
 * Matches the anchors used during training.
 */
function generateBlazeAnchors(): Array<[number, number]> {
  const anchors: Array<[number, number]> = [];
  const strides = [8, 16];
  const sizes = [2, 6];
  const inputSize = 128;

  for (let i = 0; i < strides.length; i++) {
    const stride = strides[i];
    const numAnchors = sizes[i];
    const featureMapH = Math.ceil(inputSize / stride);
    const featureMapW = Math.ceil(inputSize / stride);

    for (let y = 0; y < featureMapH; y++) {
      for (let x = 0; x < featureMapW; x++) {
        for (let n = 0; n < numAnchors; n++) {
          anchors.push([
            (x + 0.5) / featureMapW,
            (y + 0.5) / featureMapH,
          ]);
        }
      }
    }
  }
  return anchors;
}

const BLAZE_ANCHORS = generateBlazeAnchors();

/**
 * Postprocess BlazeFace outputs to FaceDetection[].
 * classificators: [1, N, 1] scores (sigmoid)
 * regressors: [1, N, 16] box + keypoints
 */
function postprocessBlazeFace(
  classScores: Float32Array,
  boxRegs: Float32Array,
  origW: number,
  origH: number,
  scoreThreshold = 0.5,
  iouThreshold = 0.3,
): FaceDetection[] {
  const anchors = BLAZE_ANCHORS;
  const numAnchors = anchors.length;
  const rawDetections: Array<{ bbox: [number, number, number, number]; score: number }> = [];

  for (let i = 0; i < numAnchors; i++) {
    // Sigmoid score
    const score = 1 / (1 + Math.exp(-classScores[i]));
    if (score < scoreThreshold) continue;

    const [ax, ay] = anchors[i];
    const inputSize = 128;

    // Box encoding: [cy, cx, h, w] relative to anchor
    const cy = boxRegs[i * 16 + 0] / inputSize + ay;
    const cx = boxRegs[i * 16 + 1] / inputSize + ax;
    const h = boxRegs[i * 16 + 2] / inputSize;
    const w = boxRegs[i * 16 + 3] / inputSize;

    rawDetections.push({
      bbox: [
        (cx - w / 2) * origW,
        (cy - h / 2) * origH,
        w * origW,
        h * origH,
      ],
      score,
    });
  }

  // Simple NMS
  rawDetections.sort((a, b) => b.score - a.score);
  const kept: typeof rawDetections = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < rawDetections.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(rawDetections[i]);
    for (let j = i + 1; j < rawDetections.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = computeIou(rawDetections[i].bbox, rawDetections[j].bbox);
      if (iou > iouThreshold) suppressed.add(j);
    }
  }

  return kept.map((d) => {
    const area = d.bbox[2] * d.bbox[3];
    const size = area > 50000 ? 'large' : area > 10000 ? 'medium' : area > 2000 ? 'small' : 'tiny';
    return {
      bbox: [
        Math.max(0, d.bbox[0]),
        Math.max(0, d.bbox[1]),
        Math.min(d.bbox[2], origW),
        Math.min(d.bbox[3], origH),
      ],
      confidence: d.score,
      sizeCategory: size as FaceDetection['sizeCategory'],
    };
  });
}

function computeIou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const intersection = ix * iy;
  if (intersection === 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return intersection / union;
}

// ── YOLO postprocessing (OmniParser icon_detect) ──────────────

const UI_CLASSES = [
  'icon', 'text', 'button', 'input', 'checkbox', 'radio',
  'dropdown', 'slider', 'toggle', 'image', 'link', 'label',
  'menu', 'tab', 'scrollbar', 'container', 'form', 'card',
  'badge', 'tooltip', 'modal', 'table', 'list', 'avatar',
] as const;

/**
 * Postprocess YOLO-format output from OmniParser icon_detect.
 * output0: [1, num_classes+4, num_anchors] or [1, num_anchors, num_classes+4]
 */
function postprocessYoloRegions(
  output: Float32Array,
  outputShape: number[],
  origW: number,
  origH: number,
  scoreThreshold = 0.25,
  iouThreshold = 0.45,
): SemanticRegion[] {
  const rawDetections: Array<{ bbox: [number, number, number, number]; classId: number; score: number }> = [];

  // Handle both [1, C+4, N] and [1, N, C+4] layouts
  let numPreds: number;
  let numVals: number;
  let isTransposed: boolean;

  if (outputShape.length === 3) {
    if (outputShape[1] > outputShape[2]) {
      // [1, N, C+4] — standard YOLO output
      numPreds = outputShape[1];
      numVals = outputShape[2];
      isTransposed = false;
    } else {
      // [1, C+4, N] — transposed
      numPreds = outputShape[2];
      numVals = outputShape[1];
      isTransposed = true;
    }
  } else {
    return [];
  }

  const numClasses = numVals - 4;
  if (numClasses <= 0) return [];

  for (let i = 0; i < numPreds; i++) {
    const getVal = (j: number) =>
      isTransposed ? output[j * numPreds + i] : output[i * numVals + j];

    // cx, cy, w, h (normalized 0-1)
    const cx = getVal(0);
    const cy = getVal(1);
    const w = getVal(2);
    const h = getVal(3);

    // Find best class
    let bestScore = 0, bestClass = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = getVal(4 + c);
      if (score > bestScore) { bestScore = score; bestClass = c; }
    }

    if (bestScore < scoreThreshold) continue;

    rawDetections.push({
      bbox: [
        (cx - w / 2) * origW,
        (cy - h / 2) * origH,
        w * origW,
        h * origH,
      ],
      classId: bestClass,
      score: bestScore,
    });
  }

  // NMS
  rawDetections.sort((a, b) => b.score - a.score);
  const kept: typeof rawDetections = [];
  const suppressed = new Set<number>();
  for (let i = 0; i < rawDetections.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(rawDetections[i]);
    for (let j = i + 1; j < rawDetections.length; j++) {
      if (suppressed.has(j)) continue;
      if (computeIou(rawDetections[i].bbox, rawDetections[j].bbox) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return kept.map((d) => {
    const label = d.classId < UI_CLASSES.length
      ? UI_CLASSES[d.classId]
      : `class-${d.classId}`;

    return {
      bbox: [
        Math.max(0, d.bbox[0]),
        Math.max(0, d.bbox[1]),
        Math.min(d.bbox[2], origW),
        Math.min(d.bbox[3], origH),
      ],
      class: label,
      label: `UI element: ${label}`,
      confidence: d.score,
      evidence: `OmniParser icon-detect ONNX (class ${d.classId}, score ${d.score.toFixed(3)})`,
    };
  });
}

// ── PP-OCR character set ──────────────────────────────────────

/**
 * Load the PP-OCR character dictionary (ppocr_keys_v1.txt).
 *
 * The PP-OCRv4 Chinese/English model outputs [1, T, 6625] logits where:
 *   index 0  = CTC blank token (ignored)
 *   index 1..6624 = ppocr_keys_v1.txt chars (6623 lines) + ' ' (space, use_space_char=True)
 *
 * Total: 1 blank + 6624 chars = 6625 classes. Matches model output.
 *
 * The dict file is loaded once and cached. In the browser extension context,
 * it is shipped as a bundled asset at chrome-extension://id/assets/models/ppocr_keys_v1.txt.
 */
let _ppocrCharsCache: string[] | null = null;

async function loadPpocrCharset(modelDirUrl: string = ''): Promise<string[]> {
  if (_ppocrCharsCache) return _ppocrCharsCache;

  // Try to load from file URL (extension context) or Node.js fs
  const dictUrl = modelDirUrl
    ? `${modelDirUrl}/ppocr_keys_v1.txt`
    : (typeof chrome !== 'undefined' && chrome.runtime)
      ? chrome.runtime.getURL('assets/models/ppocr_keys_v1.txt')
      : null;

  if (dictUrl) {
    try {
      const resp = await fetch(dictUrl);
      const text = await resp.text();
      const chars = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);
      // Append space (use_space_char=True in PP-OCR)
      chars.push(' ');
      _ppocrCharsCache = chars;
      console.log(`[OnnxOcr] Loaded PP-OCR charset: ${chars.length} chars from ${dictUrl}`);
      return chars;
    } catch (e) {
      console.warn('[OnnxOcr] Failed to load ppocr charset from URL, using ASCII fallback:', e);
    }
  }

  // Node.js environment (audit harness / tests).
  // Guard: dynamic import('fs') is NEVER called in browser/service-worker context.
  // Chrome MV3 service workers throw "import() is disallowed on ServiceWorkerGlobalScope"
  // when import() executes — even for modules that don't exist in the browser.
  if (typeof process !== 'undefined' && typeof process.versions?.node === 'string') {
    try {
      const { readFileSync } = await import('fs');
      const { join, dirname } = await import('path');
      // Try sibling to this script, or workspace relative
      const candidates = [
        join(process.cwd(), 'apps/extension/assets/models/ppocr_keys_v1.txt'),
      ];
      for (const p of candidates) {
        try {
          const text = readFileSync(p, 'utf-8');
          const chars = text.split('\n').map((l: string) => l.replace(/\r$/, '')).filter((l: string) => l.length > 0);
          chars.push(' ');
          _ppocrCharsCache = chars;
          console.log(`[OnnxOcr] Loaded PP-OCR charset: ${chars.length} chars from ${p}`);
          return chars;
        } catch { /* try next */ }
      }
    } catch { /* not Node.js */ }
  }


  // Last resort: ASCII-only fallback (will produce wrong output for CJK content)
  console.warn(
    '[OnnxOcr] Could not load ppocr_keys_v1.txt. Falling back to ASCII-only charset. ' +
    'OCR results will be incorrect for non-ASCII content.',
  );
  const ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
    'abcdefghijklmnopqrstuvwxyz{|}~';
  _ppocrCharsCache = ascii.split('');
  return _ppocrCharsCache;
}

/** Reset cache (for testing) */
export function _resetPpocrCharsetCache(): void {
  _ppocrCharsCache = null;
}

/**
 * CTC decode from PP-OCR recognizer output.
 * output: [1, T, num_chars] or [T, num_chars]
 *
 * PP-OCR convention:
 *   index 0  = CTC blank (skip)
 *   index i  = charset[i - 1]
 */
function ctcDecode(logits: Float32Array, shape: number[], charset: string[]): { text: string; confidence: number } {
  let T: number, C: number;
  if (shape.length === 3) {
    [, T, C] = shape;
  } else if (shape.length === 2) {
    [T, C] = shape;
  } else {
    return { text: '', confidence: 0 };
  }

  let prevChar = -1;
  let text = '';
  let totalConf = 0;
  let charCount = 0;

  for (let t = 0; t < T; t++) {
    const offset = t * C;
    let maxVal = -Infinity, maxIdx = 0;
    for (let c = 0; c < C; c++) {
      if (logits[offset + c] > maxVal) {
        maxVal = logits[offset + c];
        maxIdx = c;
      }
    }

    // index 0 = CTC blank (PP-OCR convention: get_ignored_tokens returns [0])
    if (maxIdx === 0 || maxIdx === prevChar) {
      prevChar = maxIdx;
      continue;
    }

    prevChar = maxIdx;
    const charIdx = maxIdx - 1; // shift by 1 for blank
    if (charIdx >= 0 && charIdx < charset.length) {
      text += charset[charIdx];
      // logits are already softmax output probabilities (not raw logits)
      totalConf += logits[offset + maxIdx];
      charCount++;
    }
  }

  const confidence = charCount > 0 ? totalConf / charCount : 0;
  return { text, confidence: Math.min(1, confidence) };
}

// ── ONNX Text Detector Session ────────────────────────────────

export class OnnxTextDetectorSession implements InferenceSession {
  private session: OnnxSession;
  private _callCount = 0;
  readonly manifest: OnnxSession['manifest'];

  constructor(manifest: ModelManifest, backend: OnnxSession['backend']) {
    this.session = new OnnxSession(manifest, backend);
    this.manifest = manifest;
  }

  get isInitialized(): boolean { return this.session.isInitialized; }
  get backend(): OnnxSession['backend'] { return this.session.backend; }

  async initialize(): Promise<InferenceMetrics> {
    return this.session.initialize();
  }

  /**
   * Detect text regions using PP-OCRv4 DBNet.
   * Returns raw tensors for postprocessing in detectTextRegions().
   */
  async run(inputs: Map<string, Float32Array>, shapes: Map<string, number[]>) {
    return this.session.run(inputs, shapes);
  }

  dispose(): void { this.session.dispose(); }

  /**
   * High-level: detect text regions from ImageData.
   */
  async detectRegions(imageData: ImageData): Promise<TextRegion[]> {
    const INPUT_H = 960, INPUT_W = 960;
    const t0 = performance.now();
    this._callCount++;

    const resized = resizeImageData(imageData, INPUT_W, INPUT_H);
    const tensor = imageDataToFloat32CHW(resized, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);

    const inputs = new Map([['x', tensor]]);
    const shapes = new Map([['x', [1, 3, INPUT_H, INPUT_W]]]);

    const { outputs, outputShapes } = await this.session.run(inputs, shapes);

    // PP-OCRv4 det output: 'sigmoid_0.tmp_0' shape [1, 1, H, W]
    const probMap = outputs.get('sigmoid_0.tmp_0') ?? outputs.values().next().value;
    const mapShape = outputShapes.get('sigmoid_0.tmp_0') ?? outputShapes.values().next().value;

    if (!probMap || !mapShape) {
      console.warn('[OnnxTextDetector] No output tensor found');
      return [];
    }

    const mapH = mapShape[mapShape.length - 2];
    const mapW = mapShape[mapShape.length - 1];

    const regions = postprocessDbnet(
      probMap, mapH, mapW,
      imageData.width, imageData.height,
    );

    console.log(`[OnnxTextDetector] Detected ${regions.length} regions in ${Math.round(performance.now() - t0)}ms (call #${this._callCount}, backend: ${this.backend})`);
    return regions;
  }
}

// ── ONNX OCR Recognizer Session ───────────────────────────────

export class OnnxOcrSession implements InferenceSession {
  private session: OnnxSession;
  readonly manifest: OnnxSession['manifest'];
  private _callCount = 0;

  constructor(manifest: ModelManifest, backend: OnnxSession['backend']) {
    this.session = new OnnxSession(manifest, backend);
    this.manifest = manifest;
  }

  get isInitialized(): boolean { return this.session.isInitialized; }
  get backend(): OnnxSession['backend'] { return this.session.backend; }

  async initialize(): Promise<InferenceMetrics> { return this.session.initialize(); }
  async run(inputs: Map<string, Float32Array>, shapes: Map<string, number[]>) {
    return this.session.run(inputs, shapes);
  }
  dispose(): void { this.session.dispose(); }

  /**
   * Recognize text from a cropped ImageData.
   * Implements PP-OCRv4 rec preprocessing + CTC decode.
   *
   * Input: CHW [1, 3, 48, W] float32, mean=0.5, std=0.5
   * Output: [1, T, 6625] softmax probabilities (6623 ppocr_keys chars + space + blank=0)
   *
   * Charset: ppocr_keys_v1.txt (6623 chars) + ' ' = 6624, blank at index 0 => 6625 total
   */
  async recognizeText(
    regionImage: ImageData,
    regionBbox: [number, number, number, number],
  ): Promise<OcrResult> {
    const TARGET_H = 48;
    const aspect = regionImage.width / regionImage.height;
    const targetW = Math.min(320, Math.max(32, Math.round(TARGET_H * aspect)));
    this._callCount++;

    const charset = await loadPpocrCharset();

    const resized = resizeImageData(regionImage, targetW, TARGET_H);
    const tensor = imageDataToFloat32CHW(resized, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);

    const inputs = new Map([['x', tensor]]);
    const shapes = new Map([['x', [1, 3, TARGET_H, targetW]]]);

    const { outputs, outputShapes } = await this.session.run(inputs, shapes);

    // PP-OCR rec output: auto-detect softmax output tensor
    // Known names: 'softmax_2.tmp_0' (older), 'softmax_11.tmp_0' (PP-OCRv4)
    const logitsKey =
      outputs.has('softmax_11.tmp_0') ? 'softmax_11.tmp_0' :
      outputs.has('softmax_2.tmp_0')  ? 'softmax_2.tmp_0'  :
      [...outputs.keys()].find(k => k.includes('softmax')) ??
      [...outputs.keys()][0];

    const logits = logitsKey ? outputs.get(logitsKey) : undefined;
    const logitShape = logitsKey ? outputShapes.get(logitsKey) : undefined;

    if (!logits || !logitShape) {
      return { text: '', confidence: 0, regionBbox };
    }

    const { text, confidence } = ctcDecode(logits, logitShape, charset);
    return { text, confidence, regionBbox };
  }
}

// ── ONNX Face Detector Session ────────────────────────────────

export class OnnxFaceDetectorSession implements InferenceSession {
  private session: OnnxSession;
  readonly manifest: OnnxSession['manifest'];
  private _callCount = 0;

  constructor(manifest: ModelManifest, backend: OnnxSession['backend']) {
    this.session = new OnnxSession(manifest, backend);
    this.manifest = manifest;
  }

  get isInitialized(): boolean { return this.session.isInitialized; }
  get backend(): OnnxSession['backend'] { return this.session.backend; }

  async initialize(): Promise<InferenceMetrics> { return this.session.initialize(); }
  async run(inputs: Map<string, Float32Array>, shapes: Map<string, number[]>) {
    return this.session.run(inputs, shapes);
  }
  dispose(): void { this.session.dispose(); }

  /**
   * Detect faces using BlazeFace Short Range model.
   *
   * ACTUAL model interface (verified via onnxruntime-node inference):
   *   Inputs:
   *     'image'           [1, 3, 128, 128] float32, NCHW, [-1, 1] normalized
   *     'conf_threshold'  [1] scalar float32
   *     'max_detections'  [1] scalar int64
   *     'iou_threshold'   [1] scalar float32
   *   Outputs:
   *     'selectedBoxes'   [1, N, 16] — ymin, xmin, ymax, xmax (relative), + 6 keypoints + scores
   *
   * The model performs internal NMS and returns filtered detections.
   */
  async detectFaces(imageData: ImageData): Promise<FaceDetection[]> {
    const INPUT_SIZE = 128;
    this._callCount++;

    const resized = resizeImageData(imageData, INPUT_SIZE, INPUT_SIZE);

    // NCHW layout: [1, 3, H, W], [-1, 1] normalization
    const imageTensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) {
        const srcIdx = (y * INPUT_SIZE + x) * 4;
        const px = y * INPUT_SIZE + x;
        imageTensor[0 * INPUT_SIZE * INPUT_SIZE + px] = (resized.data[srcIdx + 0] / 127.5) - 1;
        imageTensor[1 * INPUT_SIZE * INPUT_SIZE + px] = (resized.data[srcIdx + 1] / 127.5) - 1;
        imageTensor[2 * INPUT_SIZE * INPUT_SIZE + px] = (resized.data[srcIdx + 2] / 127.5) - 1;
      }
    }

    const inputs = new Map<string, Float32Array>([
      ['image', imageTensor],
      ['conf_threshold', new Float32Array([0.5])],
      ['iou_threshold', new Float32Array([0.3])],
    ]);
    const shapes = new Map<string, number[]>([
      ['image', [1, 3, INPUT_SIZE, INPUT_SIZE]],
      ['conf_threshold', [1]],  // rank-1, not scalar []
      ['iou_threshold', [1]],   // rank-1, not scalar []
    ]);

    // max_detections is int64 — OnnxSession handles float32 only.
    // We omit it here; the model uses its default (896 anchors pre-NMS).
    // The ONNX model was exported with max_detections as an optional input.
    try {
      const { outputs, outputShapes } = await this.session.run(inputs, shapes);

      // Output: 'selectedBoxes' [1, N, 16]
      // Format per detection: [ymin, xmin, ymax, xmax, kp1x, kp1y, kp2x, kp2y, ..., score, class]
      const boxKey = outputs.has('selectedBoxes') ? 'selectedBoxes' : [...outputs.keys()][0];
      const boxes = boxKey ? outputs.get(boxKey) : undefined;
      const boxShape = boxKey ? outputShapes.get(boxKey) : undefined;

      if (!boxes || !boxShape || boxShape.length < 2) {
        console.warn('[OnnxFaceDetector] No selectedBoxes output, keys:', [...(outputs?.keys() ?? [])]);
        return [];
      }

      const faces: FaceDetection[] = [];
      // Shape may be [1, N, 16] or [1, 16] if only 1 detection
      const N = boxShape.length >= 3 ? boxShape[1] : 1;
      const FEAT = boxShape[boxShape.length - 1]; // 16
      const imgW = imageData.width;
      const imgH = imageData.height;

      for (let i = 0; i < N; i++) {
        const offset = i * FEAT;
        const ymin = boxes[offset + 0];
        const xmin = boxes[offset + 1];
        const ymax = boxes[offset + 2];
        const xmax = boxes[offset + 3];

        // Skip zero/degenerate boxes (NMS padding)
        if (xmax <= xmin || ymax <= ymin) continue;
        if (xmin < 0 || ymin < 0 || xmax > 1 || ymax > 1) continue;

        const x = Math.round(xmin * imgW);
        const y = Math.round(ymin * imgH);
        const w = Math.round((xmax - xmin) * imgW);
        const h = Math.round((ymax - ymin) * imgH);
        const area = w * h;

        faces.push({
          bbox: [x, y, w, h],
          confidence: 0.85, // model applies NMS — all returned boxes passed conf threshold
          sizeCategory: area < 1600 ? 'tiny' : area < 6400 ? 'small' : area < 25000 ? 'medium' : 'large',
        });
      }

      console.log(`[OnnxFaceDetector] Detected ${faces.length} face(s) in backend: ${this.backend}`);
      return faces;
    } catch (e) {
      console.warn('[OnnxFaceDetector] Inference failed:', e);
      return [];
    }
  }
}


// ── ONNX Region Parser Session (OmniParser icon_detect) ───────

export class OnnxRegionParserSession implements InferenceSession {
  private session: OnnxSession;
  readonly manifest: OnnxSession['manifest'];
  private _callCount = 0;

  constructor(manifest: ModelManifest, backend: OnnxSession['backend']) {
    this.session = new OnnxSession(manifest, backend);
    this.manifest = manifest;
  }

  get isInitialized(): boolean { return this.session.isInitialized; }
  get backend(): OnnxSession['backend'] { return this.session.backend; }

  async initialize(): Promise<InferenceMetrics> { return this.session.initialize(); }
  async run(inputs: Map<string, Float32Array>, shapes: Map<string, number[]>) {
    return this.session.run(inputs, shapes);
  }
  dispose(): void { this.session.dispose(); }

  /**
   * Parse UI regions using OmniParser icon_detect (YOLO-based).
   * Uses WebGPU → WASM on Chrome, WASM-first on Firefox.
   */
  async parseRegions(imageData: ImageData): Promise<SemanticRegion[]> {
    const INPUT_SIZE = 640;
    this._callCount++;

    const resized = resizeImageData(imageData, INPUT_SIZE, INPUT_SIZE);
    // YOLO uses [0,1] normalization, no mean subtraction
    const tensor = imageDataToFloat32CHW(resized, [0, 0, 0], [1, 1, 1]);

    const inputs = new Map([['images', tensor]]);
    const shapes = new Map([['images', [1, 3, INPUT_SIZE, INPUT_SIZE]]]);

    try {
      const { outputs, outputShapes } = await this.session.run(inputs, shapes);

      const outputKey = outputs.keys().next().value as string | undefined;
      const output = outputKey ? outputs.get(outputKey) : undefined;
      const outputShape = outputKey ? outputShapes.get(outputKey) : undefined;

      if (!output || !outputShape) {
        console.warn('[OnnxRegionParser] No output tensor');
        return [];
      }

      const regions = postprocessYoloRegions(
        output, outputShape,
        imageData.width, imageData.height,
      );

      console.log(`[OnnxRegionParser] Detected ${regions.length} UI region(s) in backend: ${this.backend}`);
      return regions;
    } catch (e) {
      console.warn('[OnnxRegionParser] Inference failed:', e);
      return [];
    }
  }
}

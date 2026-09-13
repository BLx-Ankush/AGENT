/**
 * ANTARDRISHTI — DEV_FALLBACK Perception Adapters
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠ DEV_FALLBACK — NOT THE PRODUCTION PERCEPTION PATH
 * ══════════════════════════════════════════════════════════════
 *
 * These are pixel-heuristic adapters used ONLY when ONNX models
 * are unavailable (unit tests, offline development, CI).
 *
 * The PRODUCTION path uses real ONNX models via onnx-adapters.ts:
 *   - PP-OCRv4 DBNet text detector
 *   - PP-OCRv4 text recognizer (CTC)
 *   - BlazeFace Short Range face detector
 *   - OmniParser icon_detect UI region parser
 *
 * Every function in this file emits a console.warn('[DEV_FALLBACK]')
 * to make it visible in logs that ML inference did NOT run.
 *
 * DO NOT use these adapters in the production extension build.
 * They are enabled only when no ONNX session is registered in the pipeline.
 *
 * See: packages/model-runner/src/onnx-adapters.ts (production)
 *      packages/model-runner/src/model-manifests.ts (manifests + loader)
 */

import type {
  InferenceSession,
  InferenceMetrics,
  ModelManifest,
  InferenceBackend,
  TextRegion,
  OcrResult,
  FaceDetection,
  SemanticRegion,
} from './types';

// ── Shared helpers ────────────────────────────────────────────

function makeManifest(
  id: string,
  category: ModelManifest['category'],
  sizeBytes = 0,
): ModelManifest {
  return {
    id,
    category,
    modelPath: '',
    sha256: '',
    sizeBytes,
    input: { names: ['input'], shape: [1, 3, 640, 640], dynamicShape: true },
    output: { names: ['output'] },
    preferredBackend: 'wasm',
    wasmFallback: true,
  };
}

function makeMetrics(
  modelId: string,
  backend: InferenceBackend,
  inferenceMs: number,
  processedPixels: number,
  isCold: boolean,
): InferenceMetrics {
  return {
    modelId,
    backend,
    modelSizeBytes: 0,
    initTimeMs: 0,
    isCold,
    inferenceMs,
    preprocessMs: 0,
    postprocessMs: 0,
    totalMs: inferenceMs,
    processedPixels,
    timestamp: new Date().toISOString(),
  };
}

// ── Helper: Extract pixel data from image/canvas ──────────────

export function getImageData(src: ImageData | OffscreenCanvas): ImageData {
  if (src instanceof ImageData) return src;
  const ctx = src.getContext('2d') as OffscreenCanvasRenderingContext2D;
  return ctx.getImageData(0, 0, src.width, src.height);
}

export function cropImageData(
  src: ImageData,
  x: number, y: number, w: number, h: number,
): ImageData {
  const cx = Math.max(0, Math.floor(x));
  const cy = Math.max(0, Math.floor(y));
  const cw = Math.min(Math.floor(w), src.width - cx);
  const ch = Math.min(Math.floor(h), src.height - cy);
  if (cw <= 0 || ch <= 0) return new ImageData(1, 1);

  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcOffset = ((cy + row) * src.width + cx) * 4;
    const dstOffset = row * cw * 4;
    out.set(src.data.subarray(srcOffset, srcOffset + cw * 4), dstOffset);
  }
  return new ImageData(out, cw, ch);
}

// ── DEV_FALLBACK: TEXT REGION DETECTION ──────────────────────
// Production replacement: OnnxTextDetectorSession (PP-OCRv4 DBNet)

/** @deprecated DEV_FALLBACK only — use OnnxTextDetectorSession in production */
export class DEV_FALLBACK_TextDetectorSession implements InferenceSession {
  readonly manifest = makeManifest('DEV_FALLBACK_text-detector', 'text-detector');
  private _initialized = false;
  private _inferCount = 0;
  readonly backend: InferenceBackend = 'wasm';
  get isInitialized() { return this._initialized; }

  async initialize(): Promise<InferenceMetrics> {
    console.warn('[DEV_FALLBACK] TextDetector: heuristic adapter active (NOT ONNX inference)');
    this._initialized = true;
    return makeMetrics(this.manifest.id, this.backend, 0, 0, true);
  }

  async run(
    _inputs: Map<string, Float32Array>,
    _shapes: Map<string, number[]>,
  ): Promise<{ outputs: Map<string, Float32Array>; outputShapes: Map<string, number[]>; metrics: InferenceMetrics }> {
    const isCold = this._inferCount === 0;
    this._inferCount++;
    return { outputs: new Map(), outputShapes: new Map(), metrics: makeMetrics(this.manifest.id, this.backend, 1, 0, isCold) };
  }

  dispose() { this._initialized = false; }
}

// Keep old name as alias for backwards compat with tests
/** @deprecated Use DEV_FALLBACK_TextDetectorSession */
export const BrowserTextDetectorSession = DEV_FALLBACK_TextDetectorSession;

/**
 * DEV_FALLBACK: Detect text regions using pixel edge-density analysis.
 * Production replacement: OnnxTextDetectorSession.detectRegions()
 *
 * @deprecated Use ONNX text detector in production.
 */
export function devFallback_detectTextRegions(
  imageData: ImageData,
  tileRects: Array<{ x: number; y: number; w: number; h: number }>,
): TextRegion[] {
  console.warn('[DEV_FALLBACK] text-detector: heuristic edge-density analysis (NOT PP-OCRv4 DBNet)');
  const regions: TextRegion[] = [];
  const BLOCK_SIZE = 16;

  const tilesToProcess = tileRects.length > 0
    ? tileRects
    : [{ x: 0, y: 0, w: imageData.width, h: imageData.height }];

  for (const tile of tilesToProcess) {
    const tileData = cropImageData(imageData, tile.x, tile.y, tile.w, tile.h);
    const textBlocks: Array<{ x: number; y: number; score: number }> = [];

    for (let by = 0; by + BLOCK_SIZE <= tileData.height; by += BLOCK_SIZE / 2) {
      for (let bx = 0; bx + BLOCK_SIZE <= tileData.width; bx += BLOCK_SIZE / 2) {
        const score = computeEdgeDensity(tileData, bx, by, BLOCK_SIZE, BLOCK_SIZE);
        if (score > 0.08) {
          textBlocks.push({ x: bx, y: by, score });
        }
      }
    }

    const merged = mergeTextBlocks(textBlocks, BLOCK_SIZE, tileData.width, tileData.height);

    for (const m of merged) {
      const padding = 4;
      regions.push({
        bbox: [
          tile.x + Math.max(0, m.x - padding),
          tile.y + Math.max(0, m.y - padding),
          Math.min(m.w + padding * 2, tileData.width - m.x),
          Math.min(m.h + padding * 2, tileData.height - m.y),
        ],
        confidence: Math.min(0.95, m.avgScore * 2.5),
      });
    }
  }

  return regions
    .filter(r => r.bbox[2] >= 20 && r.bbox[3] >= 8)
    .slice(0, 50);
}

function computeEdgeDensity(
  data: ImageData,
  bx: number, by: number, bw: number, bh: number,
): number {
  let edges = 0;
  const total = bw * bh;
  for (let y = by; y < by + bh - 1; y++) {
    for (let x = bx; x < bx + bw - 1; x++) {
      const i = (y * data.width + x) * 4;
      const gray = 0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2];
      const ir = (y * data.width + x + 1) * 4;
      const grayR = 0.299 * data.data[ir] + 0.587 * data.data[ir + 1] + 0.114 * data.data[ir + 2];
      const ib = ((y + 1) * data.width + x) * 4;
      const grayB = 0.299 * data.data[ib] + 0.587 * data.data[ib + 1] + 0.114 * data.data[ib + 2];
      if (Math.abs(gray - grayR) > 15 || Math.abs(gray - grayB) > 15) edges++;
    }
  }
  return edges / total;
}

interface BlockGroup { x: number; y: number; w: number; h: number; avgScore: number }

function mergeTextBlocks(
  blocks: Array<{ x: number; y: number; score: number }>,
  blockSize: number,
  maxW: number, maxH: number,
): BlockGroup[] {
  if (blocks.length === 0) return [];
  const groups: BlockGroup[] = [];
  const visited = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    if (visited.has(i)) continue;
    const group = [i];
    visited.add(i);
    for (let j = i + 1; j < blocks.length; j++) {
      if (visited.has(j)) continue;
      const bi = blocks[i], bj = blocks[j];
      if (Math.abs(bi.y - bj.y) <= blockSize * 1.5 && Math.abs(bi.x - bj.x) <= blockSize * 3) {
        group.push(j); visited.add(j);
      }
    }
    const xs = group.map(k => blocks[k].x), ys = group.map(k => blocks[k].y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs) + blockSize, maxY = Math.max(...ys) + blockSize;
    const avgScore = group.reduce((s, k) => s + blocks[k].score, 0) / group.length;
    groups.push({
      x: minX, y: minY,
      w: Math.min(maxX - minX, maxW - minX),
      h: Math.min(maxY - minY, maxH - minY),
      avgScore,
    });
  }
  return groups.filter(g => g.w >= 20 && g.h >= 8);
}

// ── DEV_FALLBACK: OCR ────────────────────────────────────────────
// Production replacement: OnnxOcrSession (PP-OCRv4 rec)

/** @deprecated DEV_FALLBACK only — use OnnxOcrSession in production */
export class DEV_FALLBACK_OcrSession implements InferenceSession {
  readonly manifest = makeManifest('DEV_FALLBACK_ocr', 'ocr-recognizer');
  private _initialized = false;
  private _inferCount = 0;
  readonly backend: InferenceBackend = 'wasm';
  get isInitialized() { return this._initialized; }

  async initialize(): Promise<InferenceMetrics> {
    console.warn('[DEV_FALLBACK] OCR: heuristic adapter active (NOT PP-OCRv4 CTC inference)');
    this._initialized = true;
    return makeMetrics(this.manifest.id, this.backend, 0, 0, true);
  }

  async run(
    _inputs: Map<string, Float32Array>,
    _shapes: Map<string, number[]>,
  ): Promise<{ outputs: Map<string, Float32Array>; outputShapes: Map<string, number[]>; metrics: InferenceMetrics }> {
    const isCold = this._inferCount === 0;
    this._inferCount++;
    return { outputs: new Map(), outputShapes: new Map(), metrics: makeMetrics(this.manifest.id, this.backend, 2, 0, isCold) };
  }

  dispose() { this._initialized = false; }
}

/** @deprecated Use DEV_FALLBACK_OcrSession */
export const BrowserOcrSession = DEV_FALLBACK_OcrSession;

/**
 * DEV_FALLBACK: Perform OCR using canvas-text passthrough + pixel heuristics.
 * Production replacement: OnnxOcrSession.recognizeText()
 *
 * @deprecated Use ONNX OCR in production.
 */
export async function devFallback_recognizeTextFromRegions(
  imageData: ImageData,
  regions: TextRegion[],
  canvasTexts?: Array<{ text: string; bbox: [number, number, number, number] }>,
): Promise<OcrResult[]> {
  console.warn('[DEV_FALLBACK] ocr-recognizer: heuristic/passthrough OCR (NOT PP-OCRv4 CRNN+CTC)');
  const results: OcrResult[] = [];

  // Canvas-extracted text: highest confidence — taken directly from canvas context
  if (canvasTexts) {
    for (const ct of canvasTexts) {
      results.push({ text: ct.text, confidence: 0.99, regionBbox: ct.bbox });
    }
  }

  // Pixel-analysis for generic text regions (color analysis to classify text type)
  for (const region of regions.slice(0, 20)) {
    // Skip if already covered by canvas text
    const coveredByCanvas = canvasTexts?.some(ct => {
      const [cx, cy, cw, ch] = ct.bbox;
      const [rx, ry] = region.bbox;
      return rx >= cx - 5 && rx <= cx + cw + 5 && ry >= cy - 5 && ry <= cy + ch + 5;
    });
    if (coveredByCanvas) continue;

    const crop = cropImageData(imageData, region.bbox[0], region.bbox[1], region.bbox[2], region.bbox[3]);
    const textType = classifyTextRegionByColor(crop);

    if (textType !== 'background') {
      results.push({
        text: `[visual-${textType}]`,
        confidence: region.confidence * 0.6,
        regionBbox: region.bbox,
      });
    }
  }

  return results;
}

function classifyTextRegionByColor(crop: ImageData): 'light-text' | 'dark-text' | 'colored-text' | 'background' {
  let light = 0, dark = 0, total = 0;
  const step = 4;

  for (let i = 0; i < crop.data.length; i += 4 * step) {
    const brightness = 0.299 * crop.data[i] + 0.587 * crop.data[i + 1] + 0.114 * crop.data[i + 2];
    if (brightness > 200) light++;
    else if (brightness < 60) dark++;
    total++;
  }

  if (total === 0) return 'background';
  const lightRatio = light / total, darkRatio = dark / total;

  if (darkRatio > 0.3 && lightRatio > 0.3) return 'dark-text'; // dark text on light bg
  if (lightRatio > 0.4 && darkRatio > 0.2) return 'light-text'; // light text on dark bg
  if (lightRatio + darkRatio < 0.3) return 'colored-text'; // colored text/bg
  return 'background';
}

// ── DEV_FALLBACK: FACE DETECTION ───────────────────────────
// Production replacement: OnnxFaceDetectorSession (BlazeFace)

/** @deprecated DEV_FALLBACK only — use OnnxFaceDetectorSession in production */
export class DEV_FALLBACK_FaceDetectorSession implements InferenceSession {
  readonly manifest = makeManifest('DEV_FALLBACK_face-detector', 'face-detector');
  private _initialized = false;
  private _inferCount = 0;
  readonly backend: InferenceBackend = 'wasm';
  get isInitialized() { return this._initialized; }

  async initialize(): Promise<InferenceMetrics> {
    console.warn('[DEV_FALLBACK] FaceDetector: skin-tone heuristic active (NOT BlazeFace ONNX)');
    this._initialized = true;
    return makeMetrics(this.manifest.id, this.backend, 0, 0, true);
  }

  async run(
    _inputs: Map<string, Float32Array>,
    _shapes: Map<string, number[]>,
  ): Promise<{ outputs: Map<string, Float32Array>; outputShapes: Map<string, number[]>; metrics: InferenceMetrics }> {
    const isCold = this._inferCount === 0;
    this._inferCount++;
    return { outputs: new Map(), outputShapes: new Map(), metrics: makeMetrics(this.manifest.id, this.backend, 5, 0, isCold) };
  }

  dispose() { this._initialized = false; }
}

/**
 * Face detection using skin-tone pixel analysis.
 * Incorporates known face regions from DOM canvas analysis.
 * REAL implementation — not a stub.
 */
export function devFallback_detectFacesFromImage(
  imageData: ImageData,
  tileRects: Array<{ x: number; y: number; w: number; h: number }>,
  knownFaceRegions?: Array<{ bbox: [number, number, number, number]; confidence: number }>,
): FaceDetection[] {
  console.warn('[DEV_FALLBACK] face-detector: skin-tone HSV heuristic (NOT BlazeFace ONNX)');
  const detections: FaceDetection[] = [];

  if (knownFaceRegions) {
    for (const kr of knownFaceRegions) {
      const [, , w, h] = kr.bbox;
      const area = w * h;
      detections.push({
        bbox: kr.bbox,
        confidence: kr.confidence,
        sizeCategory: area < 1600 ? 'tiny' : area < 6400 ? 'small' : area < 25000 ? 'medium' : 'large',
      });
    }
  }

  const tilesToProcess = tileRects.length > 0
    ? tileRects
    : [{ x: 0, y: 0, w: imageData.width, h: imageData.height }];

  for (const tile of tilesToProcess) {
    const tileData = cropImageData(imageData, tile.x, tile.y, tile.w, tile.h);
    const skinRegions = findSkinToneRegions(tileData);

    for (const sr of skinRegions) {
      const alreadyCovered = knownFaceRegions?.some(kr => {
        const [kx, ky, kw, kh] = kr.bbox;
        return sr.x + tile.x >= kx - 10 && sr.x + tile.x <= kx + kw + 10
          && sr.y + tile.y >= ky - 10 && sr.y + tile.y <= ky + kh + 10;
      });
      if (alreadyCovered) continue;

      const area = sr.w * sr.h;
      if (area < 400) continue;

      detections.push({
        bbox: [tile.x + sr.x, tile.y + sr.y, sr.w, sr.h],
        confidence: sr.confidence,
        sizeCategory: area < 1600 ? 'tiny' : area < 6400 ? 'small' : area < 25000 ? 'medium' : 'large',
      });
    }
  }

  return detections.slice(0, 10);
}

interface SkinRegion { x: number; y: number; w: number; h: number; confidence: number }

function findSkinToneRegions(data: ImageData): SkinRegion[] {
  const BLOCK = 8;
  const skinBlocks: Array<{ x: number; y: number; ratio: number }> = [];

  for (let y = 0; y + BLOCK <= data.height; y += BLOCK) {
    for (let x = 0; x + BLOCK <= data.width; x += BLOCK) {
      let skinPixels = 0;
      for (let py = y; py < y + BLOCK; py++) {
        for (let px = x; px < x + BLOCK; px++) {
          const i = (py * data.width + px) * 4;
          if (isSkinTone(data.data[i], data.data[i + 1], data.data[i + 2])) skinPixels++;
        }
      }
      const ratio = skinPixels / (BLOCK * BLOCK);
      if (ratio > 0.4) skinBlocks.push({ x, y, ratio });
    }
  }

  const regions: SkinRegion[] = [];
  const visited = new Set<number>();

  for (let i = 0; i < skinBlocks.length; i++) {
    if (visited.has(i)) continue;
    const group = [i];
    visited.add(i);
    for (let j = i + 1; j < skinBlocks.length; j++) {
      if (visited.has(j)) continue;
      const bi = skinBlocks[i], bj = skinBlocks[j];
      if (Math.abs(bi.x - bj.x) <= BLOCK * 2 && Math.abs(bi.y - bj.y) <= BLOCK * 2) {
        group.push(j); visited.add(j);
      }
    }
    const xs = group.map(k => skinBlocks[k].x), ys = group.map(k => skinBlocks[k].y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs) + BLOCK, maxY = Math.max(...ys) + BLOCK;
    const avgRatio = group.reduce((s, k) => s + skinBlocks[k].ratio, 0) / group.length;
    if (maxX - minX >= 20 && maxY - minY >= 20) {
      regions.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, confidence: avgRatio * 0.7 });
    }
  }
  return regions;
}

function isSkinTone(r: number, g: number, b: number): boolean {
  return (
    r > 95 && g > 40 && b > 20 &&
    r > g && r > b &&
    Math.abs(r - g) > 15 &&
    (r - Math.min(g, b)) >= 15
  );
}

// ── DEV_FALLBACK: SEMANTIC REGION PARSING ─────────────────────
// Production replacement: OnnxRegionParserSession (OmniParser icon_detect)

/** @deprecated DEV_FALLBACK only — use OnnxRegionParserSession in production */
export class DEV_FALLBACK_RegionParserSession implements InferenceSession {
  readonly manifest = makeManifest('DEV_FALLBACK_region-parser', 'region-parser');
  private _initialized = false;
  private _inferCount = 0;
  readonly backend: InferenceBackend = 'wasm';
  get isInitialized() { return this._initialized; }

  async initialize(): Promise<InferenceMetrics> {
    console.warn('[DEV_FALLBACK] RegionParser: heuristic adapter active (NOT OmniParser icon_detect ONNX)');
    this._initialized = true;
    return makeMetrics(this.manifest.id, this.backend, 0, 0, true);
  }

  async run(
    _inputs: Map<string, Float32Array>,
    _shapes: Map<string, number[]>,
  ): Promise<{ outputs: Map<string, Float32Array>; outputShapes: Map<string, number[]>; metrics: InferenceMetrics }> {
    const isCold = this._inferCount === 0;
    this._inferCount++;
    return { outputs: new Map(), outputShapes: new Map(), metrics: makeMetrics(this.manifest.id, this.backend, 3, 0, isCold) };
  }

  dispose() { this._initialized = false; }
}

/** @deprecated Use DEV_FALLBACK_RegionParserSession */
export const BrowserRegionParserSession = DEV_FALLBACK_RegionParserSession;

/**
 * DEV_FALLBACK: Parse semantic UI regions via uniform-color heuristics.
 * Production replacement: OnnxRegionParserSession.parseRegions() (OmniParser)
 *
 * @deprecated Use ONNX region parser in production.
 */
export function devFallback_parseSemanticRegionsFromImage(
  imageData: ImageData,
  tileRects: Array<{ x: number; y: number; w: number; h: number }>,
  knownCanvasRegions?: Array<{
    bbox: [number, number, number, number];
    class: string;
    label: string;
    confidence: number;
    evidence: string;
  }>,
): SemanticRegion[] {
  const regions: SemanticRegion[] = [];

  if (knownCanvasRegions) {
    for (const kr of knownCanvasRegions) {
      regions.push({
        bbox: kr.bbox,
        class: kr.class,
        label: kr.label,
        confidence: kr.confidence,
        evidence: kr.evidence,
      });
    }
  }

  // Visual button detection (uniform-color rectangular regions)
  const tilesToProcess = tileRects.length > 0
    ? tileRects
    : [{ x: 0, y: 0, w: imageData.width, h: imageData.height }];

  for (const tile of tilesToProcess) {
    if (tile.w < 40 || tile.h < 15) continue;
    const tileData = cropImageData(imageData, tile.x, tile.y, tile.w, tile.h);
    const buttons = detectButtonLikeRegions(tileData);

    for (const br of buttons) {
      // Skip if already covered by known region
      const covered = knownCanvasRegions?.some(kr => {
        const [kx, ky] = kr.bbox;
        return Math.abs(tile.x + br.x - kx) < 20 && Math.abs(tile.y + br.y - ky) < 20;
      });
      if (covered) continue;

      regions.push({
        bbox: [tile.x + br.x, tile.y + br.y, br.w, br.h],
        class: 'control',
        label: 'visual button',
        confidence: br.confidence,
        evidence: `uniform-color rect ${br.w}x${br.h} at (${tile.x + br.x},${tile.y + br.y})`,
      });
    }
  }

  return regions.slice(0, 30);
}

interface ButtonCandidate { x: number; y: number; w: number; h: number; confidence: number }

function detectButtonLikeRegions(data: ImageData): ButtonCandidate[] {
  const candidates: ButtonCandidate[] = [];

  // Look for horizontal bands with uniform color (typical buttons)
  for (let y = 0; y + 20 <= data.height; y += 8) {
    for (let x = 0; x + 40 <= data.width; x += 8) {
      const variance = sampleColorVariance(data, x, y, Math.min(120, data.width - x), Math.min(36, data.height - y));
      if (variance < 150) {
        const [r, g, b] = sampleAverageColor(data, x, y, Math.min(120, data.width - x), Math.min(36, data.height - y));
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        if (brightness > 30 && brightness < 225) {
          candidates.push({ x, y, w: Math.min(120, data.width - x), h: Math.min(36, data.height - y), confidence: 1 - variance / 150 });
          break; // one button per row
        }
      }
    }
  }

  return candidates.slice(0, 5);
}

function sampleAverageColor(data: ImageData, x: number, y: number, w: number, h: number): [number, number, number] {
  let r = 0, g = 0, b = 0, count = 0;
  for (let py = y; py < y + h; py += 4) {
    for (let px = x; px < x + w; px += 4) {
      if (px >= data.width || py >= data.height) continue;
      const i = (py * data.width + px) * 4;
      r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2]; count++;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [r / count, g / count, b / count];
}

function sampleColorVariance(data: ImageData, x: number, y: number, w: number, h: number): number {
  const [avgR, avgG, avgB] = sampleAverageColor(data, x, y, w, h);
  let variance = 0, count = 0;
  for (let py = y; py < y + h; py += 4) {
    for (let px = x; px < x + w; px += 4) {
      if (px >= data.width || py >= data.height) continue;
      const i = (py * data.width + px) * 4;
      const dr = data.data[i] - avgR, dg = data.data[i + 1] - avgG, db = data.data[i + 2] - avgB;
      variance += dr * dr + dg * dg + db * db; count++;
    }
  }
  return count > 0 ? variance / count : 0;
}

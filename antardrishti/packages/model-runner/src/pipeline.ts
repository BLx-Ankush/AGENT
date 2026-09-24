/**
 * ANTARDRISHTI — Perception Pipeline
 *
 * Event-driven visual perception pipeline (contract §4).
 * Uses changed-tile / ROI routing. Does NOT run continuous
 * full-screen VLM inference.
 *
 * Pipeline:
 *   SCREEN → CHANGED TILES → REGION PROPOSALS →
 *   TEXT/FACE/QR DETECTORS → OCR → SEMANTIC VISUAL RECOGNITION →
 *   VISUAL GROUNDING → DOM/VISUAL RECONCILIATION
 *
 * Resource strategy (contract §28):
 *   "Do not make local vision cheap. Make expensive vision rare."
 */

import type {
  InferenceSession,
  TextRegion,
  OcrResult,
  FaceDetection,
  SemanticRegion,
  InferenceMetrics,
} from './types';
import type {
  VisualGrounding,
  VisualRegionClass,
  VisualEvidence,
} from '@antardrishti/visual-grounding';
import { createVisualGrounding, resetVisualRegionCounter } from '@antardrishti/visual-grounding';
import {
  getImageData,
  cropImageData,
  devFallback_detectTextRegions,
  devFallback_recognizeTextFromRegions,
  devFallback_detectFacesFromImage,
  devFallback_parseSemanticRegionsFromImage,
} from './browser-adapters';
import type {
  OnnxTextDetectorSession,
  OnnxOcrSession,
  OnnxFaceDetectorSession,
  OnnxRegionParserSession,
} from './onnx-adapters';

// ── Fail-Closed Error ─────────────────────────────────────────

/**
 * Thrown when an ONNX model fails in production mode.
 * Callers MUST catch this and abort the pipeline — no network
 * transmission is permitted after a PerceptionFailureError.
 *
 * DEV_FALLBACK is only available when devFallbackEnabled is set
 * via PerceptionPipeline.setDevFallback(true). It must NEVER
 * activate silently in production.
 */
export class PerceptionFailureError extends Error {
  constructor(
    public readonly stage: 'text-detection' | 'ocr' | 'face-detection' | 'region-parsing',
    public readonly cause: unknown,
  ) {
    super(
      `[PerceptionPipeline] FAIL-CLOSED: ${stage} failed. ` +
      `No network transmission permitted. ` +
      `Enable devFallbackEnabled for offline testing only. ` +
      `Cause: ${cause}`,
    );
    this.name = 'PerceptionFailureError';
  }
}

// ── Perception context — DOM/canvas data fed from content script ──

/** Canvas-rendered content extracted by the content script */
export interface CanvasRegionData {
  /** Text drawn on the canvas */
  canvasTexts: Array<{ text: string; bbox: [number, number, number, number] }>;
  /** Known face/avatar regions (from DOM canvas analysis) */
  faceRegions: Array<{ bbox: [number, number, number, number]; confidence: number }>;
  /** Known control regions (e.g., Pay Now button canvas) */
  controlRegions: Array<{
    bbox: [number, number, number, number];
    class: string;
    label: string;
    confidence: number;
    evidence: string;
  }>;
}

// ── ROI instrumentation ──────────────────────────────────────

export interface RoiMetrics {
  /** Full viewport pixel count */
  fullViewportPixels: number;
  /** Total ROI pixel count actually sent to inference */
  roiPixels: number;
  /** Number of ROI regions */
  roiCount: number;
  /** Whether full-frame fallback occurred */
  fullFrameFallback: boolean;
  /** Per-ROI dimensions */
  roiDimensions: Array<{ x: number; y: number; w: number; h: number }>;
  /** Coverage ratio (roiPixels / fullViewportPixels) */
  coverageRatio: number;
}

// ── Pipeline result ──────────────────────────────────────────

export interface PerceptionResult {
  observationId: string;
  frameId: number;
  documentGeneration: string;
  /** Text regions detected */
  textRegions: TextRegion[];
  /** OCR results */
  ocrResults: OcrResult[];
  /** Face detections */
  faceDetections: FaceDetection[];
  /** Semantic regions (from UI parsing / grounding model) */
  semanticRegions: SemanticRegion[];
  /** Visual grounding records */
  groundings: VisualGrounding[];
  /** All inference metrics from this pipeline run */
  metrics: InferenceMetrics[];
  /** Total pipeline time in ms */
  totalMs: number;
  /** Number of tiles processed */
  tilesProcessed: number;
  /** P0.6: ROI workload instrumentation */
  roiMetrics: RoiMetrics;
}

// ── Pipeline triggers ────────────────────────────────────────

export type PerceptionTrigger =
  | 'user-task'
  | 'navigation'
  | 'history-state'
  | 'dom-mutation'
  | 'frame-navigation'
  | 'form-change'
  | 'focus-change'
  | 'scroll-complete'
  | 'viewport-resize'
  | 'zoom-change'
  | 'dpr-change'
  | 'action-completion'
  | 'visual-change';

// ── Perception Pipeline ──────────────────────────────────────

export class PerceptionPipeline {
  // ONNX model sessions (production path)
  private onnxTextDetector: OnnxTextDetectorSession | null = null;
  private onnxOcrRecognizer: OnnxOcrSession | null = null;
  private onnxFaceDetector: OnnxFaceDetectorSession | null = null;
  private onnxRegionParser: OnnxRegionParserSession | null = null;

  // Legacy InferenceSession slots (kept for interface compatibility)
  private textDetector: InferenceSession | null = null;
  private ocrRecognizer: InferenceSession | null = null;
  private faceDetector: InferenceSession | null = null;
  private regionParser: InferenceSession | null = null;
  private groundingModel: InferenceSession | null = null;

  private _initialized = false;

  /**
   * DEV_FALLBACK gate.
   *
   * When FALSE (production default): ONNX failure → PerceptionFailureError.
   *   The entire pipeline aborts. No sanitization or network call is made.
   *
   * When TRUE (test/dev only): ONNX failure → DEV_FALLBACK heuristic.
   *   Must be explicitly enabled. Must NEVER be set in production code paths.
   *
   * Set via: pipeline.setDevFallback(true)
   */
  private devFallbackEnabled = false;

  /**
   * Enable DEV_FALLBACK for offline testing/development.
   * MUST NOT be called in production code paths.
   * When disabled (default), ONNX failure = pipeline abort.
   */
  setDevFallback(enabled: boolean): void {
    this.devFallbackEnabled = enabled;
    if (enabled) {
      console.warn(
        '[PerceptionPipeline] DEV_FALLBACK ENABLED. ' +
        'ONNX failures will fall through to heuristics. ' +
        'This MUST NOT be active in production.',
      );
    } else {
      console.log('[PerceptionPipeline] PRODUCTION MODE: ONNX failure = fail closed.');
    }
  }

  get isDevFallbackEnabled(): boolean {
    return this.devFallbackEnabled;
  }

  /**
   * Register production ONNX sessions (from model-manifests loadProductionModels).
   * When registered, these take priority over DEV_FALLBACK adapters.
   */
  registerOnnxModels(models: {
    textDetector: OnnxTextDetectorSession;
    ocrRecognizer: OnnxOcrSession;
    faceDetector: OnnxFaceDetectorSession;
    regionParser: OnnxRegionParserSession;
  }): void {
    this.onnxTextDetector = models.textDetector;
    this.onnxOcrRecognizer = models.ocrRecognizer;
    this.onnxFaceDetector = models.faceDetector;
    this.onnxRegionParser = models.regionParser;
    this._initialized = true;
    console.log('[Perception] PRODUCTION ONNX models registered:', {
      textDetector: models.textDetector.manifest.id,
      ocrRecognizer: models.ocrRecognizer.manifest.id,
      faceDetector: models.faceDetector.manifest.id,
      regionParser: models.regionParser.manifest.id,
    });
  }

  /**
   * Register inference sessions for each detection stage.
   * Models are provided externally — the pipeline doesn't know
   * which specific model is being used.
   */
  registerModels(models: {
    textDetector?: InferenceSession;
    ocrRecognizer?: InferenceSession;
    faceDetector?: InferenceSession;
    regionParser?: InferenceSession;
    groundingModel?: InferenceSession;
  }): void {
    if (models.textDetector) this.textDetector = models.textDetector;
    if (models.ocrRecognizer) this.ocrRecognizer = models.ocrRecognizer;
    if (models.faceDetector) this.faceDetector = models.faceDetector;
    if (models.regionParser) this.regionParser = models.regionParser;
    if (models.groundingModel) this.groundingModel = models.groundingModel;
    this._initialized = true;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Run the perception pipeline on changed tiles.
   * Returns all detections, OCR results, and visual groundings.
   *
   * Contract §28: expensive vision is rare — only process changed tiles.
   */
  async run(
    imageData: ImageData | OffscreenCanvas,
    changedTileRects: Array<{ x: number; y: number; w: number; h: number }>,
    observationId: string,
    frameId: number,
    documentGeneration: string,
    canvasContext?: CanvasRegionData,
  ): Promise<PerceptionResult> {
    const startTime = performance.now();
    resetVisualRegionCounter();
    const allMetrics: InferenceMetrics[] = [];
    const imgData = getImageData(imageData);

    // P0.6: Compute ROI metrics
    const fullViewportPixels = imgData.width * imgData.height;
    const isFullFrame = this.isFullViewportTile(changedTileRects, imgData.width, imgData.height);
    const roiPixels = changedTileRects.reduce((s, t) => s + t.w * t.h, 0);

    console.log('[Perception] ── Pipeline start ──', {
      observationId: observationId.substring(0, 16),
      tiles: changedTileRects.length,
      fullFrame: isFullFrame,
      viewportPixels: fullViewportPixels,
      roiPixels,
      coverageRatio: `${(roiPixels / fullViewportPixels * 100).toFixed(1)}%`,
      canvasTexts: canvasContext?.canvasTexts.length ?? 0,
      faceHints: canvasContext?.faceRegions.length ?? 0,
      controlHints: canvasContext?.controlRegions.length ?? 0,
    });

    const t0 = performance.now();

    // 1. Text detection on changed tiles (P0.6: per-ROI crop + remap)
    const textRegions = await this.detectTextRegions(
      imgData, changedTileRects, allMetrics,
    );
    console.log('[Perception] [1/5] Text regions:', textRegions.length, `(${Math.round(performance.now() - t0)}ms)`);

    // 2. OCR on detected text regions (+ canvas-extracted texts)
    const ocrResults = await this.recognizeText(
      imgData, textRegions, allMetrics, canvasContext?.canvasTexts,
    );
    console.log('[Perception] [2/5] OCR results:', ocrResults.length);

    // 3. Face detection on changed tiles (P0.6: per-ROI crop + remap)
    const faceDetections = await this.detectFaces(
      imgData, changedTileRects, allMetrics, canvasContext?.faceRegions,
    );
    console.log('[Perception] [3/5] Face detections:', faceDetections.length);

    // 4. Semantic region parsing (P0.6: per-ROI crop + remap)
    const semanticRegions = await this.parseRegions(
      imgData, changedTileRects, allMetrics, canvasContext?.controlRegions,
    );
    console.log('[Perception] [4/5] Semantic regions:', semanticRegions.length);

    // 5. Build visual grounding records
    const groundings = this.buildGroundings(
      textRegions,
      ocrResults,
      faceDetections,
      semanticRegions,
      observationId,
      frameId,
      documentGeneration,
    );
    console.log('[Perception] [5/5] Visual groundings:', groundings.length);

    const totalMs = performance.now() - startTime;

    const roiMetricsData: RoiMetrics = {
      fullViewportPixels,
      roiPixels,
      roiCount: changedTileRects.length,
      fullFrameFallback: isFullFrame,
      roiDimensions: changedTileRects.map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h })),
      coverageRatio: fullViewportPixels > 0 ? roiPixels / fullViewportPixels : 1,
    };

    console.log('[Perception] ── Pipeline done ──', {
      totalMs: Math.round(totalMs),
      modelsInvoked: allMetrics.map(m => m.modelId).join(', '),
      textRegions: textRegions.length,
      ocrRegions: ocrResults.length,
      faceDetections: faceDetections.length,
      groundedTargets: groundings.filter(g => g.candidateTargetId !== null).length,
      roi: `${roiMetricsData.roiCount} ROIs, ${(roiMetricsData.coverageRatio * 100).toFixed(1)}% coverage`,
    });

    return {
      observationId,
      frameId,
      documentGeneration,
      textRegions,
      ocrResults,
      faceDetections,
      semanticRegions,
      groundings,
      metrics: allMetrics,
      totalMs,
      tilesProcessed: changedTileRects.length,
      roiMetrics: roiMetricsData,
    };
  }

  // ── P0.6: ROI helpers ──────────────────────────────────────

  /**
   * Detect whether the tile set represents the full viewport (fallback).
   */
  private isFullViewportTile(
    tiles: Array<{ x: number; y: number; w: number; h: number }>,
    viewportW: number,
    viewportH: number,
  ): boolean {
    if (tiles.length !== 1) return false;
    const t = tiles[0];
    return t.x === 0 && t.y === 0 && t.w === viewportW && t.h === viewportH;
  }

  /**
   * Remap a [x,y,w,h] bbox from ROI-local coordinates to viewport coordinates.
   */
  private remapBbox(
    bbox: [number, number, number, number],
    roiOrigin: { x: number; y: number },
  ): [number, number, number, number] {
    return [bbox[0] + roiOrigin.x, bbox[1] + roiOrigin.y, bbox[2], bbox[3]];
  }

  // ── Detection stages ────────────────────────────────────────
  //
  // PRODUCTION (default): ONNX failure → throw PerceptionFailureError.
  //   The error propagates through run() to the coordinator, which
  //   aborts before sanitization and planner call. No PII risk.
  //
  // DEV_FALLBACK (explicit only): requires setDevFallback(true).
  //   Safe only for offline testing with no real user PII.

  private async detectTextRegions(
    imgData: ImageData,
    tiles: Array<{ x: number; y: number; w: number; h: number }>,
    metrics: InferenceMetrics[],
  ): Promise<TextRegion[]> {
    // PRODUCTION: PP-OCRv4 DBNet via ONNX Runtime Web — P0.6: per-ROI crop + remap
    if (this.onnxTextDetector?.isInitialized) {
      try {
        const t0 = performance.now();
        const allRegions: TextRegion[] = [];
        let totalProcessedPixels = 0;

        for (const tile of tiles) {
          // P0.6: Crop to tile ROI — model receives only the changed region
          const roiData = cropImageData(imgData, tile.x, tile.y, tile.w, tile.h);
          totalProcessedPixels += roiData.width * roiData.height;

          const tileRegions = await this.onnxTextDetector.detectRegions(roiData);

          // P0.6: Remap ROI-local coordinates to viewport coordinates
          for (const region of tileRegions) {
            region.bbox = this.remapBbox(region.bbox, tile);
            if (region.polygon) {
              region.polygon = region.polygon.map(([px, py]) => [px + tile.x, py + tile.y] as [number, number]);
            }
            allRegions.push(region);
          }
        }

        metrics.push({
          modelId: this.onnxTextDetector.manifest.id,
          backend: this.onnxTextDetector.backend,
          modelSizeBytes: this.onnxTextDetector.manifest.sizeBytes,
          initTimeMs: 0,
          isCold: false,
          inferenceMs: performance.now() - t0,
          preprocessMs: 0,
          postprocessMs: 0,
          totalMs: performance.now() - t0,
          processedPixels: totalProcessedPixels,
          timestamp: new Date().toISOString(),
        });
        console.log(`[Perception] [ONNX] text-detector: ${allRegions.length} regions (${tiles.length} ROIs, ${totalProcessedPixels}px)`);
        return allRegions;
      } catch (e) {
        if (!this.devFallbackEnabled) {
          throw new PerceptionFailureError('text-detection', e);
        }
        console.warn('[DEV_FALLBACK] text-detector ONNX failed, using heuristic (devFallbackEnabled=true):', e);
      }
    }

    // No ONNX session registered:
    if (!this.devFallbackEnabled) {
      throw new PerceptionFailureError(
        'text-detection',
        'No ONNX text-detector session registered. Load models before running pipeline.',
      );
    }

    // DEV_FALLBACK path — only reached if devFallbackEnabled=true
    const t0 = performance.now();
    const regions = devFallback_detectTextRegions(imgData, tiles);
    const processedPixels = tiles.reduce((s, t) => s + t.w * t.h, 0);
    metrics.push({
      modelId: 'DEV_FALLBACK_text-detector',
      backend: 'wasm',
      modelSizeBytes: 0,
      initTimeMs: 0,
      isCold: false,
      inferenceMs: performance.now() - t0,
      preprocessMs: 0,
      postprocessMs: 0,
      totalMs: performance.now() - t0,
      processedPixels,
      timestamp: new Date().toISOString(),
    });
    return regions;
  }

  private async recognizeText(
    imgData: ImageData,
    regions: TextRegion[],
    metrics: InferenceMetrics[],
    canvasTexts?: Array<{ text: string; bbox: [number, number, number, number] }>,
  ): Promise<OcrResult[]> {

    // PRODUCTION: PP-OCRv4 rec via ONNX Runtime Web
    if (this.onnxOcrRecognizer?.isInitialized && regions.length > 0) {
      try {
        const t0 = performance.now();
        const results: OcrResult[] = [];

        for (const region of regions) {
          const [rx, ry, rw, rh] = region.bbox;
          const crop = cropImageData(imgData, rx, ry, rw, rh);
          const result = await this.onnxOcrRecognizer.recognizeText(crop, region.bbox);
          if (result.text.trim().length > 0) {
            results.push(result);
          }
        }

        // Canvas texts are always added at 0.99 confidence (direct canvas API access)
        if (canvasTexts) {
          for (const ct of canvasTexts) {
            results.push({ text: ct.text, confidence: 0.99, regionBbox: ct.bbox });
          }
        }

        metrics.push({
          modelId: this.onnxOcrRecognizer.manifest.id,
          backend: this.onnxOcrRecognizer.backend,
          modelSizeBytes: this.onnxOcrRecognizer.manifest.sizeBytes,
          initTimeMs: 0,
          isCold: false,
          inferenceMs: performance.now() - t0,
          preprocessMs: 0,
          postprocessMs: 0,
          totalMs: performance.now() - t0,
          processedPixels: regions.reduce((s, r) => s + r.bbox[2] * r.bbox[3], 0),
          timestamp: new Date().toISOString(),
        });
        console.log(`[Perception] [ONNX] ocr-recognizer: ${results.length} results`);
        return results;
      } catch (e) {
        if (!this.devFallbackEnabled) {
          throw new PerceptionFailureError('ocr', e);
        }
        console.warn('[DEV_FALLBACK] ocr-recognizer ONNX failed, using heuristic (devFallbackEnabled=true):', e);
      }
    }

    // No ONNX session OR regions.length === 0
    if (this.onnxOcrRecognizer?.isInitialized && regions.length === 0) {
      // No regions to process — not a failure, just empty
      if (canvasTexts?.length) {
        return canvasTexts.map(ct => ({ text: ct.text, confidence: 0.99, regionBbox: ct.bbox }));
      }
      return [];
    }

    if (!this.onnxOcrRecognizer?.isInitialized && !this.devFallbackEnabled) {
      throw new PerceptionFailureError(
        'ocr',
        'No ONNX OCR session registered. Load models before running pipeline.',
      );
    }

    // DEV_FALLBACK path
    const t0 = performance.now();
    const results = await devFallback_recognizeTextFromRegions(imgData, regions, canvasTexts);
    metrics.push({
      modelId: 'DEV_FALLBACK_ocr',
      backend: 'wasm',
      modelSizeBytes: 0,
      initTimeMs: 0,
      isCold: false,
      inferenceMs: performance.now() - t0,
      preprocessMs: 0,
      postprocessMs: 0,
      totalMs: performance.now() - t0,
      processedPixels: regions.reduce((s, r) => s + r.bbox[2] * r.bbox[3], 0),
      timestamp: new Date().toISOString(),
    });
    return results;
  }

  private async detectFaces(
    imgData: ImageData,
    tiles: Array<{ x: number; y: number; w: number; h: number }>,
    metrics: InferenceMetrics[],
    knownFaceRegions?: Array<{ bbox: [number, number, number, number]; confidence: number }>,
  ): Promise<FaceDetection[]> {
    // PRODUCTION: BlazeFace via ONNX Runtime Web — P0.6: per-ROI crop + remap
    if (this.onnxFaceDetector?.isInitialized) {
      try {
        const t0 = performance.now();
        const allDetections: FaceDetection[] = [];
        let totalProcessedPixels = 0;

        for (const tile of tiles) {
          // P0.6: Crop to tile ROI
          const roiData = cropImageData(imgData, tile.x, tile.y, tile.w, tile.h);
          totalProcessedPixels += roiData.width * roiData.height;

          const tileDetections = await this.onnxFaceDetector.detectFaces(roiData);

          // P0.6: Remap ROI-local coordinates to viewport coordinates
          for (const det of tileDetections) {
            det.bbox = this.remapBbox(det.bbox, tile);
            allDetections.push(det);
          }
        }

        // Known face regions (canvas API) are already in viewport coords
        if (knownFaceRegions) {
          for (const kr of knownFaceRegions) {
            const [, , w, h] = kr.bbox;
            const area = w * h;
            allDetections.push({
              bbox: kr.bbox,
              confidence: kr.confidence,
              sizeCategory: area < 1600 ? 'tiny' : area < 6400 ? 'small' : area < 25000 ? 'medium' : 'large',
            });
          }
        }

        metrics.push({
          modelId: this.onnxFaceDetector.manifest.id,
          backend: this.onnxFaceDetector.backend,
          modelSizeBytes: this.onnxFaceDetector.manifest.sizeBytes,
          initTimeMs: 0,
          isCold: false,
          inferenceMs: performance.now() - t0,
          preprocessMs: 0,
          postprocessMs: 0,
          totalMs: performance.now() - t0,
          processedPixels: totalProcessedPixels,
          timestamp: new Date().toISOString(),
        });
        console.log(`[Perception] [ONNX] face-detector: ${allDetections.length} detections (${tiles.length} ROIs, ${totalProcessedPixels}px)`);
        return allDetections;
      } catch (e) {
        if (!this.devFallbackEnabled) {
          throw new PerceptionFailureError('face-detection', e);
        }
        console.warn('[DEV_FALLBACK] face-detector ONNX failed, using heuristic (devFallbackEnabled=true):', e);
      }
    }

    if (!this.devFallbackEnabled) {
      throw new PerceptionFailureError(
        'face-detection',
        'No ONNX face-detector session registered. Load models before running pipeline.',
      );
    }

    // DEV_FALLBACK path
    const t0 = performance.now();
    const detections = devFallback_detectFacesFromImage(imgData, tiles, knownFaceRegions);
    const processedPixels = tiles.reduce((s, t) => s + t.w * t.h, 0);
    metrics.push({
      modelId: 'DEV_FALLBACK_face-detector',
      backend: 'wasm',
      modelSizeBytes: 0,
      initTimeMs: 0,
      isCold: false,
      inferenceMs: performance.now() - t0,
      preprocessMs: 0,
      postprocessMs: 0,
      totalMs: performance.now() - t0,
      processedPixels,
      timestamp: new Date().toISOString(),
    });
    return detections;
  }

  private async parseRegions(
    imgData: ImageData,
    tiles: Array<{ x: number; y: number; w: number; h: number }>,
    metrics: InferenceMetrics[],
    knownCanvasRegions?: Array<{
      bbox: [number, number, number, number];
      class: string;
      label: string;
      confidence: number;
      evidence: string;
    }>,
  ): Promise<SemanticRegion[]> {
    // PRODUCTION: OmniParser icon_detect via ONNX Runtime Web — P0.6: per-ROI crop + remap
    if (this.onnxRegionParser?.isInitialized) {
      try {
        const t0 = performance.now();
        const allRegions: SemanticRegion[] = [];
        let totalProcessedPixels = 0;

        for (const tile of tiles) {
          // P0.6: Crop to tile ROI
          const roiData = cropImageData(imgData, tile.x, tile.y, tile.w, tile.h);
          totalProcessedPixels += roiData.width * roiData.height;

          const tileRegions = await this.onnxRegionParser.parseRegions(roiData);

          // P0.6: Remap ROI-local coordinates to viewport coordinates
          for (const region of tileRegions) {
            region.bbox = this.remapBbox(region.bbox, tile);
            allRegions.push(region);
          }
        }

        // Known canvas regions are already in viewport coords
        if (knownCanvasRegions) {
          for (const kr of knownCanvasRegions) {
            allRegions.push({
              bbox: kr.bbox,
              class: kr.class,
              label: kr.label,
              confidence: kr.confidence,
              evidence: `canvas-context: ${kr.evidence}`,
            });
          }
        }

        metrics.push({
          modelId: this.onnxRegionParser.manifest.id,
          backend: this.onnxRegionParser.backend,
          modelSizeBytes: this.onnxRegionParser.manifest.sizeBytes,
          initTimeMs: 0,
          isCold: false,
          inferenceMs: performance.now() - t0,
          preprocessMs: 0,
          postprocessMs: 0,
          totalMs: performance.now() - t0,
          processedPixels: totalProcessedPixels,
          timestamp: new Date().toISOString(),
        });
        console.log(`[Perception] [ONNX] region-parser (OmniParser): ${allRegions.length} regions (${tiles.length} ROIs, ${totalProcessedPixels}px)`);
        return allRegions;
      } catch (e) {
        if (!this.devFallbackEnabled) {
          throw new PerceptionFailureError('region-parsing', e);
        }
        console.warn('[DEV_FALLBACK] region-parser ONNX failed, using heuristic (devFallbackEnabled=true):', e);
      }
    }

    if (!this.devFallbackEnabled) {
      throw new PerceptionFailureError(
        'region-parsing',
        'No ONNX region-parser session registered. Load models before running pipeline.',
      );
    }

    // DEV_FALLBACK path
    const t0 = performance.now();
    const regions = devFallback_parseSemanticRegionsFromImage(imgData, tiles, knownCanvasRegions);
    const processedPixels = tiles.reduce((s, t) => s + t.w * t.h, 0);
    metrics.push({
      modelId: 'DEV_FALLBACK_region-parser',
      backend: 'wasm',
      modelSizeBytes: 0,
      initTimeMs: 0,
      isCold: false,
      inferenceMs: performance.now() - t0,
      preprocessMs: 0,
      postprocessMs: 0,
      totalMs: performance.now() - t0,
      processedPixels,
      timestamp: new Date().toISOString(),
    });
    return regions;
  }

  // ── Grounding builder ──────────────────────────────────────

  /**
   * Build VisualGrounding records from all detection results.
   * Each region gets semantic meaning, not just "there is text."
   * (Contract §6: semantic visual recognition is mandatory.)
   */
  private buildGroundings(
    textRegions: TextRegion[],
    ocrResults: OcrResult[],
    faces: FaceDetection[],
    semanticRegions: SemanticRegion[],
    observationId: string,
    frameId: number,
    documentGeneration: string,
  ): VisualGrounding[] {
    const groundings: VisualGrounding[] = [];

    // Text regions → grounding with OCR semantic label
    for (const ocr of ocrResults) {
      const semanticLabel = classifyTextSemantics(ocr.text);
      const regionClass = semanticLabel.class;

      groundings.push(
        createVisualGrounding(
          observationId,
          frameId,
          documentGeneration,
          {
            x: ocr.regionBbox[0],
            y: ocr.regionBbox[1],
            w: ocr.regionBbox[2],
            h: ocr.regionBbox[3],
          },
          regionClass,
          semanticLabel.label,
          ocr.confidence,
          [
            {
              source: 'ocr',
              finding: `text: "${ocr.text.substring(0, 50)}"`,
              confidence: ocr.confidence,
            },
            {
              source: 'semantic-classifier',
              finding: `classified as: ${semanticLabel.label}`,
              confidence: semanticLabel.confidence,
            },
          ],
        ),
      );
    }

    // Unmatched text regions (no OCR result)
    for (const tr of textRegions) {
      const hasOcr = ocrResults.some(
        (o) =>
          Math.abs(o.regionBbox[0] - tr.bbox[0]) < 5 &&
          Math.abs(o.regionBbox[1] - tr.bbox[1]) < 5,
      );
      if (!hasOcr) {
        groundings.push(
          createVisualGrounding(
            observationId, frameId, documentGeneration,
            { x: tr.bbox[0], y: tr.bbox[1], w: tr.bbox[2], h: tr.bbox[3] },
            'text', 'unrecognized text', tr.confidence,
            [{ source: 'text-detector', finding: 'text region detected', confidence: tr.confidence }],
          ),
        );
      }
    }

    // Faces → biometric grounding
    for (const face of faces) {
      groundings.push(
        createVisualGrounding(
          observationId, frameId, documentGeneration,
          { x: face.bbox[0], y: face.bbox[1], w: face.bbox[2], h: face.bbox[3] },
          'face', 'biometric',
          face.confidence,
          [{
            source: 'face-detector',
            finding: `face (${face.sizeCategory})`,
            confidence: face.confidence,
          }],
        ),
      );
    }

    // Semantic regions → grounding with class and label
    for (const sr of semanticRegions) {
      const regionClass = mapSemanticClass(sr.class);
      groundings.push(
        createVisualGrounding(
          observationId, frameId, documentGeneration,
          { x: sr.bbox[0], y: sr.bbox[1], w: sr.bbox[2], h: sr.bbox[3] },
          regionClass, sr.label,
          sr.confidence,
          [{ source: 'region-parser', finding: sr.evidence, confidence: sr.confidence }],
        ),
      );
    }

    return groundings;
  }

  dispose(): void {
    this.textDetector?.dispose();
    this.ocrRecognizer?.dispose();
    this.faceDetector?.dispose();
    this.regionParser?.dispose();
    this.groundingModel?.dispose();
    this._initialized = false;
  }
}

// ── Semantic text classification (contract §6) ───────────────

interface TextSemantic {
  class: VisualRegionClass;
  label: string;
  confidence: number;
}

/**
 * Classify OCR text into semantic categories.
 * This is the mandatory semantic visual recognition step —
 * a detector must not merely say "there is text."
 */
function classifyTextSemantics(text: string): TextSemantic {
  const lower = text.toLowerCase().trim();

  // Email pattern
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(lower)) {
    return { class: 'text', label: 'email address', confidence: 0.95 };
  }

  // Phone pattern
  if (/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(lower)) {
    return { class: 'text', label: 'phone number', confidence: 0.9 };
  }

  // Credit card pattern (basic)
  if (/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(lower)) {
    return { class: 'identifier', label: 'card number', confidence: 0.9 };
  }

  // Account/ID number
  if (/\b(?:acc(?:ount)?|id|no|number)[\s:#]*\d{5,}/i.test(text)) {
    return { class: 'identifier', label: 'account number', confidence: 0.8 };
  }

  // Payment/action controls
  if (/^(?:pay\s*now|submit|confirm|send|buy|purchase|checkout)/i.test(lower)) {
    return { class: 'payment-control', label: text.trim(), confidence: 0.85 };
  }

  // Button-like text
  if (/^(?:sign\s*in|log\s*in|sign\s*up|register|subscribe|next|continue|ok|cancel)/i.test(lower)) {
    return { class: 'control', label: text.trim(), confidence: 0.8 };
  }

  // Aadhaar-like
  if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(text)) {
    return { class: 'identifier', label: 'identity number', confidence: 0.8 };
  }

  // PAN-like
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) {
    return { class: 'identifier', label: 'tax identifier', confidence: 0.85 };
  }

  // Default: generic text
  return { class: 'text', label: text.substring(0, 50).trim(), confidence: 0.5 };
}

function mapSemanticClass(cls: string): VisualRegionClass {
  const lower = cls.toLowerCase();
  if (lower.includes('face')) return 'face';
  if (lower.includes('qr') || lower.includes('barcode')) return 'qr';
  if (lower.includes('document') || lower.includes('card')) return 'document';
  if (lower.includes('signature')) return 'signature';
  if (lower.includes('button') || lower.includes('control')) return 'control';
  if (lower.includes('payment') || lower.includes('pay')) return 'payment-control';
  if (lower.includes('text') || lower.includes('label')) return 'text';
  if (lower.includes('image') || lower.includes('photo')) return 'image';
  return 'unknown';
}

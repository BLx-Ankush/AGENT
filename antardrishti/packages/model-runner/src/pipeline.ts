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
  private textDetector: InferenceSession | null = null;
  private ocrRecognizer: InferenceSession | null = null;
  private faceDetector: InferenceSession | null = null;
  private regionParser: InferenceSession | null = null;
  private groundingModel: InferenceSession | null = null;

  private _initialized = false;

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
  ): Promise<PerceptionResult> {
    const startTime = performance.now();
    resetVisualRegionCounter();
    const allMetrics: InferenceMetrics[] = [];

    // 1. Text detection on changed tiles
    const textRegions = await this.detectTextRegions(
      imageData, changedTileRects, allMetrics,
    );

    // 2. OCR on detected text regions
    const ocrResults = await this.recognizeText(
      imageData, textRegions, allMetrics,
    );

    // 3. Face detection on changed tiles
    const faceDetections = await this.detectFaces(
      imageData, changedTileRects, allMetrics,
    );

    // 4. Semantic region parsing (UI elements, controls)
    const semanticRegions = await this.parseRegions(
      imageData, changedTileRects, allMetrics,
    );

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

    const totalMs = performance.now() - startTime;

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
    };
  }

  // ── Detection stages (stubs until models are loaded) ───────

  private async detectTextRegions(
    _imageData: ImageData | OffscreenCanvas,
    _tiles: Array<{ x: number; y: number; w: number; h: number }>,
    _metrics: InferenceMetrics[],
  ): Promise<TextRegion[]> {
    if (!this.textDetector?.isInitialized) return [];
    // TODO: Phase 3 full integration — run text detector on tiles
    // Pre-process tile crops → run model → post-process detections
    return [];
  }

  private async recognizeText(
    _imageData: ImageData | OffscreenCanvas,
    _regions: TextRegion[],
    _metrics: InferenceMetrics[],
  ): Promise<OcrResult[]> {
    if (!this.ocrRecognizer?.isInitialized) return [];
    // TODO: Phase 3 — crop text regions → run OCR → return text
    return [];
  }

  private async detectFaces(
    _imageData: ImageData | OffscreenCanvas,
    _tiles: Array<{ x: number; y: number; w: number; h: number }>,
    _metrics: InferenceMetrics[],
  ): Promise<FaceDetection[]> {
    if (!this.faceDetector?.isInitialized) return [];
    // TODO: Phase 3 — run face detector
    return [];
  }

  private async parseRegions(
    _imageData: ImageData | OffscreenCanvas,
    _tiles: Array<{ x: number; y: number; w: number; h: number }>,
    _metrics: InferenceMetrics[],
  ): Promise<SemanticRegion[]> {
    if (!this.regionParser?.isInitialized) return [];
    // TODO: Phase 3 — run region parser (OmniParser-style)
    return [];
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

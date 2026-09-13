/**
 * ANTARDRISHTI — Visual Redactor
 *
 * Redacts sensitive visual regions BEFORE any network transmission.
 * This is a LOCAL-ONLY operation — raw pixels never leave the browser.
 *
 * What it redacts:
 *   - Faces (biometric)
 *   - Account numbers (canvas-rendered)
 *   - PAN / Aadhaar-like identifiers
 *   - Passwords / OTPs
 *   - QR codes containing sensitive data
 *   - Any region classified as sensitive by the privacy engine
 *
 * Output: an ImageData (or data URL) with sensitive regions replaced
 * by opaque black boxes + a token label overlay.
 *
 * The sanitized visual representation must contain no recoverable raw PII.
 */

export interface RedactionRegion {
  /** Bounding box [x, y, width, height] in image coordinates */
  bbox: [number, number, number, number];
  /** Token ID to show as label (e.g., FACE_01, EMAIL_01) */
  tokenId: string;
  /** Category for audit log */
  category: 'face' | 'text-pii' | 'account' | 'qr' | 'biometric' | 'credential';
}

export interface VisualRedactionResult {
  /** Whether any redactions were applied */
  hasRedactions: boolean;
  /** Number of regions redacted */
  redactedCount: number;
  /** Regions that were redacted */
  redactedRegions: RedactionRegion[];
  /**
   * Produce a redacted copy using the provided renderer.
   * Call this with a drawing function appropriate for the execution context.
   */
  applyTo(renderer: VisualRedactionRenderer): void;
}

/**
 * Abstract renderer interface so visual redaction works both in
 * browser (OffscreenCanvas) and test environments.
 */
export interface VisualRedactionRenderer {
  fillBlackBox(x: number, y: number, w: number, h: number): void;
  drawLabel(text: string, x: number, y: number): void;
}

/**
 * Plan visual redactions for a set of sensitive regions.
 * Returns a VisualRedactionResult that can be applied to any renderer.
 *
 * Does NOT modify the source image — caller controls rendering.
 */
export function planVisualRedactions(
  regions: RedactionRegion[],
): VisualRedactionResult {
  return {
    hasRedactions: regions.length > 0,
    redactedCount: regions.length,
    redactedRegions: regions,
    applyTo(renderer: VisualRedactionRenderer) {
      for (const region of regions) {
        const [x, y, w, h] = region.bbox;
        // Black fill covering the entire sensitive region
        renderer.fillBlackBox(x, y, w, h);
        // Token label at the top-left of the redacted area
        renderer.drawLabel(`[${region.tokenId}]`, x + 2, y + 2);
      }
    },
  };
}

/**
 * Create an OffscreenCanvas-based renderer for use in a browser context.
 * Draws black boxes with white token labels over sensitive regions.
 */
export function createOffscreenCanvasRenderer(
  canvas: OffscreenCanvas,
): VisualRedactionRenderer {
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  return {
    fillBlackBox(x: number, y: number, w: number, h: number) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(x, y, w, h);
    },
    drawLabel(text: string, x: number, y: number) {
      ctx.font = 'bold 11px monospace';
      ctx.fillStyle = '#FF4444';
      ctx.fillText(text, x, y + 11);
    },
  };
}

/**
 * Redact an ImageData by applying black boxes over all sensitive regions.
 * Returns a new ImageData with sensitive regions replaced.
 *
 * This is the primary visual redaction path for the browser extension.
 * Result MUST be used instead of the raw screenshot for all downstream output.
 *
 * TRUST BOUNDARY: Raw ImageData never leaves this function for network use.
 * Only the redacted result crosses any boundary.
 */
export function redactImageData(
  source: ImageData,
  regions: RedactionRegion[],
): { redacted: ImageData; result: VisualRedactionResult } {
  // Copy source pixels
  const redactedData = new Uint8ClampedArray(source.data);
  const result = planVisualRedactions(regions);

  // Apply black pixels over each sensitive region
  for (const region of regions) {
    const [rx, ry, rw, rh] = region.bbox;

    const x0 = Math.max(0, Math.round(rx));
    const y0 = Math.max(0, Math.round(ry));
    const x1 = Math.min(source.width, Math.round(rx + rw));
    const y1 = Math.min(source.height, Math.round(ry + rh));

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * source.width + x) * 4;
        redactedData[idx] = 0;       // R
        redactedData[idx + 1] = 0;   // G
        redactedData[idx + 2] = 0;   // B
        redactedData[idx + 3] = 255; // A
      }
    }
  }

  const redacted = new ImageData(redactedData, source.width, source.height);

  if (regions.length > 0) {
    console.log('[VisualRedactor] Redacted', regions.length, 'regions:', regions.map(r => r.tokenId));
  }

  return { redacted, result };
}

/**
 * Build RedactionRegion list from perception results + privacy classification.
 * Maps visual detections to redaction regions with appropriate token IDs.
 */
export function buildRedactionRegions(
  faceDetections: Array<{ bbox: [number, number, number, number]; confidence: number }>,
  piiTextRegions: Array<{
    bbox: [number, number, number, number];
    category: string;
    tokenId: string;
  }>,
  qrRegions?: Array<{ bbox: [number, number, number, number] }>,
): RedactionRegion[] {
  const regions: RedactionRegion[] = [];
  let faceIdx = 1;
  let piiIdx = 1;
  let qrIdx = 1;

  for (const face of faceDetections) {
    regions.push({
      bbox: face.bbox,
      tokenId: `FACE_${String(faceIdx++).padStart(2, '0')}`,
      category: 'biometric',
    });
  }

  for (const pii of piiTextRegions) {
    regions.push({
      bbox: pii.bbox,
      tokenId: pii.tokenId || `PII_${String(piiIdx++).padStart(2, '0')}`,
      category: pii.category as RedactionRegion['category'] || 'text-pii',
    });
  }

  if (qrRegions) {
    for (const qr of qrRegions) {
      regions.push({
        bbox: qr.bbox,
        tokenId: `QR_${String(qrIdx++).padStart(2, '0')}`,
        category: 'credential',
      });
    }
  }

  return regions;
}

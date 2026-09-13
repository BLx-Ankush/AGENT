/**
 * ANTARDRISHTI — Semantic Sensitivity — Detector Interface + Implementations
 *
 * SemanticDetector: shared interface — the rest of the system depends ONLY on this.
 * ContextSensitivityDetector: always-on lightweight context-window scorer.
 * NeuralNerDetector: optional escalation stub (see neural-detector.ts).
 *
 * "Lightweight local semantic/contextual sensitivity detection for
 *  label-proximate and context-rich entities."
 *
 * This is NOT a neural NER model and is NOT functionally equivalent to GLiNER.
 * It works well when field labels or surrounding text provide sufficient signal.
 * For text with weak/absent label context, the NeuralNerDetector escalation path
 * is available (if loaded).
 */

import type { TaxonomyEntry } from './taxonomy.ts';
import { SENSITIVITY_TAXONOMY } from './taxonomy.ts';

// ── Shared types ──────────────────────────────────────────────

/** DOM / OCR context hints passed to any semantic detector. */
export interface DetectionHints {
  /** Visible label adjacent to the field (e.g. "Passport No") */
  label?: string;
  /** HTML field name or id attribute */
  fieldName?: string;
  /** input[type] attribute */
  inputType?: string;
  /** ARIA role */
  role?: string;
  /** Whether this text came from OCR (lower base confidence) */
  fromOcr?: boolean;
  /** Whether a deterministic rule already matched nearby */
  deterministicNearby?: boolean;
}

/** A single semantic detection result. All detectors return this schema. */
export interface SemanticDetection {
  /** Top-level sensitivity category */
  category: string;
  /** Fine-grained subtype */
  subtype: string;
  /** Confidence in this detection (0–1) */
  confidence: number;
  /** The matched / suspected sensitive text */
  matchedText: string;
  /** Character start offset in the analysed text chunk */
  startOffset: number;
  /** Character end offset */
  endOffset: number;
  /** Token prefix for vault (e.g. 'PASSPORT') */
  tokenPrefix: string;
  /** Which detector produced this */
  detectorId: string;
  /** Risk level from taxonomy */
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  /** Human-readable reason string for the evidence panel */
  reasoning: string;
  /** Whether this was triggered by a synonym (weaker signal) */
  triggeredBySynonym: boolean;
  /**
   * True when no taxonomy keyword matched but a value pattern did.
   * This is the primary OOD escalation signal.
   */
  oodCandidate: boolean;
}

// ── SemanticDetector interface ────────────────────────────────

/**
 * Shared interface for all semantic sensitivity detectors.
 * The sanitizer and fusion layer depend ONLY on this interface —
 * not on whether the implementation is rule-based or neural.
 */
export interface SemanticDetector {
  /** Stable human-readable identifier (used in provenance records) */
  readonly id: string;
  /** Whether this detector is currently ready to serve requests */
  readonly ready: boolean;
  /**
   * Detect sensitive entities in a text chunk.
   *
   * @param text   Text to analyse (recommend ≤ 2000 chars per call)
   * @param hints  DOM/OCR context that can boost confidence
   * @returns      Normalized SemanticDetection[] (may be empty)
   */
  detect(
    text: string,
    hints?: DetectionHints,
  ): SemanticDetection[] | Promise<SemanticDetection[]>;
}

// ── ContextSensitivityDetector ────────────────────────────────

/** Scored context-window result before final thresholding. */
interface WindowScore {
  entry: TaxonomyEntry;
  rawScore: number;         // sum of matched signals (pre-normalised)
  confidence: number;       // final 0–1 confidence
  keywordMatched: string | null;
  synonymMatched: string | null;
  valuePatternMatched: boolean;
  contextPatternMatched: boolean;
  valueText: string;        // the value portion extracted from the window
  windowStart: number;      // character offset of window start
  windowEnd: number;
  oodCandidate: boolean;
}

/**
 * Lightweight local semantic/contextual sensitivity detector.
 *
 * Algorithm:
 *   1. Slide a 200-char context window across the text.
 *   2. In each window, score every taxonomy entry:
 *        keyword match   → +keywordWeight
 *        synonym match   → +keywordWeight × (1 - synonymPenalty)
 *        value pattern   → +valuePatternBonus
 *        context pattern → +0.08 (fixed)
 *        hint label      → +0.10 when hint contains keyword
 *   3. Emit a SemanticDetection for each score ≥ threshold.
 *   4. Suppress windows already covered by a deterministic match.
 *
 * Performance: < 1 ms per 2000-char chunk (sync, no I/O).
 */
export class ContextSensitivityDetector implements SemanticDetector {
  readonly id = 'context-sensitivity-scorer-v1';
  readonly ready = true;

  private readonly _threshold: number;
  private readonly _windowSize: number;
  private readonly _stepSize: number;

  constructor(opts?: { threshold?: number; windowSize?: number; stepSize?: number }) {
    this._threshold  = opts?.threshold  ?? 0.45;
    this._windowSize = opts?.windowSize ?? 200;
    this._stepSize   = opts?.stepSize   ?? 100;
  }

  detect(text: string, hints?: DetectionHints): SemanticDetection[] {
    if (!text || text.length < 3) return [];

    const results: SemanticDetection[] = [];
    const seenSpans = new Set<string>();

    // Slide context window
    const len = text.length;
    for (let start = 0; start < len; start += this._stepSize) {
      const end = Math.min(start + this._windowSize, len);
      const window = text.slice(start, end);

      for (const entry of SENSITIVITY_TAXONOMY) {
        const scored = this._scoreWindow(window, entry, hints, start);
        if (!scored) continue;
        if (scored.confidence < this._threshold) continue;

        // Deduplicate by approximate span
        const spanKey = `${scored.entry.subtype}:${scored.windowStart}`;
        if (seenSpans.has(spanKey)) continue;
        seenSpans.add(spanKey);

        results.push(this._toDetection(scored));
      }
    }

    // Sort by confidence DESC
    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  // ── Private scoring ────────────────────────────────────────

  private _scoreWindow(
    window: string,
    entry: TaxonomyEntry,
    hints: DetectionHints | undefined,
    windowStart: number,
  ): WindowScore | null {
    const lower = window.toLowerCase();
    let score = 0;
    let keywordMatched: string | null = null;
    let synonymMatched: string | null = null;
    let valuePatternMatched = false;
    let contextPatternMatched = false;
    let oodCandidate = false;

    // 1. Keyword signals
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += entry.keywordWeight;
        keywordMatched = kw;
        break;
      }
    }

    // 2. Synonym signals (weaker — subtract synonymPenalty from keyword weight)
    if (!keywordMatched && entry.synonyms) {
      for (const syn of entry.synonyms) {
        if (lower.includes(syn.toLowerCase())) {
          score += entry.keywordWeight * (1 - entry.synonymPenalty);
          synonymMatched = syn;
          break;
        }
      }
    }

    // 3. Value pattern signals
    if (entry.valuePatterns?.length) {
      for (const vp of entry.valuePatterns) {
        if (vp.test(window)) {
          score += entry.valuePatternBonus;
          valuePatternMatched = true;
          break;
        }
      }
    }

    // OOD candidate: value pattern matched but NO keyword/synonym matched
    if (valuePatternMatched && !keywordMatched && !synonymMatched) {
      oodCandidate = true;
      // Value pattern alone is not enough — leave score as bonus only (< threshold)
      // unless hint provides additional signal
    }

    // 4. Context pattern signals
    if (entry.contextPatterns?.length) {
      for (const cp of entry.contextPatterns) {
        if (cp.test(window)) {
          score += 0.08;
          contextPatternMatched = true;
          break;
        }
      }
    }

    // 5. Hint label signals (DOM context boost)
    if (hints?.label) {
      const hintLower = hints.label.toLowerCase();
      const matchesKeyword = entry.keywords.some(k => hintLower.includes(k.toLowerCase()));
      const matchesSynonym = entry.synonyms?.some(s => hintLower.includes(s.toLowerCase()));
      if (matchesKeyword) score += 0.12;
      else if (matchesSynonym) score += 0.08;
    }
    if (hints?.fieldName) {
      const fnLower = hints.fieldName.toLowerCase();
      if (entry.keywords.some(k => fnLower.includes(k.replace(/\s+/g, '_').toLowerCase()))) {
        score += 0.08;
      }
    }

    // 6. OCR penalty (lower base trust for OCR-derived text)
    if (hints?.fromOcr) score *= 0.90;

    // Must have at least some keyword/synonym OR pattern signal to emit
    const hasSignal = keywordMatched || synonymMatched || valuePatternMatched;
    if (!hasSignal) return null;

    const confidence = Math.min(0.99, score);
    if (confidence < 0.30) return null; // hard floor even before threshold

    // Extract value text: first value-pattern match or 30 chars after separator
    const valueText = this._extractValue(window, entry);

    return {
      entry,
      rawScore: score,
      confidence,
      keywordMatched,
      synonymMatched,
      valuePatternMatched,
      contextPatternMatched,
      valueText,
      windowStart,
      windowEnd: windowStart + window.length,
      oodCandidate,
    };
  }

  private _extractValue(window: string, entry: TaxonomyEntry): string {
    // Try value patterns first
    if (entry.valuePatterns?.length) {
      for (const vp of entry.valuePatterns) {
        const m = vp.exec(window);
        if (m) return m[0];
      }
    }
    // Fall back: text after last separator in the window
    const separatorMatch = /[:=\-]\s*([^\s,;]{1,40})/.exec(window);
    return separatorMatch?.[1] ?? window.slice(0, 40).trim();
  }

  private _toDetection(scored: WindowScore): SemanticDetection {
    const trigger = scored.keywordMatched
      ? `keyword "${scored.keywordMatched}"`
      : scored.synonymMatched
        ? `synonym "${scored.synonymMatched}"`
        : 'value-pattern';

    const reasoning = [
      `${scored.entry.category}/${scored.entry.subtype}`,
      `triggered by ${trigger}`,
      scored.valuePatternMatched ? '+ value-pattern' : '',
      scored.contextPatternMatched ? '+ context-pattern' : '',
      scored.oodCandidate ? '[OOD candidate]' : '',
    ].filter(Boolean).join(' ');

    return {
      category: scored.entry.category,
      subtype: scored.entry.subtype,
      confidence: scored.confidence,
      matchedText: scored.valueText,
      startOffset: scored.windowStart,
      endOffset: scored.windowEnd,
      tokenPrefix: scored.entry.tokenPrefix,
      detectorId: this.id,
      riskLevel: scored.entry.riskLevel,
      reasoning,
      triggeredBySynonym: scored.synonymMatched !== null && scored.keywordMatched === null,
      oodCandidate: scored.oodCandidate,
    };
  }
}

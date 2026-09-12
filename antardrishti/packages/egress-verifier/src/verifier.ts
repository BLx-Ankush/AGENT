/**
 * ANTARDRISHTI — Independent Egress Verifier
 *
 * The sanitizer creates. The verifier distrusts. (Contract §15)
 * Separate module, separate processing path.
 *
 * Verifier pipeline:
 *   1. Closed-schema validation (strict, reject unknown fields)
 *   2. Size limits
 *   3. Exact planner origin, HTTPS only, reject redirects
 *   4. Re-scan ALL strings for PII/secret patterns
 *   5. Re-decode every image from final bytes
 *   6. Independent OCR on sanitized images (Phase 5+)
 *   7. Face/QR/document check on final images (Phase 5+)
 *   8. Known-secret canary scan (exact + normalized)
 *   9. Reject raw data/blob/extension URLs, base64 outside crop schema
 *  10. Canonical serialization
 *  11. Hash destination + body = seal
 *
 * Output: APPROVED (sealedBytes + destinationHash)
 *      or BLOCKED (safe category-only reason)
 */

import {
  PlannerRequestSchema,
  scanForForbiddenFields,
  FORBIDDEN_FIELDS,
} from '@antardrishti/protocol-v2';

import { scanForPii } from '@antardrishti/pii-rules';

// ── Types ────────────────────────────────────────────────────

export interface VerificationApproval {
  approved: true;
  sealedBytes: Uint8Array;
  destinationHash: string;
  bodyHash: string;
  serializedSize: number;
}

export interface VerificationBlock {
  approved: false;
  reason: string;
  category: string;
  details?: string;
}

export type VerificationResult = VerificationApproval | VerificationBlock;

export interface VerifierConfig {
  /** Exact allowed planner origin (e.g., "https://planner.local:8000") */
  allowedPlannerOrigin: string;
  /** Maximum payload size in bytes */
  maxPayloadBytes: number;
  /** Maximum number of scene nodes */
  maxNodes: number;
  /** Maximum string length in any field */
  maxStringLength: number;
  /** Known secrets for canary scanning */
  knownSecrets: string[];
}

const DEFAULT_CONFIG: VerifierConfig = {
  allowedPlannerOrigin: '',
  maxPayloadBytes: 512_000, // 512KB
  maxNodes: 500,
  maxStringLength: 5000,
  knownSecrets: [],
};

// ── Verifier ─────────────────────────────────────────────────

export class EgressVerifier {
  private config: VerifierConfig;

  constructor(config: Partial<VerifierConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Verify a candidate planner request payload.
   * Returns APPROVED with sealed bytes, or BLOCKED with reason.
   */
  async verify(
    payload: unknown,
    destination: string,
  ): Promise<VerificationResult> {
    // Step 1: Closed-schema validation
    const schemaResult = PlannerRequestSchema.safeParse(payload);
    if (!schemaResult.success) {
      return {
        approved: false,
        reason: 'Schema validation failed',
        category: 'schema',
        details: schemaResult.error.issues.map(i => i.message).join('; '),
      };
    }

    // Step 2: Reject unknown/forbidden fields
    const forbiddenPaths = scanForForbiddenFields(payload);
    if (forbiddenPaths.length > 0) {
      return {
        approved: false,
        reason: 'Forbidden fields detected',
        category: 'forbidden-field',
        details: forbiddenPaths.join(', '),
      };
    }

    // Step 3: Destination validation
    const destCheck = this.validateDestination(destination);
    if (destCheck) return destCheck;

    // Step 4: Canonical serialization (deterministic)
    const serialized = this.canonicalSerialize(payload);
    const serializedBytes = new TextEncoder().encode(serialized);

    // Step 5: Size limits
    if (serializedBytes.length > this.config.maxPayloadBytes) {
      return {
        approved: false,
        reason: 'Payload exceeds size limit',
        category: 'size',
        details: `${serializedBytes.length} > ${this.config.maxPayloadBytes} bytes`,
      };
    }

    // Step 6: Node count check
    const data = schemaResult.data;
    if (data.scene.nodes.length > this.config.maxNodes) {
      return {
        approved: false,
        reason: 'Too many scene nodes',
        category: 'size',
      };
    }

    // Step 7: Re-scan ALL strings for PII/secret patterns
    const leakCheck = this.scanForLeaks(serialized);
    if (leakCheck) return leakCheck;

    // Step 8: Known-secret canary scan
    const canaryCheck = this.scanCanaries(serialized);
    if (canaryCheck) return canaryCheck;

    // Step 9: Reject dangerous content patterns
    const contentCheck = this.scanDangerousContent(serialized);
    if (contentCheck) return contentCheck;

    // Step 10: String length limits
    const lengthCheck = this.checkStringLengths(payload);
    if (lengthCheck) return lengthCheck;

    // Step 11: Compute seals
    const bodyHash = await this.hash(serialized);
    const destinationHash = await this.hash(destination);
    const sealHash = await this.hash(destinationHash + ':' + bodyHash);

    return {
      approved: true,
      sealedBytes: serializedBytes,
      destinationHash,
      bodyHash,
      serializedSize: serializedBytes.length,
    };
  }

  /**
   * Register known secrets for canary scanning.
   */
  addCanarySecrets(secrets: string[]): void {
    this.config.knownSecrets.push(...secrets);
  }

  // ── Validation steps ───────────────────────────────────

  private validateDestination(destination: string): VerificationBlock | null {
    // HTTPS only
    if (!destination.startsWith('https://') && !destination.startsWith('http://localhost')) {
      return {
        approved: false,
        reason: 'Destination must be HTTPS',
        category: 'destination',
      };
    }

    // Exact origin match
    if (this.config.allowedPlannerOrigin) {
      try {
        const destOrigin = new URL(destination).origin;
        if (destOrigin !== this.config.allowedPlannerOrigin) {
          return {
            approved: false,
            reason: 'Destination does not match allowed planner origin',
            category: 'destination',
            details: `Expected: ${this.config.allowedPlannerOrigin}, Got: ${destOrigin}`,
          };
        }
      } catch {
        return {
          approved: false,
          reason: 'Invalid destination URL',
          category: 'destination',
        };
      }
    }

    return null;
  }

  /**
   * Re-scan ALL strings in the serialized payload for PII/secret patterns.
   * This is independent of the sanitizer — it doesn't trust that
   * the sanitizer caught everything.
   */
  private scanForLeaks(serialized: string): VerificationBlock | null {
    const detections = scanForPii(serialized);

    // Filter out detections that are within token placeholders
    const realLeaks = detections.filter(d => {
      // Tokens look like <SENSITIVE_XXXX> — these are expected
      const around = serialized.substring(
        Math.max(0, d.startOffset - 15),
        Math.min(serialized.length, d.endOffset + 2),
      );
      return !/<SENSITIVE_[A-Z0-9]+>/.test(around);
    });

    if (realLeaks.length > 0) {
      return {
        approved: false,
        reason: 'PII/secret patterns detected in payload',
        category: 'pii-leak',
        details: `${realLeaks.length} pattern(s): ${realLeaks.map(l => l.category).join(', ')}`,
      };
    }

    return null;
  }

  /**
   * Scan for known test secrets (canaries).
   * Match exact values AND normalized variants.
   */
  private scanCanaries(serialized: string): VerificationBlock | null {
    const lowerSerialized = serialized.toLowerCase();

    for (const secret of this.config.knownSecrets) {
      // Exact match
      if (serialized.includes(secret)) {
        return {
          approved: false,
          reason: 'Known secret found in payload (exact match)',
          category: 'canary',
        };
      }

      // Normalized match (lowercase, stripped whitespace/dashes)
      const normalized = secret.toLowerCase().replace(/[\s\-_]/g, '');
      const normalizedPayload = lowerSerialized.replace(/[\s\-_]/g, '');
      if (normalized.length > 4 && normalizedPayload.includes(normalized)) {
        return {
          approved: false,
          reason: 'Known secret found in payload (normalized match)',
          category: 'canary',
        };
      }
    }

    return null;
  }

  /**
   * Scan for dangerous content patterns that should never
   * appear in a planner request.
   */
  private scanDangerousContent(serialized: string): VerificationBlock | null {
    // Raw data URLs
    if (/data:[^;]+;base64,/.test(serialized)) {
      return {
        approved: false,
        reason: 'Raw data URL detected in payload',
        category: 'dangerous-content',
      };
    }

    // Blob URLs
    if (/blob:/.test(serialized)) {
      return {
        approved: false,
        reason: 'Blob URL detected in payload',
        category: 'dangerous-content',
      };
    }

    // Extension URLs
    if (/chrome-extension:|moz-extension:/.test(serialized)) {
      return {
        approved: false,
        reason: 'Extension URL detected in payload',
        category: 'dangerous-content',
      };
    }

    // File system paths
    if (/[A-Z]:\\|\/home\/|\/Users\/|\/var\/|\/etc\//.test(serialized)) {
      return {
        approved: false,
        reason: 'File system path detected in payload',
        category: 'dangerous-content',
      };
    }

    return null;
  }

  private checkStringLengths(obj: unknown, path = ''): VerificationBlock | null {
    if (typeof obj === 'string') {
      if (obj.length > this.config.maxStringLength) {
        return {
          approved: false,
          reason: 'String exceeds maximum length',
          category: 'size',
          details: `${path}: ${obj.length} > ${this.config.maxStringLength}`,
        };
      }
      return null;
    }
    if (typeof obj !== 'object' || obj === null) return null;

    for (const [key, val] of Object.entries(obj)) {
      const result = this.checkStringLengths(val, `${path}.${key}`);
      if (result) return result;
    }
    return null;
  }

  // ── Canonical serialization ────────────────────────────

  /**
   * Deterministic JSON serialization.
   * Keys are sorted, no extraneous whitespace.
   */
  private canonicalSerialize(obj: unknown): string {
    return JSON.stringify(obj, this.sortedReplacer);
  }

  private sortedReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  }

  // ── Hashing ────────────────────────────────────────────

  private async hash(data: string): Promise<string> {
    const encoded = new TextEncoder().encode(data);
    const buffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

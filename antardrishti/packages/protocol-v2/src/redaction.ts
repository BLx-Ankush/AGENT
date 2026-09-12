/**
 * ANTARDRISHTI Protocol v2 — Redaction Types
 *
 * Every planner request MUST contain redactions[].
 * When visual masking is present, also protectedVisualRegions[].
 *
 * NEVER include: value, raw, original, ocrText, selector, query,
 * vaultRef, hidden DOM, raw image.
 */

// ── Branded types ────────────────────────────────────────────

/** Safe text that has passed the privacy sanitizer. */
export type BrandedSafeText = string & { readonly __brand: 'SafeText' };

/** Opaque token referencing a protected value in the local vault. */
export type OpaqueToken = string & { readonly __brand: 'OpaqueToken' };

/** Server-visible value representation. Never contains raw values. */
export type ServerValue =
  | { kind: 'token'; token: OpaqueToken; shape?: BrandedSafeText }
  | { kind: 'label'; label: BrandedSafeText }
  | { kind: 'literal'; value: BrandedSafeText };

// ── Enumerations ─────────────────────────────────────────────

export const REDACTION_CATEGORIES = [
  'contact', 'payment', 'credential', 'biometric',
  'identity-document', 'health', 'secret', 'financial', 'unknown',
] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

export const REDACTION_SHAPES = [
  'email', 'phone', 'card', 'numeric-code', 'name',
  'address', 'image', 'text', 'unknown',
] as const;
export type RedactionShape = (typeof REDACTION_SHAPES)[number];

export const REDACTION_REPRESENTATIONS = [
  'placeholder', 'masked', 'omitted', 'abstracted',
] as const;
export type RedactionRepresentation = (typeof REDACTION_REPRESENTATIONS)[number];

export const DISCLOSURE_LEVELS = [
  'shape-only', 'category-only', 'action-required', 'none',
] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

export const REASON_CODES = [
  'required-for-planning', 'required-for-local-action',
  'not-required', 'ambiguous',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

// ── Redaction declaration ────────────────────────────────────

/**
 * Declares what was redacted and why, using safe metadata only.
 *
 * Schema MUST reject: value, raw, original, ocrText, selector,
 * query, vaultRef, hidden DOM, raw image, arbitrary extension fields.
 */
export interface RedactionDeclaration {
  /** Opaque token — never the original value */
  token: string;
  /** Safe semantic category */
  category: RedactionCategory;
  /** Safe format descriptor */
  shape: RedactionShape;
  /** Reference to a sanitized scene node, NOT a raw DOM selector */
  region: string;
  /** Visual region ID (required for visual masks) */
  visualRegionId?: string;
  /** How the value is represented */
  representation: RedactionRepresentation;
  /** What the planner learns about this value */
  disclosure: DisclosureLevel;
  /** Why this redaction exists */
  reasonCode: ReasonCode;
}

/** Protected visual region in the outbound image. */
export interface ProtectedVisualRegion {
  visualRegionId: string;
  category: RedactionCategory;
  representation: 'masked' | 'omitted';
  bbox: { x: number; y: number; width: number; height: number };
}

// ── Forbidden field list ─────────────────────────────────────

/** Fields that MUST NEVER appear in any planner-bound payload. */
export const FORBIDDEN_FIELDS = [
  'value', 'raw', 'original', 'ocrText', 'selector',
  'query', 'vaultRef', 'hiddenDom', 'rawImage',
  'password', 'secret', 'privateKey', 'cvv',
] as const;

/** Generate an opaque token. Token ID does not encode the value. */
export function generateOpaqueToken(): OpaqueToken {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map(b => b.toString(36).toUpperCase().padStart(2, '0'))
    .join('')
    .substring(0, 4);
  return `<SENSITIVE_${suffix}>` as OpaqueToken;
}

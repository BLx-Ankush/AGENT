/**
 * ANTARDRISHTI — Semantic Sensitivity — Taxonomy
 *
 * Maps sensitivity categories to keyword signals, value patterns, and
 * redaction metadata. Extensible: adding a new entry does not require
 * changes to the detector or fusion logic.
 *
 * This taxonomy drives the ContextSensitivityDetector. It is also
 * available to NeuralNerDetector as a label registry for entity types.
 */

import type { RedactionCategory } from '@antardrishti/protocol-v2';

// ── Taxonomy entry ────────────────────────────────────────────

export interface TaxonomyEntry {
  /** Top-level sensitivity category */
  category: string;
  /** Fine-grained subtype */
  subtype: string;
  /**
   * Keyword signals: strings found near the value that raise suspicion.
   * Case-insensitive partial matches. Ordered by signal strength.
   */
  keywords: string[];
  /**
   * Synonym/paraphrase signals: alternate phrasings for the same concept.
   * Used by the OOD/variation trigger to catch phrasing not in `keywords`.
   */
  synonyms?: string[];
  /**
   * Optional regex patterns that the VALUE itself should match.
   * When a keyword matches AND a value pattern also matches, confidence is higher.
   * When only a keyword matches (no value pattern), confidence is lower.
   */
  valuePatterns?: RegExp[];
  /**
   * Context patterns: regex applied to the surrounding window (not just the value).
   * A match boosts confidence independent of keywords.
   */
  contextPatterns?: RegExp[];
  /** Base confidence weight when primary keyword matches (0–1) */
  keywordWeight: number;
  /** Additional confidence when value pattern also matches */
  valuePatternBonus: number;
  /** Additional confidence when synonym (not keyword) matches */
  synonymPenalty: number;
  /** Maps to protocol-v2 RedactionCategory for token generation */
  redactionCategory: RedactionCategory;
  /**
   * Token name prefix used in vault: e.g. "PASSPORT" → <PASSPORT_01>
   * Must be UPPER_SNAKE_CASE, ASCII only.
   */
  tokenPrefix: string;
  /**
   * Privacy risk level. Drives fail-closed policy and escalation decisions.
   * 'critical' = credentials/biometric/health
   * 'high'     = financial/identity documents
   * 'medium'   = contact/location
   * 'low'      = generic personal info
   */
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
}

// ── Taxonomy registry ─────────────────────────────────────────

export const SENSITIVITY_TAXONOMY: TaxonomyEntry[] = [

  // ── IDENTITY ──────────────────────────────────────────────

  {
    category: 'identity_document',
    subtype: 'passport',
    keywords: ['passport', 'passport no', 'passport number', 'passport no.'],
    synonyms: ['travel document', 'travel doc', 'travel id', 'travel reference'],
    valuePatterns: [
      /\b[A-Z][0-9]{7}\b/,           // Indian passport: A1234567
      /\b[A-Z]{2}[0-9]{7}\b/,        // Some EU formats
      /\b[A-Z][0-9]{6,8}\b/,         // General passport pattern
    ],
    keywordWeight: 0.82,
    valuePatternBonus: 0.12,
    synonymPenalty: 0.15,
    redactionCategory: 'identity-document',
    tokenPrefix: 'PASSPORT',
    riskLevel: 'high',
  },

  {
    category: 'identity_document',
    subtype: 'government_id',
    keywords: [
      'voter id', 'voter card', 'election card', 'national id',
      'government id', 'govt id', 'national identity', 'epic no',
    ],
    synonyms: ['civic id', 'citizen id', 'state id', 'official id'],
    valuePatterns: [
      /\b[A-Z]{3}[0-9]{7}\b/,        // Indian Voter ID: XYZ1234567
      /\b[A-Z0-9]{6,12}\b/,
    ],
    keywordWeight: 0.78,
    valuePatternBonus: 0.10,
    synonymPenalty: 0.15,
    redactionCategory: 'identity-document',
    tokenPrefix: 'GOVERNMENT_ID',
    riskLevel: 'high',
  },

  {
    category: 'identity_document',
    subtype: 'employee_id',
    keywords: [
      'employee id', 'employee number', 'emp id', 'emp no',
      'staff id', 'staff number', 'personnel id', 'worker id',
    ],
    synonyms: [
      'staff identifier', 'personnel reference', 'workforce id',
      'associate id', 'colleague id',
    ],
    valuePatterns: [
      /\bEMP-\d{4,8}\b/i,
      /\bSTF-\d{4,8}\b/i,
      /\b[A-Z]{2,4}-\d{4,8}\b/,     // Generic: EMP-12345, HR-9021
    ],
    keywordWeight: 0.76,
    valuePatternBonus: 0.12,
    synonymPenalty: 0.18,
    redactionCategory: 'identity-document',
    tokenPrefix: 'EMPLOYEE_ID',
    riskLevel: 'high',
  },

  {
    category: 'identity_document',
    subtype: 'drivers_license',
    keywords: [
      "driver's license", 'driving licence', 'driving license',
      'dl number', 'dl no', 'licence number',
    ],
    synonyms: ['motor vehicle id', 'driving id'],
    valuePatterns: [/\b[A-Z]{2}[0-9]{2}[0-9]{11}\b/],
    keywordWeight: 0.80,
    valuePatternBonus: 0.10,
    synonymPenalty: 0.15,
    redactionCategory: 'identity-document',
    tokenPrefix: 'DRIVERS_LICENSE',
    riskLevel: 'high',
  },

  // ── FINANCIAL ─────────────────────────────────────────────

  {
    category: 'financial',
    subtype: 'salary',
    keywords: [
      'annual salary', 'monthly salary', 'yearly salary',
      'salary', 'ctc', 'cost to company', 'compensation',
      'gross salary', 'net salary', 'take-home',
      'wage', 'wages', 'income', 'earnings', 'remuneration',
    ],
    synonyms: [
      'yearly pay', 'monthly pay', 'annual pay', 'annual package',
      'total package', 'pay package', 'compensation package',
    ],
    valuePatterns: [
      /₹[\d,]+(?:\.\d{2})?/,          // ₹12,50,000
      /INR\s?[\d,]+/i,
      /\$[\d,]+(?:\.\d{2})?/,
      /[\d,]+\s*(?:per\s+(?:annum|month|year))/i,
      /\d{1,3}(?:,\d{2,3})+/,          // Indian numbering: 12,50,000
    ],
    keywordWeight: 0.80,
    valuePatternBonus: 0.14,
    synonymPenalty: 0.12,
    redactionCategory: 'financial',
    tokenPrefix: 'SALARY',
    riskLevel: 'high',
  },

  {
    category: 'financial',
    subtype: 'transaction',
    keywords: [
      'transaction id', 'transaction ref', 'txn id', 'txn no',
      'reference number', 'transfer ref', 'utr', 'utr number',
    ],
    synonyms: ['payment reference', 'fund transfer id', 'wire ref'],
    valuePatterns: [/\b[A-Z0-9]{10,22}\b/],
    keywordWeight: 0.72,
    valuePatternBonus: 0.10,
    synonymPenalty: 0.15,
    redactionCategory: 'financial',
    tokenPrefix: 'TRANSACTION_ID',
    riskLevel: 'high',
  },

  // ── AUTHENTICATION ────────────────────────────────────────

  {
    category: 'authentication',
    subtype: 'security_answer',
    keywords: [
      "mother's maiden name", "mother's name", 'maiden name',
      'security answer', 'secret answer', 'security question answer',
      "father's name", 'childhood nickname', 'first pet name',
      'first school', 'favourite teacher',
    ],
    synonyms: ['secret response', 'account recovery answer', 'identity question'],
    valuePatterns: [],   // Any word/phrase is valid — keyword alone is enough
    keywordWeight: 0.82,
    valuePatternBonus: 0.0,
    synonymPenalty: 0.10,
    redactionCategory: 'credential',
    tokenPrefix: 'SECURITY_ANSWER',
    riskLevel: 'critical',
  },

  {
    category: 'authentication',
    subtype: 'mfa_code',
    keywords: ['authenticator code', 'totp', 'google authenticator', '2fa code', 'mfa code'],
    synonyms: ['two-factor code', 'auth code', 'second factor'],
    valuePatterns: [/\b\d{6,8}\b/],
    keywordWeight: 0.78,
    valuePatternBonus: 0.10,
    synonymPenalty: 0.12,
    redactionCategory: 'credential',
    tokenPrefix: 'MFA_CODE',
    riskLevel: 'critical',
  },

  // ── HEALTH ────────────────────────────────────────────────

  {
    category: 'health',
    subtype: 'medical_record',
    keywords: [
      'medical record', 'medical record number', 'mrn',
      'patient id', 'patient number', 'patient record',
      'health record', 'health id', 'health identifier',
      'medical file', 'clinical record',
    ],
    synonyms: [
      'clinical identifier', 'patient reference', 'clinical ref',
      'patient file', 'healthcare id', 'hospital id',
      'patient record reference',
    ],
    valuePatterns: [
      /\bMRN-?\d{4,10}\b/i,
      /\bPT-\d{4,10}\b/i,
      /\bHID-\d{4,10}\b/i,
    ],
    keywordWeight: 0.84,
    valuePatternBonus: 0.12,
    synonymPenalty: 0.14,
    redactionCategory: 'health',
    tokenPrefix: 'MEDICAL_RECORD',
    riskLevel: 'critical',
  },

  {
    category: 'health',
    subtype: 'diagnosis',
    keywords: [
      'diagnosis', 'diagnosed with', 'medical condition',
      'icd code', 'icd-10', 'disease', 'disorder', 'prescription',
    ],
    synonyms: ['clinical finding', 'health finding', 'condition'],
    valuePatterns: [/\b[A-Z]\d{2}(?:\.\d{1,4})?\b/],  // ICD-10 codes
    keywordWeight: 0.80,
    valuePatternBonus: 0.10,
    synonymPenalty: 0.15,
    redactionCategory: 'health',
    tokenPrefix: 'HEALTH_INFO',
    riskLevel: 'critical',
  },

  // ── PERSONAL ─────────────────────────────────────────────

  {
    category: 'personal',
    subtype: 'date_of_birth',
    keywords: ['date of birth', 'dob', 'birth date', 'born on', 'birthday'],
    synonyms: ['birth anniversary', 'date of birth certificate'],
    valuePatterns: [
      /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/,
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
    ],
    keywordWeight: 0.78,
    valuePatternBonus: 0.12,
    synonymPenalty: 0.15,
    redactionCategory: 'contact',
    tokenPrefix: 'DATE_OF_BIRTH',
    riskLevel: 'medium',
  },

  // ── BIOMETRIC ─────────────────────────────────────────────

  {
    category: 'biometric',
    subtype: 'biometric_reference',
    keywords: [
      'biometric id', 'biometric reference', 'fingerprint id',
      'iris id', 'facial id', 'voice id', 'biometric token',
      'biometric enrolment', 'bio id',
    ],
    synonyms: ['biometric identifier', 'biometric marker', 'bio reference'],
    valuePatterns: [
      /\bBIO-\d{4,10}\b/i,
      /\bFP-\d{4,10}\b/i,
    ],
    keywordWeight: 0.84,
    valuePatternBonus: 0.12,
    synonymPenalty: 0.14,
    redactionCategory: 'biometric',
    tokenPrefix: 'BIOMETRIC_ID',
    riskLevel: 'critical',
  },

  // ── LOCATION ──────────────────────────────────────────────

  {
    category: 'location',
    subtype: 'gps_coordinates',
    keywords: [
      'gps', 'coordinates', 'latitude', 'longitude', 'location',
      'current location', 'precise location', 'geo coordinates',
    ],
    synonyms: ['geo position', 'map location', 'geo-tag'],
    valuePatterns: [
      /\b\d{1,3}\.\d{2,6}[°\s]+[NS],?\s*\d{1,3}\.\d{2,6}[°\s]+[EW]/i,
      /\blat(?:itude)?[:\s]+[-+]?\d{1,3}\.\d{2,6}/i,
    ],
    keywordWeight: 0.78,
    valuePatternBonus: 0.14,
    synonymPenalty: 0.15,
    redactionCategory: 'contact',
    tokenPrefix: 'GPS_LOCATION',
    riskLevel: 'medium',
  },

];

// ── Lookup helpers ────────────────────────────────────────────

/** Return all taxonomy entries for a given category. */
export function entriesForCategory(category: string): TaxonomyEntry[] {
  return SENSITIVITY_TAXONOMY.filter(e => e.category === category);
}

/** Return the taxonomy entry for a given subtype. */
export function entryForSubtype(subtype: string): TaxonomyEntry | undefined {
  return SENSITIVITY_TAXONOMY.find(e => e.subtype === subtype);
}

/** All known token prefixes (for egress verifier extension). */
export const ALL_TOKEN_PREFIXES: readonly string[] =
  SENSITIVITY_TAXONOMY.map(e => e.tokenPrefix);

/**
 * ANTARDRISHTI — Deterministic PII / Secret Detection
 *
 * Deterministic recognizers first (contract §11).
 * Checksum-backed: Luhn, Verhoeff, MOD-97
 * Structure/context: email, phone, address, DOB, PAN, IFSC,
 *   OTP, API keys, JWTs, private-key headers, passwords.
 *
 * Never label a pattern match as "verified" unless validated.
 * Carry: checksum-verified, pattern-matched, context-inferred.
 */

// ── Detection result ─────────────────────────────────────────

export interface PiiDetection {
  /** Category of the detected PII */
  category: PiiCategory;
  /** How was this detected */
  validationTier: 'checksum-verified' | 'pattern-matched' | 'context-inferred';
  /** Confidence (0–1) */
  confidence: number;
  /** The matched text */
  matchedText: string;
  /** Start offset in the source text */
  startOffset: number;
  /** End offset in the source text */
  endOffset: number;
  /** Which rule matched */
  rule: string;
}

export type PiiCategory =
  | 'email'
  | 'phone'
  | 'credit-card'
  | 'aadhaar'
  | 'pan'
  | 'ifsc'
  | 'iban'
  | 'address'
  | 'dob'
  | 'otp'
  | 'api-key'
  | 'jwt'
  | 'private-key'
  | 'cloud-credential'
  | 'password'
  | 'account-number'
  | 'ssn'
  | 'unknown-pii';

// ── Main scanner ─────────────────────────────────────────────

/**
 * Scan text for PII/secrets using deterministic rules.
 * Returns all detections ordered by position.
 */
export function scanForPii(text: string): PiiDetection[] {
  if (!text || text.length < 3) return [];

  const detections: PiiDetection[] = [];

  // Run SPECIFIC detectors first, GENERIC (phone) last
  // This ensures overlapping digit sequences are classified correctly
  detections.push(...detectEmails(text));
  detections.push(...detectCreditCards(text));
  detections.push(...detectAadhaar(text));
  detections.push(...detectPAN(text));
  detections.push(...detectIFSC(text));
  detections.push(...detectIBAN(text));
  detections.push(...detectOTP(text));
  detections.push(...detectJWT(text));
  detections.push(...detectPrivateKeys(text));
  detections.push(...detectApiKeys(text));
  detections.push(...detectSSN(text));
  detections.push(...detectPhones(text)); // phones LAST — most generic

  // Deduplicate overlapping detections — prefer higher confidence
  const deduped = deduplicateOverlapping(detections);

  // Sort by position
  deduped.sort((a, b) => a.startOffset - b.startOffset);
  return deduped;
}

// ── Checksum algorithms ──────────────────────────────────────

/** Luhn checksum validation (credit cards, some ID numbers). */
export function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/\D/g, '');
  if (nums.length < 8) return false;

  let sum = 0;
  let alternate = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Verhoeff checksum (used by Aadhaar). */
export function verhoeffCheck(digits: string): boolean {
  const d = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],
    [2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
    [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
    [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
  ];
  const p = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],
    [5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
  ];
  const inv = [0,4,3,2,1,5,6,7,8,9];

  const nums = digits.replace(/\D/g, '');
  if (nums.length !== 12) return false;

  let c = 0;
  const reversed = nums.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = d[c][p[i % 8][parseInt(reversed[i], 10)]];
  }
  return c === 0;
}

/** MOD-97 checksum (IBAN). */
export function mod97Check(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, '').toUpperCase();
  if (cleaned.length < 5) return false;

  // Move first 4 chars to end
  const rearranged = cleaned.substring(4) + cleaned.substring(0, 4);

  // Convert letters to numbers (A=10, B=11, ...)
  let numStr = '';
  for (const c of rearranged) {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      numStr += (code - 55).toString();
    } else {
      numStr += c;
    }
  }

  // Compute mod 97
  let remainder = 0;
  for (const digit of numStr) {
    remainder = (remainder * 10 + parseInt(digit, 10)) % 97;
  }

  return remainder === 1;
}

// ── Pattern detectors ────────────────────────────────────────

function detectEmails(text: string): PiiDetection[] {
  const pattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return matchAll(text, pattern, 'email', 'pattern-matched', 0.95, 'email-pattern');
}

function detectPhones(text: string): PiiDetection[] {
  const patterns = [
    /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g,            // Indian mobile
    /(?:\+1[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/g,  // US/Canada
    /(?:\+\d{1,3}[\s-]?)?\d{4,5}[\s-]?\d{4,6}/g,         // Generic international
  ];
  const results: PiiDetection[] = [];
  for (const p of patterns) {
    results.push(...matchAll(text, p, 'phone', 'pattern-matched', 0.85, 'phone-pattern'));
  }
  return dedup(results);
}

function detectCreditCards(text: string): PiiDetection[] {
  const pattern = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
  const matches = matchAll(text, pattern, 'credit-card', 'pattern-matched', 0.8, 'cc-pattern');

  // Upgrade to checksum-verified if Luhn passes
  for (const m of matches) {
    if (luhnCheck(m.matchedText)) {
      m.validationTier = 'checksum-verified';
      m.confidence = 0.98;
      m.rule = 'cc-luhn-verified';
    }
  }
  return matches;
}

function detectAadhaar(text: string): PiiDetection[] {
  const pattern = /\b\d{4}\s\d{4}\s\d{4}\b/g;
  const matches = matchAll(text, pattern, 'aadhaar', 'pattern-matched', 0.88, 'aadhaar-pattern');

  for (const m of matches) {
    if (verhoeffCheck(m.matchedText)) {
      m.validationTier = 'checksum-verified';
      m.confidence = 0.95;
      m.rule = 'aadhaar-verhoeff-verified';
    }
  }
  return matches;
}

function detectPAN(text: string): PiiDetection[] {
  const pattern = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
  return matchAll(text, pattern, 'pan', 'pattern-matched', 0.9, 'pan-pattern');
}

function detectIFSC(text: string): PiiDetection[] {
  const pattern = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
  return matchAll(text, pattern, 'ifsc', 'pattern-matched', 0.9, 'ifsc-pattern');
}

function detectIBAN(text: string): PiiDetection[] {
  const pattern = /\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
  const matches = matchAll(text, pattern, 'iban', 'pattern-matched', 0.8, 'iban-pattern');

  for (const m of matches) {
    if (mod97Check(m.matchedText)) {
      m.validationTier = 'checksum-verified';
      m.confidence = 0.98;
      m.rule = 'iban-mod97-verified';
    }
  }
  return matches;
}

function detectOTP(text: string): PiiDetection[] {
  // OTP is context-dependent: 4–8 digit code near keywords
  const pattern = /\b(?:otp|code|verify|verification|one.?time)\b[^a-z]*\b(\d{4,8})\b/gi;
  const results: PiiDetection[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      category: 'otp',
      validationTier: 'context-inferred',
      confidence: 0.8,
      matchedText: match[1],
      startOffset: match.index + match[0].indexOf(match[1]),
      endOffset: match.index + match[0].indexOf(match[1]) + match[1].length,
      rule: 'otp-context',
    });
  }
  return results;
}

function detectJWT(text: string): PiiDetection[] {
  const pattern = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
  return matchAll(text, pattern, 'jwt', 'pattern-matched', 0.95, 'jwt-pattern');
}

function detectPrivateKeys(text: string): PiiDetection[] {
  const pattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
  return matchAll(text, pattern, 'private-key', 'pattern-matched', 0.99, 'private-key-header');
}

function detectApiKeys(text: string): PiiDetection[] {
  const patterns = [
    /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[=:]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,                        // Google API key
    /\bsk-[a-zA-Z0-9_-]{20,}\b/g,                          // OpenAI-style key
    /\bghp_[a-zA-Z0-9]{36}\b/g,                          // GitHub PAT
    /\bAKIA[0-9A-Z]{16}\b/g,                             // AWS access key
  ];
  const results: PiiDetection[] = [];
  for (const p of patterns) {
    results.push(...matchAll(text, p, 'api-key', 'pattern-matched', 0.9, 'api-key-pattern'));
  }
  return dedup(results);
}

function detectSSN(text: string): PiiDetection[] {
  const pattern = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
  return matchAll(text, pattern, 'ssn', 'pattern-matched', 0.7, 'ssn-pattern');
}

// ── Helpers ──────────────────────────────────────────────────

function matchAll(
  text: string,
  pattern: RegExp,
  category: PiiCategory,
  tier: PiiDetection['validationTier'],
  confidence: number,
  rule: string,
): PiiDetection[] {
  const results: PiiDetection[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      category,
      validationTier: tier,
      confidence,
      matchedText: match[0],
      startOffset: match.index,
      endOffset: match.index + match[0].length,
      rule,
    });
  }
  return results;
}

function dedup(detections: PiiDetection[]): PiiDetection[] {
  const seen = new Set<string>();
  return detections.filter((d) => {
    const key = `${d.startOffset}:${d.endOffset}:${d.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deduplicate overlapping detections.
 * When two detections overlap, keep the one with higher confidence.
 * Earlier detections (more specific categories) win ties.
 */
function deduplicateOverlapping(detections: PiiDetection[]): PiiDetection[] {
  if (detections.length <= 1) return detections;

  // Sort by confidence descending (highest wins), then by specificity
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);

  const result: PiiDetection[] = [];
  const covered = new Set<number>();

  for (const det of sorted) {
    // Check if this detection's midpoint is already covered
    const midpoint = Math.floor((det.startOffset + det.endOffset) / 2);
    if (covered.has(midpoint)) continue;

    result.push(det);

    // Mark range as covered
    for (let i = det.startOffset; i < det.endOffset; i++) {
      covered.add(i);
    }
  }

  return result;
}

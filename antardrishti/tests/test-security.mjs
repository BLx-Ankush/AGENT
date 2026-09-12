/**
 * ANTARDRISHTI — Security Test Suite
 *
 * 26 security test cases from the implementation plan.
 * Validates that the privacy boundary is enforced end-to-end.
 *
 * Run: node --experimental-vm-modules test-security.mjs
 */

import { scanForPii, luhnCheck, verhoeffCheck, mod97Check } from '@antardrishti/pii-rules';
import { TokenVault } from '@antardrishti/privacy';
import { Sanitizer } from '@antardrishti/privacy';
import { evaluatePolicy } from '@antardrishti/privacy';
import { EgressVerifier } from '@antardrishti/egress-verifier';
import { scanForForbiddenFields, FORBIDDEN_FIELDS } from '@antardrishti/protocol-v2';
import { isAllowedActionKind } from '@antardrishti/protocol-v2';

// ── Test framework (minimal) ─────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

// ══════════════════════════════════════════════════════════════
//  SECURITY TEST SUITE
// ══════════════════════════════════════════════════════════════

console.log('\n🔒 ANTARDRISHTI Security Test Suite\n');

// ── 1. PII Detection ────────────────────────────────────────

console.log('\n── PII Detection ──');

test('S01: Detect email addresses', () => {
  const results = scanForPii('Contact: ravi.shankar@example.com');
  assert(results.length > 0, 'Should detect email');
  assertEqual(results[0].category, 'email');
});

test('S02: Detect phone numbers (+91 format)', () => {
  const results = scanForPii('Call me at +91 98765 43210');
  assert(results.length > 0, 'Should detect phone');
  assertEqual(results[0].category, 'phone');
});

test('S03: Detect credit cards with Luhn verification', () => {
  const results = scanForPii('Card: 4111 1111 1111 1111');
  assert(results.length > 0, 'Should detect card');
  assertEqual(results[0].category, 'credit-card');
  assertEqual(results[0].validationTier, 'checksum-verified');
});

test('S04: Luhn correctly validates', () => {
  assert(luhnCheck('4111111111111111'), 'Valid Visa test card');
  assert(!luhnCheck('4111111111111112'), 'Invalid card');
});

test('S05: Detect PAN numbers', () => {
  const results = scanForPii('PAN: ABCDE1234F');
  assert(results.length > 0, 'Should detect PAN');
  assertEqual(results[0].category, 'pan');
});

test('S06: Detect Aadhaar with Verhoeff', () => {
  const results = scanForPii('Aadhaar: 2234 5679 8012');
  assert(results.length > 0, 'Should detect Aadhaar-like pattern');
  assertEqual(results[0].category, 'aadhaar');
});

test('S07: Detect JWT tokens', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const results = scanForPii(`Token: ${jwt}`);
  assert(results.length > 0, 'Should detect JWT');
  assertEqual(results[0].category, 'jwt');
});

test('S08: Detect API keys (OpenAI format)', () => {
  const results = scanForPii('Key: sk-proj-abcdefghijklmnopqrstuvwxyz123456');
  assert(results.length > 0, 'Should detect API key');
});

test('S09: Detect private key headers', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';
  const results = scanForPii(text);
  assert(results.length > 0, 'Should detect private key');
  assertEqual(results[0].category, 'private-key');
});

test('S10: Detect IFSC codes', () => {
  const results = scanForPii('IFSC: SBIN0001234');
  assert(results.length > 0, 'Should detect IFSC');
  assertEqual(results[0].category, 'ifsc');
});

// ── 2. Token Vault ──────────────────────────────────────────

console.log('\n── Token Vault ──');

test('S11: Vault stores and redeems correctly', () => {
  const vault = new TokenVault();
  const { token, grantId } = vault.storeValue(
    'SuperSecret@123', 'credential',
    'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type',
  );
  assert(token.startsWith('<SENSITIVE_'), 'Token should be opaque');
  const result = vault.redeem(
    token, 'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type',
    vault.getGrant(token).actionNonce,
  );
  assert('value' in result, 'Redemption should succeed');
  assertEqual(result.value, 'SuperSecret@123');
});

test('S12: Vault rejects session mismatch', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'secret', 'credential',
    'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type',
  );
  const result = vault.redeem(
    token, 'session-WRONG', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type',
    vault.getGrant(token).actionNonce,
  );
  assert('error' in result, 'Should fail');
  assertEqual(result.error, 'SESSION_MISMATCH');
});

test('S13: Vault rejects origin mismatch', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'secret', 'credential',
    'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type',
  );
  const result = vault.redeem(
    token, 'session-1', 1, 0, 'doc-1', 'https://evil.com', 'node-1', 'type',
    vault.getGrant(token).actionNonce,
  );
  assert('error' in result, 'Should fail');
  assertEqual(result.error, 'ORIGIN_MISMATCH');
});

test('S14: Vault rejects double consumption', () => {
  const vault = new TokenVault();
  const { token } = vault.storeValue(
    'secret', 'credential',
    'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type',
  );
  const nonce = vault.getGrant(token).actionNonce;
  vault.redeem(token, 'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type', nonce);
  const result = vault.redeem(token, 'session-1', 1, 0, 'doc-1', 'https://example.com', 'node-1', 'type', nonce);
  assert('error' in result, 'Should fail');
  assertEqual(result.error, 'GRANT_ALREADY_CONSUMED');
});

test('S15: Session revocation clears all grants', () => {
  const vault = new TokenVault();
  vault.storeValue('a', 'c', 's1', 1, 0, 'd1', 'https://x.com', 'n1', 'type');
  vault.storeValue('b', 'c', 's1', 1, 0, 'd1', 'https://x.com', 'n2', 'type');
  const revoked = vault.revokeSession('s1');
  assertEqual(revoked, 2);
  assertEqual(vault.stats().totalTokens, 0);
});

// ── 3. Policy Engine ────────────────────────────────────────

console.log('\n── Policy Engine ──');

test('S16: Password never sent to planner raw', () => {
  const result = evaluatePolicy({
    sensitivity: { category: 'credential', confidence: 1.0, validationTier: 'context-inferred', evidenceSource: 'input-type-password' },
    taskNecessity: 'required',
    recipient: 'remote-planner',
    origin: 'https://example.com',
    hasUserAuthorization: false,
    ambiguity: 'none',
  });
  assert(result.decision !== 'ALLOW_LITERAL', 'Must not allow literal password to planner');
});

test('S17: Fail-closed on high ambiguity', () => {
  const result = evaluatePolicy({
    sensitivity: { category: 'unknown', confidence: 0.5, validationTier: 'context-inferred', evidenceSource: 'test' },
    taskNecessity: 'unknown',
    recipient: 'remote-planner',
    origin: 'https://example.com',
    hasUserAuthorization: false,
    ambiguity: 'high',
  });
  assertEqual(result.decision, 'OMIT');
});

test('S18: Website requires user authorization', () => {
  const result = evaluatePolicy({
    sensitivity: { category: 'contact', confidence: 0.9, validationTier: 'pattern-matched', evidenceSource: 'test' },
    taskNecessity: 'required',
    recipient: 'task-website',
    origin: 'https://example.com',
    hasUserAuthorization: false,
    ambiguity: 'none',
  });
  assertEqual(result.decision, 'ASK_LOCAL');
  assert(result.requiresUserConfirmation, 'Must require confirmation');
});

// ── 4. Egress Verifier ──────────────────────────────────────

console.log('\n── Egress Verifier ──');

test('S19: Forbidden fields detected', () => {
  const violations = scanForForbiddenFields({
    session: { id: 'test' },
    raw: 'leaked!',
    nested: { ocrText: 'also leaked' },
  });
  assert(violations.length >= 2, 'Should find forbidden fields');
  assert(violations.includes('raw'), 'Should find "raw"');
  assert(violations.includes('nested.ocrText'), 'Should find "nested.ocrText"');
});

test('S20: All forbidden fields are defined', () => {
  const expected = ['value', 'raw', 'original', 'ocrText', 'selector', 'query', 'vaultRef', 'hiddenDom', 'rawImage', 'password', 'secret', 'privateKey', 'cvv'];
  for (const f of expected) {
    assert(FORBIDDEN_FIELDS.includes(f), `Missing forbidden field: ${f}`);
  }
});

test('S21: Egress blocks non-HTTPS destination', async () => {
  const verifier = new EgressVerifier();
  const result = await verifier.verify({}, 'http://planner.example.com/plan');
  assert(!result.approved, 'Should block non-HTTPS');
});

test('S22: Egress blocks data URLs in payload', async () => {
  const verifier = new EgressVerifier({ allowedPlannerOrigin: '' });
  const result = await verifier.verify(
    { someField: 'data:image/png;base64,iVBOR...' },
    'https://planner.example.com/plan',
  );
  // Schema validation will fail first, but the content check also catches it
  assert(!result.approved, 'Should block data URLs');
});

// ── 5. Action Validation ────────────────────────────────────

console.log('\n── Action Validation ──');

test('S23: Only 9 action kinds are allowed', () => {
  const allowed = ['click', 'focus', 'type_text', 'type_token', 'select', 'scroll', 'wait', 'request_observation', 'finish'];
  for (const kind of allowed) {
    assert(isAllowedActionKind(kind), `${kind} should be allowed`);
  }
  assert(!isAllowedActionKind('eval'), 'eval must not be allowed');
  assert(!isAllowedActionKind('execute_js'), 'execute_js must not be allowed');
  assert(!isAllowedActionKind('navigate'), 'navigate must not be allowed');
  assert(!isAllowedActionKind('shell'), 'shell must not be allowed');
});

test('S24: Sanitizer always produces redactions array', () => {
  const vault = new TokenVault();
  const sanitizer = new Sanitizer(vault);
  const result = sanitizer.sanitize(
    'Hello world', [], 'session-1', 1, 0, 'doc-1', 'https://example.com',
  );
  assert(Array.isArray(result.redactions), 'redactions must be an array');
  assert(Array.isArray(result.protectedVisualRegions), 'protectedVisualRegions must be an array');
});

test('S25: Sanitizer tokenizes detected PII', () => {
  const vault = new TokenVault();
  const sanitizer = new Sanitizer(vault);
  const result = sanitizer.sanitize(
    'Send email to ravi.shankar@example.com', [],
    'session-1', 1, 0, 'doc-1', 'https://example.com',
  );
  assert(result.redactions.length > 0, 'Should have redactions');
  assert(!result.sanitizedTask.includes('ravi.shankar@example.com'), 'Email should be tokenized');
  assert(result.sanitizedTask.includes('<SENSITIVE_'), 'Should contain token');
});

test('S26: Sanitizer tokenizes credit cards', () => {
  const vault = new TokenVault();
  const sanitizer = new Sanitizer(vault);
  const result = sanitizer.sanitize(
    'Pay with card 4111 1111 1111 1111', [],
    'session-1', 1, 0, 'doc-1', 'https://example.com',
  );
  assert(!result.sanitizedTask.includes('4111'), 'Card number should be removed');
  assert(result.redactions.length > 0, 'Should have redaction for card');
});

// ══════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`\n🔒 Security Test Results: ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);

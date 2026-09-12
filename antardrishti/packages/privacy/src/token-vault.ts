/**
 * ANTARDRISHTI — Token Vault & Capability Grants
 *
 * Private values remain local (contract §12).
 * Tokens are opaque: <SENSITIVE_XXXX>. Do not encode
 * unnecessary category information in the token.
 *
 * CapabilityGrant binds to: session, tab, frame, origin,
 * document generation, target, operation, action nonce,
 * expiry, maxUses=1.
 */

import { generateOpaqueToken, type OpaqueToken } from '@antardrishti/protocol-v2';

// ── Capability Grant ─────────────────────────────────────────

export interface CapabilityGrant {
  grantId: string;
  sessionId: string;
  tabId: number;
  frameId: number;
  documentGeneration: string;
  targetOrigin: string;
  targetRef: string;
  permittedOperation: string;
  actionNonce: string;
  valueRef: string;         // internal vault reference
  category: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;          // always 1
  consumedAt: string | null;
}

// ── Vault ────────────────────────────────────────────────────

const GRANT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export class TokenVault {
  /** Token → raw value (in-memory only) */
  private values = new Map<string, string>();
  /** Token → grant */
  private grants = new Map<string, CapabilityGrant>();
  /** Category → token list (for enumeration) */
  private byCategory = new Map<string, Set<string>>();

  /**
   * Store a sensitive value and return an opaque token.
   * The raw value stays in this vault only.
   */
  storeValue(
    rawValue: string,
    category: string,
    sessionId: string,
    tabId: number,
    frameId: number,
    documentGeneration: string,
    targetOrigin: string,
    targetRef: string,
    permittedOperation: string,
  ): { token: OpaqueToken; grantId: string } {
    const token = generateOpaqueToken();
    const grantId = `grant-${crypto.randomUUID?.() || Date.now()}`;
    const actionNonce = crypto.randomUUID?.() || `nonce-${Date.now()}`;
    const now = new Date();

    this.values.set(token, rawValue);

    const grant: CapabilityGrant = {
      grantId,
      sessionId,
      tabId,
      frameId,
      documentGeneration,
      targetOrigin,
      targetRef,
      permittedOperation,
      actionNonce,
      valueRef: token,
      category,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + GRANT_EXPIRY_MS).toISOString(),
      maxUses: 1,
      consumedAt: null,
    };

    this.grants.set(token, grant);

    const catSet = this.byCategory.get(category) || new Set();
    catSet.add(token);
    this.byCategory.set(category, catSet);

    return { token, grantId };
  }

  /**
   * Redeem a capability grant.
   * Returns the raw value ONLY if ALL bindings match.
   * Atomically consumes the grant (single-use).
   *
   * Contract §12: redemption steps 1–13.
   */
  redeem(
    token: string,
    sessionId: string,
    tabId: number,
    frameId: number,
    documentGeneration: string,
    targetOrigin: string,
    targetRef: string,
    operation: string,
    actionNonce: string,
  ): { value: string } | { error: string } {
    const grant = this.grants.get(token);
    if (!grant) return { error: 'GRANT_NOT_FOUND' };

    // Step 1: validate session
    if (grant.sessionId !== sessionId) return { error: 'SESSION_MISMATCH' };

    // Step 2: validate tab
    if (grant.tabId !== tabId) return { error: 'TAB_MISMATCH' };

    // Step 3: validate frame
    if (grant.frameId !== frameId) return { error: 'FRAME_MISMATCH' };

    // Step 4: validate origin
    if (grant.targetOrigin !== targetOrigin) return { error: 'ORIGIN_MISMATCH' };

    // Step 5: validate document generation
    if (grant.documentGeneration !== documentGeneration) return { error: 'DOCUMENT_GENERATION_MISMATCH' };

    // Step 6: validate target ref
    if (grant.targetRef !== targetRef) return { error: 'TARGET_MISMATCH' };

    // Step 7: validate operation
    if (grant.permittedOperation !== operation) return { error: 'OPERATION_MISMATCH' };

    // Step 8: validate nonce
    if (grant.actionNonce !== actionNonce) return { error: 'NONCE_MISMATCH' };

    // Check expiry
    if (new Date(grant.expiresAt) < new Date()) return { error: 'GRANT_EXPIRED' };

    // Check consumed
    if (grant.consumedAt !== null) return { error: 'GRANT_ALREADY_CONSUMED' };

    // Step 9: atomically consume
    grant.consumedAt = new Date().toISOString();

    // Step 10: retrieve value
    const value = this.values.get(token);
    if (!value) return { error: 'VALUE_NOT_FOUND' };

    return { value };
  }

  /** Get grant metadata (without value) for verification. */
  getGrant(token: string): CapabilityGrant | null {
    return this.grants.get(token) || null;
  }

  /** Check if a token exists in the vault. */
  hasToken(token: string): boolean {
    return this.values.has(token);
  }

  /** Revoke all grants for a session. */
  revokeSession(sessionId: string): number {
    let count = 0;
    for (const [token, grant] of this.grants) {
      if (grant.sessionId === sessionId) {
        this.values.delete(token);
        this.grants.delete(token);
        count++;
      }
    }
    return count;
  }

  /** Revoke all expired grants. */
  revokeExpired(): number {
    const now = new Date();
    let count = 0;
    for (const [token, grant] of this.grants) {
      if (new Date(grant.expiresAt) < now) {
        this.values.delete(token);
        this.grants.delete(token);
        count++;
      }
    }
    return count;
  }

  /** Clear the entire vault. */
  clear(): void {
    this.values.clear();
    this.grants.clear();
    this.byCategory.clear();
  }

  /** Get vault statistics (no raw values). */
  stats(): { totalTokens: number; totalGrants: number; consumed: number; expired: number } {
    const now = new Date();
    let consumed = 0;
    let expired = 0;
    for (const grant of this.grants.values()) {
      if (grant.consumedAt) consumed++;
      if (new Date(grant.expiresAt) < now) expired++;
    }
    return {
      totalTokens: this.values.size,
      totalGrants: this.grants.size,
      consumed,
      expired,
    };
  }
}

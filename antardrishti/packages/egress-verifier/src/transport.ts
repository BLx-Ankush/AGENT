/**
 * ANTARDRISHTI — Sealed Transport
 *
 * One extension-owned planner transport path (contract §16).
 * Transports EXACTLY the sealed bytes — no enrichment,
 * re-encoding, metadata append, destination change,
 * or redirect following (contract §1.10).
 */

import type { VerificationApproval } from './verifier';

export interface TransportConfig {
  /** Exact planner endpoint URL */
  plannerUrl: string;
  /** Request timeout in ms */
  timeoutMs: number;
}

export interface TransportResult {
  success: boolean;
  status: number;
  body: string;
  error?: string;
}

/**
 * Single transport function.
 * One fetch call, one method, one module.
 * Transports EXACTLY the sealed bytes.
 */
export async function transportSealed(
  approval: VerificationApproval,
  config: TransportConfig,
): Promise<TransportResult> {
  // Verify destination hash matches config
  const destHash = await hashString(config.plannerUrl);
  if (destHash !== approval.destinationHash) {
    return {
      success: false,
      status: 0,
      body: '',
      error: 'Destination hash mismatch — transport refuses',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    const response = await fetch(config.plannerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': approval.serializedSize.toString(),
        'X-Antardrishti-Seal': approval.bodyHash,
      },
      body: approval.sealedBytes,
      signal: controller.signal,
      redirect: 'error', // Refuse redirects (contract §1.10)
    });

    clearTimeout(timeout);

    // Verify no redirect occurred
    if (response.redirected) {
      return {
        success: false,
        status: response.status,
        body: '',
        error: 'Transport refused: redirect detected',
      };
    }

    const body = await response.text();

    return {
      success: response.ok,
      status: response.status,
      body,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (e) {
    return {
      success: false,
      status: 0,
      body: '',
      error: `Transport failed: ${e}`,
    };
  }
}

async function hashString(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

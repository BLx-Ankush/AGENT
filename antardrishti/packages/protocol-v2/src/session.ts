/**
 * ANTARDRISHTI Protocol v2 — Session Types
 */

export interface SessionState {
  id: string;
  step: number;
  observationId: string;
  origin: string;
  documentGeneration: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  createdAt: string;
  isActive: boolean;
}

export function createSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `session-${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

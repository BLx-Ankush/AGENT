/**
 * ANTARDRISHTI Protocol v2 — Internal Message Protocol
 *
 * Typed message envelopes for content script ↔ service worker ↔ UI.
 * All messages are validated at runtime.
 */

// ── Message types ────────────────────────────────────────────

export const MESSAGE_TYPES = {
  // Content → Background
  CONTENT_READY: 'content:ready',
  DOM_SNAPSHOT: 'content:dom-snapshot',
  DOM_MUTATION: 'content:dom-mutation',
  NAVIGATION: 'content:navigation',
  FORM_CHANGE: 'content:form-change',
  FOCUS_CHANGE: 'content:focus-change',
  SCROLL_COMPLETE: 'content:scroll-complete',
  VIEWPORT_CHANGE: 'content:viewport-change',
  ACTION_OUTCOME: 'content:action-outcome',

  // Background → Content
  REQUEST_SNAPSHOT: 'background:request-snapshot',
  EXECUTE_ACTION: 'background:execute-action',
  REQUEST_HIT_TEST: 'background:request-hit-test',
  VERIFY_TARGET: 'background:verify-target',

  // Background → UI
  STATUS_UPDATE: 'background:status-update',
  SESSION_STATE: 'background:session-state',
  CONFIRMATION_REQUEST: 'background:confirmation-request',
  METRICS_UPDATE: 'background:metrics-update',

  // UI → Background
  USER_TASK: 'ui:user-task',
  SESSION_CONTROL: 'ui:session-control',
  CONFIRMATION_RESPONSE: 'ui:confirmation-response',
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

// ── Message envelope ─────────────────────────────────────────

export interface MessageEnvelope<
  T extends MessageType = MessageType,
  P = unknown,
> {
  version: '2.0';
  type: T;
  payload: P;
  sender: 'content' | 'background' | 'ui' | 'inference';
  timestamp: string;
  correlationId?: string;
}

// ── Payload types ────────────────────────────────────────────

export interface ContentReadyPayload {
  tabId: number;
  frameId: number;
  origin: string;
  url: string;
  documentGeneration: string;
}

export interface DomSnapshotPayload {
  tabId: number;
  frameId: number;
  documentGeneration: string;
  mutationVersion: number;
  nodes: unknown[]; // SceneNode[] — typed in scene-graph package
  timestamp: string;
}

export interface StatusUpdatePayload {
  sessionId: string | null;
  isActive: boolean;
  currentPhase:
    | 'idle'
    | 'capturing'
    | 'perceiving'
    | 'sanitizing'
    | 'verifying'
    | 'planning'
    | 'executing'
    | 'confirming';
  lastObservationId: string | null;
  error?: string;
}

export interface UserTaskPayload {
  /** Raw task text. Will be sanitized locally before planner transmission. */
  rawTask: string;
  tabId: number;
}

export interface SessionControlPayload {
  action: 'start' | 'pause' | 'resume' | 'stop';
}

export interface ConfirmationRequestPayload {
  actionId: string;
  actionKind: string;
  targetDescription: string;
  destination?: string;
  effect?: string;
  risk: string;
}

export interface ConfirmationResponsePayload {
  actionId: string;
  approved: boolean;
}

export interface ExecuteActionPayload {
  actionId: string;
  kind: string;
  targetNodeId: string;
  value?: string; // Token or safe text, never raw secret
  expectedRole?: string;
}

export interface ActionOutcomePayload {
  actionId: string;
  success: boolean;
  outcome:
    | 'success'
    | 'failure'
    | 'ambiguous'
    | 'navigated'
    | 'rejected'
    | 'toctou_rejected';
  newDocumentGeneration?: string;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────

export function createMessage<T extends MessageType, P>(
  type: T,
  payload: P,
  sender: MessageEnvelope['sender'],
  correlationId?: string,
): MessageEnvelope<T, P> {
  return {
    version: '2.0',
    type,
    payload,
    sender,
    timestamp: new Date().toISOString(),
    correlationId,
  };
}

/** Validate a message envelope has the expected shape. */
export function isValidMessageEnvelope(
  msg: unknown,
): msg is MessageEnvelope {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.version === '2.0' &&
    typeof m.type === 'string' &&
    typeof m.sender === 'string' &&
    typeof m.timestamp === 'string' &&
    'payload' in m
  );
}

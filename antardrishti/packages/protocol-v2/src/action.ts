/**
 * ANTARDRISHTI Protocol v2 — Typed Action Language
 *
 * Closed typed action language. The planner MUST NOT receive or execute:
 * JavaScript, eval, arbitrary selectors, shell commands, filesystem paths,
 * unrestricted URLs, or arbitrary tool calls.
 */

/** Typed action union. Only these action kinds are permitted. */
export type AgentAction =
  | ClickAction
  | FocusAction
  | TypeTextAction
  | TypeTokenAction
  | SelectAction
  | ScrollAction
  | WaitAction
  | RequestObservationAction
  | FinishAction;

export interface ClickAction {
  kind: 'click';
  id: string;
  targetNodeId: string;
  expectedRole?: string;
  reason?: string;
}

export interface FocusAction {
  kind: 'focus';
  id: string;
  targetNodeId: string;
}

export interface TypeTextAction {
  kind: 'type_text';
  id: string;
  targetNodeId: string;
  text: string;
  expectedRole?: string;
}

export interface TypeTokenAction {
  kind: 'type_token';
  id: string;
  targetNodeId: string;
  token: string;
  expectedRole?: string;
  expectedRedactionCategory?: string;
  expectedShape?: string;
  targetDocumentGeneration?: string;
  reason?: string;
}

export interface SelectAction {
  kind: 'select';
  id: string;
  targetNodeId: string;
  optionId: string;
}

export interface ScrollAction {
  kind: 'scroll';
  id: string;
  containerNodeId?: string;
  direction: 'up' | 'down';
  amount: 'small' | 'page';
}

export interface WaitAction {
  kind: 'wait';
  id: string;
  milliseconds: number;
}

export interface RequestObservationAction {
  kind: 'request_observation';
  id: string;
  reason: string;
}

export interface FinishAction {
  kind: 'finish';
  id: string;
  summary: string;
}

/** Action risk classification. */
export type ActionRisk = 'low' | 'medium' | 'high' | 'critical';

/** Classify the default risk level for an action kind. */
export function classifyActionRisk(action: AgentAction): ActionRisk {
  switch (action.kind) {
    case 'scroll':
    case 'focus':
    case 'wait':
    case 'request_observation':
    case 'finish':
      return 'low';
    case 'click':
    case 'type_text':
    case 'select':
      return 'medium';
    case 'type_token':
      return 'high';
    default:
      return 'critical';
  }
}

/**
 * Determine whether an action requires explicit user confirmation.
 * High-impact actions (submit, payment, delete, send, upload) MUST confirm.
 */
export function requiresConfirmation(
  action: AgentAction,
  targetContext?: {
    isSubmit?: boolean;
    isPayment?: boolean;
    isDestructive?: boolean;
    isSend?: boolean;
    isUpload?: boolean;
  }
): boolean {
  if (action.kind === 'type_token') return true;
  if (action.kind === 'click' && targetContext) {
    return !!(
      targetContext.isSubmit ||
      targetContext.isPayment ||
      targetContext.isDestructive ||
      targetContext.isSend ||
      targetContext.isUpload
    );
  }
  return false;
}

export const ALLOWED_ACTION_KINDS = [
  'click', 'focus', 'type_text', 'type_token', 'select',
  'scroll', 'wait', 'request_observation', 'finish',
] as const;

export type AllowedActionKind = (typeof ALLOWED_ACTION_KINDS)[number];

export function isAllowedActionKind(kind: string): kind is AllowedActionKind {
  return (ALLOWED_ACTION_KINDS as readonly string[]).includes(kind);
}

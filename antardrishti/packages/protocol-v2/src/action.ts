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

// ── Target risk context ──────────────────────────────────────

/**
 * Local target-risk classification result.
 * Derived ONLY from authoritative DOM/scene node fields.
 * The planner MUST NOT populate or override these flags.
 */
export interface TargetRiskContext {
  isSubmit?: boolean;
  isPayment?: boolean;
  isDestructive?: boolean;
  isSend?: boolean;
  isUpload?: boolean;
}

// ── Keyword lists (case-insensitive matching against name/visibleText) ──

const SUBMIT_KEYWORDS = [
  'submit', 'confirm submission', 'submit application',
  'confirm order', 'place order', 'apply', 'register',
  'sign up', 'create account',
];

const PAYMENT_KEYWORDS = [
  'pay', 'pay now', 'purchase', 'checkout', 'check out',
  'complete purchase', 'buy', 'buy now', 'donate',
  'complete payment', 'process payment',
];

const DESTRUCTIVE_KEYWORDS = [
  'delete', 'permanently delete', 'erase', 'remove permanently',
  'destroy', 'wipe', 'discard permanently',
];

const SEND_KEYWORDS = [
  'send', 'send message', 'send email', 'transfer',
  'transfer funds', 'send money', 'wire transfer',
  'send payment', 'submit message', 'post message',
];

/**
 * Classify target risk using ONLY authoritative local DOM/scene information.
 *
 * Deterministic, explainable, no ML.
 *
 * Inputs:
 *   - role:        ARIA role or inferred role (e.g. 'button', 'link')
 *   - name:        Computed accessible name
 *   - visibleText: Visible text content
 *   - tag:         HTML tag name (e.g. 'input', 'button', 'a')
 *   - inputType:   Input type attribute (e.g. 'submit', 'file')
 *   - affordances: Available affordances (e.g. ['click', 'upload'])
 */
export function classifyTargetRisk(node: {
  role?: string;
  name?: string;
  visibleText?: string;
  tag?: string;
  inputType?: string;
  affordances?: string[];
}): TargetRiskContext {
  const result: TargetRiskContext = {};

  // Normalize text signals for keyword matching
  const nameLC = (node.name || '').toLowerCase().trim();
  const textLC = (node.visibleText || '').toLowerCase().trim();
  const roleLC = (node.role || '').toLowerCase();
  const tagLC = (node.tag || '').toLowerCase();
  const inputTypeLC = (node.inputType || '').toLowerCase();
  const affordances = node.affordances || [];

  // Combined text for keyword matching (deduped via set)
  const searchTexts = new Set<string>();
  if (nameLC) searchTexts.add(nameLC);
  if (textLC) searchTexts.add(textLC);

  // ── Upload detection (strongest signal: inputType=file) ──
  if (inputTypeLC === 'file' || affordances.includes('upload')) {
    result.isUpload = true;
  }

  // ── Submit detection ──
  // input[type=submit] or button[type=submit] is authoritative
  if (inputTypeLC === 'submit') {
    result.isSubmit = true;
  }
  // role=button with submit-like text
  if (!result.isSubmit) {
    for (const text of searchTexts) {
      if (matchesKeywords(text, SUBMIT_KEYWORDS)) {
        result.isSubmit = true;
        break;
      }
    }
  }

  // ── Payment detection ──
  for (const text of searchTexts) {
    if (matchesKeywords(text, PAYMENT_KEYWORDS)) {
      result.isPayment = true;
      break;
    }
  }

  // ── Destructive detection ──
  for (const text of searchTexts) {
    if (matchesKeywords(text, DESTRUCTIVE_KEYWORDS)) {
      result.isDestructive = true;
      break;
    }
  }

  // ── Send detection ──
  for (const text of searchTexts) {
    if (matchesKeywords(text, SEND_KEYWORDS)) {
      result.isSend = true;
      break;
    }
  }

  return result;
}

/**
 * Check whether text matches any keyword.
 * Uses exact-start matching: the text must start with or equal the keyword,
 * OR contain the keyword as a whole-word substring.
 * This prevents "Send" from matching inside "Resend settings overview"
 * while still matching "Send message" and "Send".
 */
function matchesKeywords(text: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    // Exact match
    if (text === kw) return true;
    // Starts with keyword (e.g. "submit application" starts with "submit")
    if (text.startsWith(kw + ' ') || text.startsWith(kw + '\t')) return true;
    // Word boundary match: keyword appears as complete word(s)
    const idx = text.indexOf(kw);
    if (idx >= 0) {
      const before = idx === 0 || /\s/.test(text[idx - 1]);
      const afterIdx = idx + kw.length;
      const after = afterIdx >= text.length || /\s/.test(text[afterIdx]);
      if (before && after) return true;
    }
  }
  return false;
}

/**
 * Returns true if ANY risk flag is set on the context.
 */
export function isHighRiskTarget(ctx: TargetRiskContext): boolean {
  return !!(ctx.isSubmit || ctx.isPayment || ctx.isDestructive || ctx.isSend || ctx.isUpload);
}

export const ALLOWED_ACTION_KINDS = [
  'click', 'focus', 'type_text', 'type_token', 'select',
  'scroll', 'wait', 'request_observation', 'finish',
] as const;

export type AllowedActionKind = (typeof ALLOWED_ACTION_KINDS)[number];

export function isAllowedActionKind(kind: string): kind is AllowedActionKind {
  return (ALLOWED_ACTION_KINDS as readonly string[]).includes(kind);
}

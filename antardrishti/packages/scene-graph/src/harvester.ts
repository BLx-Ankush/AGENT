/**
 * ANTARDRISHTI — Full DOM/A11y Harvester
 *
 * Reconstructs accessibility-like semantics from DOM and ARIA.
 * Does NOT claim direct access to a universal native browser
 * accessibility tree.
 *
 * Runs in the content script context. Collects all fields
 * specified in the contract §8.
 */

import type { SceneNode, SensitivityFinding, Affordance } from './scene-node';
import {
  generateSequentialNodeId,
  resetNodeIdCounter,
  computeStableTargetRef,
  computeAncestryFingerprint,
  fastHash,
} from './node-id';

// ── Authoritative nodeId → HTMLElement map (P0-B) ────────────
//
// Built during harvestDOM(). Each nodeId is mapped to the exact
// HTMLElement that was observed during THIS harvest traversal.
// The action executor consumes a copy of this map — it NEVER
// regenerates node IDs independently.
//
// This map lives in content-script memory. It is never serialized
// and never crosses the message boundary.

const _lastHarvestElementMap = new Map<string, HTMLElement>();

/**
 * Return the authoritative nodeId→HTMLElement map from the last harvest.
 * The caller MUST copy entries — the internal map is cleared on next harvest.
 */
export function getLastHarvestElementMap(): ReadonlyMap<string, HTMLElement> {
  return _lastHarvestElementMap;
}

// ── Harvester configuration ──────────────────────────────────

const MAX_TEXT_LENGTH = 200;
const MAX_NODES = 1000;

// ── Immediate sensitivity hints (contract §8) ───────────────

const SENSITIVE_INPUT_TYPES = new Set([
  'password', 'email', 'tel',
]);

const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'cc-type',
  'one-time-code', 'email', 'tel', 'street-address',
  'address-line1', 'address-line2', 'postal-code',
  'country', 'bday', 'sex', 'name', 'given-name',
  'family-name', 'username', 'new-password', 'current-password',
]);

const SENSITIVE_LABEL_KEYWORDS = [
  'password', 'credential', 'bank', 'account', 'card',
  'cvv', 'cvc', 'ssn', 'aadhaar', 'pan', 'passport',
  'identity', 'health', 'medical', 'student', 'employee',
  'government', 'social security', 'otp', 'pin', 'secret',
  'private key', 'api key', 'token',
];

// ── Main harvester ───────────────────────────────────────────

export interface HarvestResult {
  nodes: SceneNode[];
  mutationVersion: number;
  harvestedAt: string;
  viewportWidth: number;
  viewportHeight: number;
  documentGeneration: string;
  origin: string;
}

/**
 * Harvest the visible DOM, producing SceneNode records with
 * full structural, geometric, interactive, and sensitivity data.
 */
export function harvestDOM(
  observationId: string,
  documentGeneration: string,
  frameId: number,
): HarvestResult {
  resetNodeIdCounter();
  _lastHarvestElementMap.clear();
  const now = new Date().toISOString();
  const nodes: SceneNode[] = [];
  const origin = window.location.origin;

  // Walk all potentially relevant elements
  const walker = document.createTreeWalker(
    document.body || document.documentElement,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        const el = node as HTMLElement;
        if (!el.getBoundingClientRect) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let el: HTMLElement | null = walker.currentNode as HTMLElement;
  let count = 0;

  while (el && count < MAX_NODES) {
    if (el instanceof HTMLElement) {
      const node = harvestElement(el, observationId, documentGeneration, frameId, now);
      if (node) {
        nodes.push(node);
        count++;
      }
    }
    el = walker.nextNode() as HTMLElement | null;
  }

  return {
    nodes,
    mutationVersion: Date.now(),
    harvestedAt: now,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentGeneration,
    origin,
  };
}

// ── Element harvesting ───────────────────────────────────────

function harvestElement(
  el: HTMLElement,
  observationId: string,
  documentGeneration: string,
  frameId: number,
  timestamp: string,
): SceneNode | null {
  const rect = el.getBoundingClientRect();

  // Skip zero-sized elements
  if (rect.width < 1 || rect.height < 1) return null;

  // Skip elements entirely outside viewport
  if (
    rect.bottom < 0 ||
    rect.top > window.innerHeight ||
    rect.right < 0 ||
    rect.left > window.innerWidth
  ) return null;

  // Check computed style
  const style = getComputedStyle(el);
  if (style.display === 'none') return null;

  const visibility = style.visibility as 'visible' | 'hidden' | 'collapse';
  const opacity = parseFloat(style.opacity);

  // Skip fully invisible (but still record hidden inputs for sensitivity)
  const isFormInput = el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement;
  if (visibility === 'hidden' && !isFormInput) return null;
  if (opacity === 0 && !isFormInput) return null;

  const tag = el.tagName.toLowerCase();
  const role = inferRole(el);
  const name = computeAccessibleName(el);
  const description = el.getAttribute('aria-description') || '';
  const visibleText = getVisibleText(el);
  const affordances = inferAffordances(el, role);
  const id = generateSequentialNodeId();
  _lastHarvestElementMap.set(id, el);

  // Ancestry
  const ancestorTags = getAncestorTags(el);

  // BBox
  const bbox = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };

  // Z-index
  const zIndex = parseInt(style.zIndex) || 0;

  // Focusability
  const isFocusable =
    el.tabIndex >= 0 ||
    isNativelyFocusable(el);

  // Disabled / read-only
  const isDisabled = (el as HTMLInputElement).disabled === true;
  const isReadOnly = (el as HTMLInputElement).readOnly === true;
  const tabIndex = el.tabIndex !== -1 ? el.tabIndex : null;

  // Input-specific
  const inputType = el instanceof HTMLInputElement ? el.type : undefined;
  const autocomplete = el instanceof HTMLInputElement
    ? (el.autocomplete || undefined)
    : undefined;

  // Sensitivity detection (immediate hints)
  const sensitivity = detectImmediateSensitivity(el, name, role, inputType, autocomplete);

  // Clipping check
  const isClipped = isElementClipped(el);

  // Form ancestry
  const formEl = el.closest('form');
  const formAncestorId = formEl ? `form-${fastHash(formEl.id || formEl.action || '')}` : undefined;

  // Landmark
  const landmarkType = findLandmarkType(el);

  // User-entered value check
  const hasUserValue = isFormInput
    ? (el as HTMLInputElement).value !== (el as HTMLInputElement).defaultValue
    : undefined;

  // Stable target ref
  const stableTargetRef = computeStableTargetRef(tag, role, name, ancestorTags, bbox);
  const ancestryFingerprint = computeAncestryFingerprint(ancestorTags);

  return {
    id,
    observationId,
    source: ['dom', 'a11y-reconstructed'],
    frameId,
    documentGeneration,
    originClass: 'top',
    tag,
    role,
    name,
    description,
    visibleText,
    bbox,
    isClipped,
    zIndex,
    opacity,
    visibility,
    affordances,
    isFocusable,
    isDisabled,
    isReadOnly,
    tabIndex,
    inputType,
    autocomplete,
    validationState: undefined,
    hasUserValue,
    sensitivity,
    necessity: 'unknown',
    conflictFlags: [],
    formAncestorId,
    landmarkType,
    stableTargetRef,
    visualEvidenceHash: undefined,
    ancestryFingerprint,
    mutationVersion: Date.now(),
    harvestedAt: timestamp,
  };
}

// ── Role inference ───────────────────────────────────────────

function inferRole(el: HTMLElement): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button': return 'button';
    case 'input': {
      const t = (el as HTMLInputElement).type;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      if (t === 'hidden') return 'hidden';
      return 'textbox';
    }
    case 'select': return 'combobox';
    case 'textarea': return 'textbox';
    case 'img': return 'img';
    case 'canvas': return 'img';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'header': return 'banner';
    case 'footer': return 'contentinfo';
    case 'aside': return 'complementary';
    case 'section': return el.getAttribute('aria-label') ? 'region' : 'generic';
    case 'form': return 'form';
    case 'table': return 'table';
    case 'h1': case 'h2': case 'h3':
    case 'h4': case 'h5': case 'h6': return 'heading';
    case 'ul': case 'ol': return 'list';
    case 'li': return 'listitem';
    case 'dialog': return 'dialog';
    case 'progress': return 'progressbar';
    case 'meter': return 'meter';
    default: return 'generic';
  }
}

// ── Accessible name ──────────────────────────────────────────

function computeAccessibleName(el: HTMLElement): string {
  // aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  // Label association
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent?.trim()?.substring(0, MAX_TEXT_LENGTH) || '';
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, select, textarea').forEach(c => c.remove());
      const t = clone.textContent?.trim();
      if (t) return t.substring(0, MAX_TEXT_LENGTH);
    }
    if ('placeholder' in el && (el as HTMLInputElement).placeholder) {
      return (el as HTMLInputElement).placeholder;
    }
  }

  // title
  const title = el.getAttribute('title');
  if (title) return title.trim();

  // alt
  if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();

  // Text content
  const text = el.textContent?.trim();
  if (text && text.length <= MAX_TEXT_LENGTH) return text;

  return '';
}

// ── Affordances ──────────────────────────────────────────────

function inferAffordances(el: HTMLElement, role: string): Affordance[] {
  const aff: Affordance[] = [];

  if (role === 'button' || role === 'link' || role === 'checkbox' ||
      role === 'radio' || role === 'combobox' || role === 'slider') {
    aff.push('click');
  }

  if (role === 'textbox' || role === 'searchbox') {
    aff.push('type');
    aff.push('focus');
  }

  if (role === 'combobox') {
    aff.push('select');
  }

  if (el.getAttribute('contenteditable') === 'true') {
    aff.push('type');
  }

  if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
    aff.push('scroll');
  }

  if (el instanceof HTMLInputElement && el.type === 'file') {
    aff.push('upload');
  }

  if (aff.length === 0 && isNativelyFocusable(el)) {
    aff.push('focus');
  }

  return aff;
}

// ── Sensitivity detection (immediate hints) ──────────────────

function detectImmediateSensitivity(
  el: HTMLElement,
  name: string,
  role: string,
  inputType?: string,
  autocomplete?: string,
): SensitivityFinding[] {
  const findings: SensitivityFinding[] = [];

  // Password input
  if (inputType === 'password') {
    findings.push({
      category: 'credential',
      confidence: 1.0,
      validationTier: 'context-inferred',
      evidenceSource: 'input-type-password',
    });
  }

  // Sensitive input types
  if (inputType && SENSITIVE_INPUT_TYPES.has(inputType)) {
    findings.push({
      category: 'contact',
      confidence: 0.9,
      validationTier: 'context-inferred',
      evidenceSource: `input-type-${inputType}`,
    });
  }

  // Autocomplete hints
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.has(autocomplete)) {
    const category = autocomplete.startsWith('cc-') ? 'payment'
      : autocomplete === 'one-time-code' ? 'credential'
      : autocomplete === 'bday' || autocomplete === 'sex' ? 'identity-document'
      : 'contact';
    findings.push({
      category,
      confidence: 0.95,
      validationTier: 'context-inferred',
      evidenceSource: `autocomplete-${autocomplete}`,
    });
  }

  // Label-based sensitivity
  const lowerName = name.toLowerCase();
  for (const keyword of SENSITIVE_LABEL_KEYWORDS) {
    if (lowerName.includes(keyword)) {
      const cat = keyword.includes('bank') || keyword.includes('account') || keyword.includes('card')
        ? 'financial'
        : keyword.includes('password') || keyword.includes('otp') || keyword.includes('pin') || keyword.includes('secret') || keyword.includes('key')
        ? 'credential'
        : keyword.includes('health') || keyword.includes('medical')
        ? 'health'
        : keyword.includes('aadhaar') || keyword.includes('ssn') || keyword.includes('passport') || keyword.includes('pan')
        ? 'identity-document'
        : 'contact';
      findings.push({
        category: cat,
        confidence: 0.7,
        validationTier: 'context-inferred',
        evidenceSource: `label-keyword-${keyword}`,
      });
      break; // one label finding is enough
    }
  }

  // Reveal-password state
  if (inputType === 'text' && el.getAttribute('data-password-reveal') !== null) {
    findings.push({
      category: 'credential',
      confidence: 0.8,
      validationTier: 'context-inferred',
      evidenceSource: 'password-reveal-state',
    });
  }

  return findings;
}

// ── Helpers ──────────────────────────────────────────────────

function getVisibleText(el: HTMLElement): string {
  const text = el.textContent?.trim() || '';
  return text.substring(0, MAX_TEXT_LENGTH);
}

function getAncestorTags(el: HTMLElement): string[] {
  const tags: string[] = [];
  let current: HTMLElement | null = el.parentElement;
  while (current && tags.length < 10) {
    tags.unshift(current.tagName.toLowerCase());
    current = current.parentElement;
  }
  return tags;
}

function isNativelyFocusable(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
    el.tabIndex >= 0;
}

function isElementClipped(el: HTMLElement): boolean {
  let parent = el.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    if (style.overflow === 'hidden' || style.overflow === 'clip') {
      const parentRect = parent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (
        elRect.right > parentRect.right + 1 ||
        elRect.bottom > parentRect.bottom + 1 ||
        elRect.left < parentRect.left - 1 ||
        elRect.top < parentRect.top - 1
      ) {
        return true;
      }
    }
    parent = parent.parentElement;
  }
  return false;
}

function findLandmarkType(el: HTMLElement): string | undefined {
  const landmarks = ['nav', 'main', 'header', 'footer', 'aside', 'form', 'section'];
  let current: HTMLElement | null = el;
  while (current) {
    if (landmarks.includes(current.tagName.toLowerCase())) {
      return current.tagName.toLowerCase();
    }
    const role = current.getAttribute('role');
    if (role && ['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'region'].includes(role)) {
      return role;
    }
    current = current.parentElement;
  }
  return undefined;
}

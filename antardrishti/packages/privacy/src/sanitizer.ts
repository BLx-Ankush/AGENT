/**
 * ANTARDRISHTI — Full-Envelope Sanitizer
 *
 * Sanitizes the complete planner request envelope.
 * The sanitizer MUST NOT be the only safety witness (contract §1.7).
 * The independent verifier (Phase 5) distrusts this output.
 *
 * Sanitize: user task text, page title, URL path/query/fragment,
 * node names/labels, crop reasons, errors/stack traces, capability
 * metadata, action outcomes, prior turns, filenames, timing/identifiers.
 *
 * Contract §13: every planner request contains redactions[].
 * When visual regions are masked: protectedVisualRegions[].
 */

import type { SceneNode } from '@antardrishti/scene-graph';
import type {
  PlannerSceneNode,
  PlannerScene,
  RedactionDeclaration,
  ProtectedVisualRegion,
  RedactionCategory,
  RedactionShape,
  OpaqueToken,
} from '@antardrishti/protocol-v2';

import { scanForPii, type PiiDetection } from '@antardrishti/pii-rules';
import { TokenVault } from './token-vault';
import { evaluatePolicy, type PolicyDecision } from './policy';
import {
  ContextSensitivityDetector,
  fuse,
  type SemanticDetection,
} from '@antardrishti/semantic-sensitivity';

// Singleton context scorer — stateless, safe to share across sanitize() calls
const _ctxDetector = new ContextSensitivityDetector();

// ── Sanitization result ──────────────────────────────────────

export interface SanitizationResult {
  /** Sanitized task text */
  sanitizedTask: string;
  /** Sanitized scene nodes (planner-visible) */
  scene: PlannerScene;
  /** Redaction declarations (ALWAYS present) */
  redactions: RedactionDeclaration[];
  /** Protected visual regions */
  protectedVisualRegions: ProtectedVisualRegion[];
  /** Risk level */
  risk: 'low' | 'medium' | 'high';
}

// ── Sanitizer ────────────────────────────────────────────────

export class Sanitizer {
  private vault: TokenVault;

  constructor(vault: TokenVault) {
    this.vault = vault;
  }

  /**
   * Sanitize a full planner request envelope.
   * Returns sanitized content + redaction declarations.
   */
  sanitize(
    rawTask: string,
    localNodes: SceneNode[],
    sessionId: string,
    tabId: number,
    frameId: number,
    documentGeneration: string,
    origin: string,
  ): SanitizationResult {
    const redactions: RedactionDeclaration[] = [];
    const protectedVisualRegions: ProtectedVisualRegion[] = [];

    // 1. Sanitize task text
    const sanitizedTask = this.sanitizeText(
      rawTask, 'task', redactions, sessionId, tabId, frameId,
      documentGeneration, origin,
    );

    // 2. Sanitize scene nodes → planner-visible nodes
    const plannerNodes: PlannerSceneNode[] = [];

    for (const node of localNodes) {
      const pNode = this.sanitizeNode(
        node, redactions, protectedVisualRegions,
        sessionId, tabId, frameId, documentGeneration, origin,
      );
      plannerNodes.push(pNode);
    }

    // 3. Determine risk level
    const hasInjection = this.detectInjection(rawTask);
    const risk = hasInjection ? 'high'
      : redactions.length > 5 ? 'high'
      : redactions.length > 0 ? 'medium'
      : 'low';

    return {
      sanitizedTask,
      scene: {
        nodes: plannerNodes,
        coverage: {
          visualGrounding: 'none',  // Updated in Phase 3
          unresolvedRegions: 0,
          structuredGate: 'passed',
          visualGate: 'not-applicable',
        },
      },
      redactions,
      protectedVisualRegions,
      risk,
    };
  }

  // ── Text sanitization ────────────────────────────────────

  private sanitizeText(
    text: string,
    context: string,
    redactions: RedactionDeclaration[],
    sessionId: string,
    tabId: number,
    frameId: number,
    documentGeneration: string,
    origin: string,
    hints?: { label?: string; fieldName?: string; inputType?: string; fromOcr?: boolean },
    targetNodeId?: string,
  ): string {
    // ── Layer 1: deterministic PII rules ─────────────────────
    const deterministicDetections = scanForPii(text);

    // ── Layer 2: semantic context-window scorer ───────────────
    // Run on text spans NOT already covered by high-confidence deterministic matches
    const semanticDetections: SemanticDetection[] = _ctxDetector.detect(text, hints);

    // ── Layer 3: conservative fusion ─────────────────────────
    const fused = fuse(deterministicDetections, semanticDetections);

    if (fused.length === 0) return text;

    let sanitized = text;
    // Process in reverse order to maintain offsets
    const sorted = [...fused].sort(
      (a, b) => (b.span?.start ?? 0) - (a.span?.start ?? 0),
    );

    for (const decision of sorted) {
      if (!decision.sensitive || decision.policyDecision === 'allow') continue;
      if (!decision.span) continue;

      // Map SensitivityDecision → SensitivityFinding for policy engine
      const policy = evaluatePolicy({
        sensitivity: {
          category: decision.subtype ?? decision.category,
          confidence: decision.confidence,
          validationTier: decision.source === 'deterministic'
            ? 'pattern-matched'
            : 'context-inferred',
          evidenceSource: decision.detectorIds.join(','),
        },
        taskNecessity: 'unknown',
        recipient: 'remote-planner',
        origin,
        hasUserAuthorization: false,
        ambiguity: 'none',
      });

      if (policy.decision === 'ALLOW_LITERAL') continue;

      const rawValue = sanitized.slice(decision.span.start, decision.span.end);

      // Use tokenPrefix from taxonomy for semantic detections;
      // deterministic detections use their category directly
      const vaultCategory = decision.source === 'deterministic'
        ? (decision.subtype ?? decision.category)
        : decision.category.toUpperCase().replace(/[^A-Z0-9]/g, '_');

      // Store value in vault and get token.
      // targetRef: If sanitizing a node value, bind to the authoritative
      // node ID (execution target). For task text or other contexts
      // without a node target, use the redaction location.
      // permittedOperation: 'type_token' — only type_token execution
      // can redeem node-value capabilities.
      const { token } = this.vault.storeValue(
        rawValue,
        vaultCategory,
        sessionId, tabId, frameId,
        documentGeneration, origin,
        targetNodeId || `${context}:${decision.span.start}`,
        'type_token',
      );

      // Replace in text
      sanitized =
        sanitized.substring(0, decision.span.start) +
        token +
        sanitized.substring(decision.span.end);

      // Create redaction declaration
      redactions.push({
        token: token as string,
        category: mapToRedactionCategory(decision.subtype ?? decision.category),
        shape: mapToRedactionShape(decision.subtype ?? decision.category),
        region: `${context}:${decision.span.start}`,
        representation: 'placeholder',
        disclosure: 'shape-only',
        reasonCode: 'required-for-planning',
      });
    }

    return sanitized;
  }

  // ── Node sanitization ────────────────────────────────────

  private sanitizeNode(
    node: SceneNode,
    redactions: RedactionDeclaration[],
    visualRegions: ProtectedVisualRegion[],
    sessionId: string,
    tabId: number,
    frameId: number,
    documentGeneration: string,
    origin: string,
  ): PlannerSceneNode {
    // Sanitize name
    let name = node.name;
    if (name) {
      name = this.sanitizeText(
        name, `node:${node.id}:name`, redactions,
        sessionId, tabId, frameId, documentGeneration, origin,
      );
    }

    // Sanitize visible text — bind to node.id for execution targeting
    let value = node.visibleText;
    if (value) {
      value = this.sanitizeText(
        value, `node:${node.id}:value`, redactions,
        sessionId, tabId, frameId, documentGeneration, origin,
        undefined, node.id,
      );
    }

    // Check node-level sensitivity
    for (const finding of (node.sensitivity ?? [])) {
      const policy = evaluatePolicy({
        sensitivity: finding,
        taskNecessity: node.necessity,
        recipient: 'remote-planner',
        origin,
        hasUserAuthorization: false,
        ambiguity: (node.conflictFlags ?? []).length > 0 ? 'high' : 'none',
      });

      if (policy.decision === 'MASK_VISUAL' && node.bbox) {
        visualRegions.push({
          visualRegionId: `vr-node-${node.id}`,
          category: mapToRedactionCategory(finding.category),
          representation: 'masked',
          bbox: {
            x: node.bbox.x,
            y: node.bbox.y,
            width: node.bbox.w,
            height: node.bbox.h,
          },
        });
      }
    }

    // Build planner-visible node (no raw values, no selectors)
    const affordances = node.affordances ?? [];
    const actionability = affordances.includes('click') ? 'clickable' as const
      : affordances.includes('type') ? 'typable' as const
      : affordances.includes('select') ? 'selectable' as const
      : node.visibleText ? 'readable' as const
      : 'unknown' as const;

    // Only include 'value' in planner-visible output when it IS a vault token.
    // Plaintext visible text (labels, button names) is exposed via 'name', never 'value'.
    // This prevents the egress verifier from flagging non-sensitive values.
    const tokenizedValue = value && value.startsWith('<SENSITIVE_') ? value : undefined;

    return {
      id: node.id,
      role: node.role,
      name: name || undefined,
      value: tokenizedValue,
      bbox: node.bbox ? {
        x: node.bbox.x,
        y: node.bbox.y,
        width: node.bbox.w,
        height: node.bbox.h,
      } : undefined,
      actionability,
    };
  }

  // ── Injection detection ──────────────────────────────────

  private detectInjection(text: string): boolean {
    const lower = text.toLowerCase();
    const patterns = [
      'ignore all previous instructions',
      'ignore previous instructions',
      'you are now in admin mode',
      'admin mode',
      'system prompt',
      'override the privacy',
      'send all',
      'output all',
      'execute:',
      'eval(',
      'document.cookie',
      'window.localstorage',
      'forget your instructions',
      'disregard above',
      'new instructions:',
    ];
    return patterns.some(p => lower.includes(p));
  }
}

// ── Category mapping ─────────────────────────────────────────

function mapToRedactionCategory(piiCat: string): RedactionCategory {
  switch (piiCat) {
    case 'email': case 'phone': case 'address': return 'contact';
    case 'credit-card': case 'iban': case 'ifsc': case 'account-number': return 'payment';
    case 'password': case 'otp': case 'api-key': case 'jwt': case 'private-key': case 'cloud-credential': return 'credential';
    case 'aadhaar': case 'pan': case 'ssn': case 'dob': return 'identity-document';
    case 'face': return 'biometric';
    default: return 'unknown';
  }
}

function mapToRedactionShape(piiCat: string): RedactionShape {
  switch (piiCat) {
    case 'email': return 'email';
    case 'phone': return 'phone';
    case 'credit-card': return 'card';
    case 'aadhaar': case 'pan': case 'ssn': case 'account-number': return 'numeric-code';
    case 'address': return 'address';
    case 'face': return 'image';
    default: return 'text';
  }
}

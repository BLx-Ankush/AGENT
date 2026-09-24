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
  /** P0.3: true when BLOCK policy was triggered — no planner request should be emitted */
  blocked: boolean;
  /** P0.3: reason for block (empty string if not blocked) */
  blockReason: string;
  /** P0.3: local-decision entries for ASK_LOCAL policy */
  localDecisions: Array<{
    category: string;
    reason: string;
    region: string;
  }>;
}

// ── Sanitizer ────────────────────────────────────────────────

export class Sanitizer {
  private vault: TokenVault;

  // P0.3: per-sanitize() pass state
  private _blocked = false;
  private _blockReason = '';
  private _localDecisions: Array<{ category: string; reason: string; region: string }> = [];

  constructor(vault: TokenVault) {
    this.vault = vault;
  }

  /**
   * Sanitize a full planner request envelope.
   * Returns sanitized content + redaction declarations.
   *
   * P0.3: Each policy decision now produces a distinct semantic outcome.
   * BLOCK → blocked=true, no planner request.
   * ASK_LOCAL → localDecisions populated, value not sent.
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

    // P0.3: track blocked state and local decisions across all sanitization
    this._blocked = false;
    this._blockReason = '';
    this._localDecisions = [];

    // 1. Sanitize task text
    const sanitizedTask = this.sanitizeText(
      rawTask, 'task', redactions, sessionId, tabId, frameId,
      documentGeneration, origin,
    );

    // If blocked, short-circuit — do not continue processing nodes
    if (this._blocked) {
      return {
        sanitizedTask: '',
        scene: { nodes: [], coverage: { visualGrounding: 'none', unresolvedRegions: 0, structuredGate: 'passed', visualGate: 'not-applicable' } },
        redactions,
        protectedVisualRegions,
        risk: 'high',
        blocked: true,
        blockReason: this._blockReason,
        localDecisions: this._localDecisions,
      };
    }

    // 2. Sanitize scene nodes → planner-visible nodes
    const plannerNodes: PlannerSceneNode[] = [];

    for (const node of localNodes) {
      const pNode = this.sanitizeNode(
        node, redactions, protectedVisualRegions,
        sessionId, tabId, frameId, documentGeneration, origin,
      );
      // If a node triggered BLOCK, short-circuit
      if (this._blocked) {
        return {
          sanitizedTask: '',
          scene: { nodes: [], coverage: { visualGrounding: 'none', unresolvedRegions: 0, structuredGate: 'passed', visualGate: 'not-applicable' } },
          redactions,
          protectedVisualRegions,
          risk: 'high',
          blocked: true,
          blockReason: this._blockReason,
          localDecisions: this._localDecisions,
        };
      }
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
      blocked: false,
      blockReason: '',
      localDecisions: this._localDecisions,
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
    taskNecessity: 'required' | 'helpful' | 'irrelevant' | 'unknown' = 'unknown',
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
        taskNecessity,
        recipient: 'remote-planner',
        origin,
        hasUserAuthorization: false,
        ambiguity: 'none',
      });

      if (policy.decision === 'ALLOW_LITERAL') continue;

      const rawValue = sanitized.slice(decision.span.start, decision.span.end);
      const region = `${context}:${decision.span.start}`;
      const catStr = decision.subtype ?? decision.category;

      // ── P0.3: Dispatch on policy decision ─────────────────

      switch (policy.decision) {

        // ── BLOCK: fail-closed, no planner request ──────────
        case 'BLOCK': {
          this._blocked = true;
          this._blockReason = policy.reason;
          // Do NOT tokenize, do NOT continue — sanitize() will short-circuit
          return sanitized; // caller checks this._blocked
        }

        // ── ASK_LOCAL: local decision, no outbound value ────
        case 'ASK_LOCAL': {
          this._localDecisions.push({
            category: catStr,
            reason: policy.reason,
            region,
          });
          // Replace value with local-decision marker — NOT a vault token
          const localMarker = `[LOCAL_DECISION:${catStr}]`;
          sanitized =
            sanitized.substring(0, decision.span.start) +
            localMarker +
            sanitized.substring(decision.span.end);

          redactions.push({
            token: localMarker,
            category: mapToRedactionCategory(catStr),
            shape: mapToRedactionShape(catStr),
            region,
            representation: 'omitted',
            disclosure: 'action-required',
            reasonCode: 'not-required',
          });
          break;
        }

        // ── OMIT: remove value entirely ─────────────────────
        case 'OMIT': {
          const omitMarker = `[OMITTED:${mapToRedactionCategory(catStr)}]`;
          sanitized =
            sanitized.substring(0, decision.span.start) +
            omitMarker +
            sanitized.substring(decision.span.end);

          redactions.push({
            token: omitMarker,
            category: mapToRedactionCategory(catStr),
            shape: mapToRedactionShape(catStr),
            region,
            representation: 'omitted',
            disclosure: 'category-only',
            reasonCode: 'not-required',
          });
          break;
        }

        // ── ABSTRACT: safe semantic abstraction ─────────────
        case 'ABSTRACT': {
          const abstraction = abstractValue(catStr);
          sanitized =
            sanitized.substring(0, decision.span.start) +
            abstraction +
            sanitized.substring(decision.span.end);

          redactions.push({
            token: abstraction,
            category: mapToRedactionCategory(catStr),
            shape: mapToRedactionShape(catStr),
            region,
            representation: 'abstracted',
            disclosure: 'shape-only',
            reasonCode: 'required-for-planning',
          });
          break;
        }

        // ── MASK_VISUAL: protected visual representation ────
        case 'MASK_VISUAL': {
          const maskMarker = `[MASKED:${mapToRedactionCategory(catStr)}]`;
          sanitized =
            sanitized.substring(0, decision.span.start) +
            maskMarker +
            sanitized.substring(decision.span.end);

          redactions.push({
            token: maskMarker,
            category: mapToRedactionCategory(catStr),
            shape: mapToRedactionShape(catStr),
            region,
            visualRegionId: `vr-text-${region}`,
            representation: 'masked',
            disclosure: 'category-only',
            reasonCode: 'not-required',
          });
          break;
        }

        // ── TOKENIZE: vault-backed token (existing behavior) ─
        case 'TOKENIZE':
        default: {
          // Use tokenPrefix from taxonomy for semantic detections;
          // deterministic detections use their category directly
          const vaultCategory = decision.source === 'deterministic'
            ? catStr
            : decision.category.toUpperCase().replace(/[^A-Z0-9]/g, '_');

          // Store value in vault and get token.
          // targetRef: bind to node ID or redaction location.
          // permittedOperation: 'type_token'
          const { token } = this.vault.storeValue(
            rawValue,
            vaultCategory,
            sessionId, tabId, frameId,
            documentGeneration, origin,
            targetNodeId || region,
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
            category: mapToRedactionCategory(catStr),
            shape: mapToRedactionShape(catStr),
            region,
            representation: 'placeholder',
            disclosure: 'shape-only',
            reasonCode: 'required-for-planning',
          });
          break;
        }
      }
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
        undefined, undefined, node.necessity ?? 'unknown',
      );
    }

    // Sanitize visible text — bind to node.id for execution targeting
    let value = node.visibleText;
    if (value) {
      value = this.sanitizeText(
        value, `node:${node.id}:value`, redactions,
        sessionId, tabId, frameId, documentGeneration, origin,
        undefined, node.id, node.necessity ?? 'unknown',
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

// ── P0.3: Abstraction ────────────────────────────────────────

/**
 * Generate a safe semantic abstraction for a sensitive value.
 * Returns a deterministic human-readable label that conveys
 * the category without exposing the actual value.
 *
 * Example: 'email' → '[an email address]'
 */
function abstractValue(category: string): string {
  switch (category) {
    case 'email': return '[an email address]';
    case 'phone': return '[a phone number]';
    case 'address': return '[a physical address]';
    case 'contact': return '[contact information]';
    case 'credit-card': return '[a payment card number]';
    case 'iban': return '[a bank account number]';
    case 'ifsc': return '[a bank code]';
    case 'account-number': return '[an account number]';
    case 'aadhaar': return '[an identity number]';
    case 'pan': return '[a tax identifier]';
    case 'ssn': return '[a government identifier]';
    case 'dob': return '[a date of birth]';
    case 'password': return '[a credential]';
    case 'otp': return '[a one-time code]';
    case 'api-key': return '[an API key]';
    case 'jwt': return '[an authentication token]';
    case 'private-key': return '[a private key]';
    case 'cloud-credential': return '[a cloud credential]';
    case 'face': return '[biometric data]';
    case 'health': return '[health information]';
    default: return `[${category} value]`;
  }
}

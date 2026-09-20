/**
 * ANTARDRISHTI — Session Coordinator (Production-Ready Full Pipeline)
 *
 * Orchestrates the complete production flow:
 *   BROWSER EVENT
 *   → CAPTURE
 *   → DOM/A11y HARVEST
 *   → CANVAS CONTEXT EXTRACTION
 *   → LOCAL PERCEPTION PIPELINE (real visual inference)
 *   → UNIFIED SCENE GRAPH
 *   → PRIVACY ENGINE
 *   → SANITIZED REQUEST
 *   → INDEPENDENT EGRESS VERIFIER
 *   → REMOTE PLANNER
 *   → LOCAL ACTION SAFETY GATE
 *   → TOKEN REDEMPTION (vault only)
 *   → ONE ACTION
 *   → RE-OBSERVE
 *
 * State persists across service worker suspension.
 */

import {
  isValidMessageEnvelope,
  createMessage,
  MESSAGE_TYPES,
  type MessageEnvelope,
  type StatusUpdatePayload,
  type UserTaskPayload,
  type SessionControlPayload,
  type ContentReadyPayload,
  type ConfirmationRequestPayload,
  type ConfirmationResponsePayload,
  type ActionOutcomePayload,
  type AgentAction,
  ALLOWED_ACTION_KINDS,
} from '@antardrishti/protocol-v2';

import { TokenVault } from '@antardrishti/privacy';
import { Sanitizer } from '@antardrishti/privacy';
import { EgressVerifier } from '@antardrishti/egress-verifier';
import {
  DeterministicPlanner,
  ServerPlannerAdapter,
  type PlannerAdapter,
  type PlannerRequestInput,
  type PlannerResponse,
} from '@antardrishti/planner';
import { validatePlan, checkActionFreshness, type SceneContext } from '@antardrishti/planner';
import { createTargetFingerprint, verifyTargetFingerprint, type TargetFingerprint } from '@antardrishti/protocol-v2';
import {
  PerceptionPipeline,
  type PerceptionResult,
  type CanvasRegionData,
  loadProductionModels,
  type LoadedModels,
  readBackendOverride,
} from '@antardrishti/model-runner';
import type { SceneNode, SensitivityFinding } from '@antardrishti/scene-graph';

import {
  isOffscreenToSwMessage,
  isInferenceResult,
  isInferenceInitResult,
  isInferenceError,
  assertInferenceResultTrustBoundary,
  withTimeout,
  type InferenceRunMessage,
  type InferenceInitResult,
  type InferenceResult,
} from '@antardrishti/model-runner/offscreen-bridge';

import { CaptureManager } from './capture';

// ── Action kinds that require re-observation after execution ──

const STATE_CHANGING_ACTIONS = new Set([
  'click', 'type_text', 'type_token', 'select', 'submit',
]);

// ── P0-A: Confirmation timeout ──────────────────────────────
// High-risk actions that are not confirmed within this window
// are rejected (fail closed).
const CONFIRMATION_TIMEOUT_MS = 60_000;

// ── P1-E: Sender authentication ─────────────────────────────
// Trusted extension UI pages live at chrome-extension://<id>/popup.html
// Content scripts have sender.tab set; extension pages do NOT.
const TRUSTED_UI_PATHS = ['/popup.html'];
const TRUSTED_OFFSCREEN_PATH = '/offscreen.html';

// ── State ────────────────────────────────────────────────────

interface CoordinatorState {
  sessionId: string | null;
  isActive: boolean;
  currentPhase: StatusUpdatePayload['currentPhase'];
  activeTabId: number | null;
  lastObservationId: string | null;
  step: number;
  plannerMode: 'deterministic' | 'server';
  plannerUrl: string | null;
}

const INITIAL_STATE: CoordinatorState = {
  sessionId: null,
  isActive: false,
  currentPhase: 'idle',
  activeTabId: null,
  lastObservationId: null,
  step: 0,
  plannerMode: 'deterministic',
  plannerUrl: null,
};

/**
 * Type guard for the privileged smoke-test diagnostic message.
 *
 * Admits ONLY { type: 'SMOKE_OFFSCREEN_TEST' }.
 * Accepts no payload keys -- the message must not carry user data,
 * screenshots, tokens, or arbitrary execution instructions.
 *
 * This is an explicit whitelist, not a generic envelope bypass.
 * Only this single type string is recognized.
 */
function isSmokeOffscreenTestMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  // Accept only exact type match -- no payload tolerated
  return m.type === 'SMOKE_OFFSCREEN_TEST' && Object.keys(m).length === 1;
}

export class Coordinator {
  private state: CoordinatorState = { ...INITIAL_STATE };
  private capture = new CaptureManager();
  private vault = new TokenVault();
  private sanitizer = new Sanitizer(this.vault);
  private verifier = new EgressVerifier();
  private planner: PlannerAdapter = new DeterministicPlanner();
  private perception = new PerceptionPipeline();

  // -- P1-G: Observation lifecycle tracking ---------------------------------
  /**
   * All observation IDs invalidated during the current session.
   * An observation is added when a state-changing action executes
   * successfully against it. Any subsequent pipeline that captures
   * the same observationId is rejected — the system MUST re-observe.
   *
   * Uses a Set (not a single ID) so that ALL consumed observations
   * remain permanently invalid for the session lifetime, not just
   * the most recent one.
   *
   * Cleared on session end (new session starts fresh).
   */
  _invalidatedObservationIds: Set<string> = new Set();

  // -- Offscreen inference state ------------------------------------------
  /**
   * Resolves when the offscreen document (Chrome) or direct model load
   * (Firefox) is ready. All perception calls are gated on this promise.
   */
  private _offscreenReady: Promise<void>;
  private _modelLoadFailed = false;

  /**
   * Init mutex: only one _initOffscreenInference() runs at a time.
   * Multiple callers await the same promise.
   */
  private _offscreenInitPromise: Promise<void> | null = null;

  /**
   * Phase 1 of handshake: resolves when OFFSCREEN_READY is received.
   * Separate from INFERENCE_INIT_RESULT -- do not conflate.
   */
  private _offscreenReadyResolve: (() => void) | null = null;
  private _offscreenReadyReject: ((err: Error) => void) | null = null;

  /**
   * Phase 2 of handshake: resolves when INFERENCE_INIT_RESULT arrives.
   */
  private _offscreenInitResolve: (() => void) | null = null;
  private _offscreenInitReject: ((err: Error) => void) | null = null;

  /**
   * Pending inference: resolves/rejects when INFERENCE_RESULT/ERROR arrives.
   * Resolves with the full InferenceResult (including timing fields).
   * Consumers extract .result for PerceptionResult and .transferDecodeMs,
   * .inferenceMs, .totalMs for timing instrumentation.
   */
  private _pendingInference: {
    resolve: (result: InferenceResult) => void;
    reject: (err: Error) => void;
  } | null = null;

  private _backend = 'unknown';

  /**
   * Persistent OFFSCREEN_READY state buffer.
   * Set true the moment OFFSCREEN_READY is received, regardless of whether
   * _waitForOffscreenReady() has installed its resolver yet. This eliminates
   * the race where READY arrives during _ensureOffscreenDocument() await.
   *
   * Reset to false only on deliberate disposal/recreation of the document.
   */
  private _offscreenReadyReceived = false;
  private _offscreenRuntimeInstanceId: string | null = null;

  // -- Firefox direct-load state ------------------------------------------
  private _loadedModels: LoadedModels | null = null;

  // P0-A: Pending confirmation authorizations.
  // Each entry represents a high-risk action awaiting user decision.
  // Invariant: an unapproved action executes ZERO times.
  private pendingConfirmations = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      sessionId: string;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  constructor() {
    // Determine execution environment
    const offscreenSupported =
      typeof chrome !== 'undefined' &&
      typeof chrome.offscreen !== 'undefined' &&
      typeof (chrome.offscreen as any).createDocument === 'function';

    if (offscreenSupported) {
      // Chrome MV3: delegate inference to offscreen document
      this._offscreenReady = this._initOffscreenInference();
    } else {
      // Firefox / environments without offscreen API: direct model loading
      this._offscreenReady = this._loadModelsDirectly();
    }
  }

  // ── Offscreen document management (Chrome) ───────────────────────────────

  /**
   * Create the offscreen document (singleton) and send INFERENCE_INIT.
   * Resolves when INFERENCE_INIT_RESULT { success:true } arrives.
   *
   * Chrome MV3 Offscreen reason: WORKERS
   * Justification: Local ONNX inference for privacy-critical browser
   * perception; raw screenshot data remains inside the extension.
   */
  // -- Offscreen document management (Chrome) ----------------------------

  /**
   * Full handshake: createDocument -> wait OFFSCREEN_READY -> send INFERENCE_INIT
   * -> wait INFERENCE_INIT_RESULT.
   *
   * Init mutex (_offscreenInitPromise) prevents concurrent inits.
   * All callers await the same promise.
   */
  private _initOffscreenInference(): Promise<void> {
    if (!this._offscreenInitPromise) {
      this._offscreenInitPromise = this._doOffscreenInit().catch((err) => {
        // Reset so next call can retry (e.g. after extension reload)
        this._offscreenInitPromise = null;
        throw err;
      });
    }
    return this._offscreenInitPromise;
  }

  private async _doOffscreenInit(): Promise<void> {
    console.log('[Coordinator] Creating offscreen inference document...');
    try {
      // Step 1: ensure document exists
      const existed = await this._ensureOffscreenDocument();

      // Step 2: wait for OFFSCREEN_READY (with timeout)
      // If document already existed, ping it first so it re-sends READY.
      if (existed) {
        console.log('[Coordinator] Offscreen document already existed -- sending OFFSCREEN_PING');
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
      }
      await this._waitForOffscreenReady(10000);
      console.log('[Coordinator] Offscreen READY received');

      // Step 3: send INFERENCE_INIT and await INFERENCE_INIT_RESULT
      await this._sendInferenceInit();

      console.log('[Coordinator] Perception ready -- all 4 ONNX models loaded offscreen');
    } catch (err) {
      this._modelLoadFailed = true;
      console.error('[Coordinator] Offscreen init failed -- fail-closed:', err);
      throw err;
    }
  }

  /** Singleton document creation. Returns true if it already existed. */
  private static _offscreenDocPromise: Promise<boolean> | null = null;

  private async _ensureOffscreenDocument(): Promise<boolean> {
    if (!Coordinator._offscreenDocPromise) {
      Coordinator._offscreenDocPromise = (async (): Promise<boolean> => {
        const exists = await (chrome.offscreen as any).hasDocument?.().catch(() => false);
        if (exists) {
          console.log('[Coordinator] Offscreen document already exists');
          return true;
        }
        await (chrome.offscreen as any).createDocument({
          url: chrome.runtime.getURL('offscreen.html'),
          reasons: ['WORKERS'],
          justification:
            'Local ONNX inference for privacy-critical browser perception; ' +
            'raw screenshot data remains inside the extension.',
        });
        console.log('[Coordinator] Offscreen document created');
        return false;
      })().catch((err) => {
        Coordinator._offscreenDocPromise = null;
        throw err;
      });
    }
    return Coordinator._offscreenDocPromise;
  }

  /**
   * Wait for OFFSCREEN_READY message from the offscreen document.
   * Rejects after timeoutMs with a fail-closed error.
   *
   * OFFSCREEN_READY != inference ready.
   * OFFSCREEN_READY only proves the message listener is registered.
   */
  /**
   * Wait for OFFSCREEN_READY message from the offscreen document.
   * Race-safe: if READY already arrived (buffered in _offscreenReadyReceived),
   * resolves immediately without installing a waiter.
   *
   * Rejects after timeoutMs if READY never arrives. Fail-closed.
   * OFFSCREEN_READY != inference ready.
   */
  private _waitForOffscreenReady(timeoutMs: number): Promise<void> {
    // Buffer check: READY may have arrived before this waiter was installed.
    // This eliminates the race where READY arrives during _ensureOffscreenDocument().
    if (this._offscreenReadyReceived) {
      console.log('[Coordinator] Offscreen READY already buffered -- instance=' +
        this._offscreenRuntimeInstanceId);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this._offscreenReadyResolve = resolve;
      this._offscreenReadyReject = reject;
      setTimeout(() => {
        if (this._offscreenReadyResolve) {
          console.error('[Coordinator] ❌ Offscreen READY timeout after ' + timeoutMs + 'ms');
          this._offscreenReadyResolve = null;
          this._offscreenReadyReject = null;
          reject(new Error('[Coordinator] Offscreen READY timeout -- fail-closed'));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send INFERENCE_INIT and await INFERENCE_INIT_RESULT.
   * Only called after OFFSCREEN_READY is confirmed.
   */
  private async _sendInferenceInit(): Promise<void> {
    const backend = await readBackendOverride();
    return new Promise<void>((resolve, reject) => {
      this._offscreenInitResolve = resolve;
      this._offscreenInitReject = reject;
      chrome.runtime.sendMessage({
        type: 'INFERENCE_INIT',
        requestedBackend: backend,
      });
    });
  }

  private async _loadModelsDirectly(): Promise<void> {
    console.log('[ModelLoader] Firefox direct load — no offscreen API');
    try {
      const models = await loadProductionModels();
      this.perception.registerOnnxModels(models);
      this._loadedModels = models;

      chrome.storage.local.set({
        modelBackend: models.backend,
        modelLoadedAt: new Date().toISOString(),
      }).catch(() => {});

      console.log('[Coordinator] ✅ Perception ready (direct load) — backend=' + models.backend);
    } catch (err) {
      this._modelLoadFailed = true;
      console.error('[ModelLoader] FAIL-CLOSED: Direct model load failed:', err);
      throw err;
    }
  }

  // ── Public readiness accessors ────────────────────────────

  /** True once all 4 ONNX models are ready (offscreen or direct). */
  get isPerceptionReady(): boolean {
    return !this._modelLoadFailed;
  }

  /** True if model loading failed (fail-closed state). */
  get isModelLoadFailed(): boolean {
    return this._modelLoadFailed;
  }

  /**
   * Await this to know when production models are ready.
   * Used by tests to verify the full initialization chain.
   */
  get modelReadiness(): Promise<LoadedModels> {
    return this._modelReadiness;
  }

  // ── Initialization ───────────────────────────────────────

  async initialize(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get(['coordinatorState', 'invalidatedObservationIds']);
      if (stored.coordinatorState) {
        this.state = { ...INITIAL_STATE, ...stored.coordinatorState };
        console.log('[Coordinator] Restored session:', this.state.sessionId);
      }
      // P1-G: Restore invalidated observation IDs across SW restart.
      // All observations that authorized a state-changing action must
      // remain invalidated for the entire logical session lifetime.
      if (Array.isArray(stored.invalidatedObservationIds)) {
        this._invalidatedObservationIds = new Set(stored.invalidatedObservationIds);
        console.log('[Coordinator] P1-G: Restored', this._invalidatedObservationIds.size,
          'invalidated observation IDs');
      }
    } catch {
      console.log('[Coordinator] Fresh start');
    }

    // Wait for offscreen inference runtime (or direct load for Firefox).
    // This ensures initialize() does not return until perception is ready.
    try {
      await this._offscreenReady;
      console.log('[Coordinator] ✅ Inference runtime ready');
    } catch (err) {
      console.error('[Coordinator] ❌ Inference runtime failed — coordinator in fail-closed state');
      // Do NOT re-throw — service worker lifecycle must complete.
    }

    // Load planner config from storage
    try {
      const config = await chrome.storage.local.get([
        'plannerMode',
        'plannerUrl',
      ]);
      if (config.plannerMode === 'server' && config.plannerUrl) {
        this.state.plannerMode = 'server';
        this.state.plannerUrl = config.plannerUrl;
        this.planner = new ServerPlannerAdapter(config.plannerUrl);
        this.verifier = new EgressVerifier({
          allowedPlannerOrigin: new URL(config.plannerUrl).origin,
        });
        console.log('[Coordinator] Server planner:', config.plannerUrl);
      }
    } catch {
      console.log('[Coordinator] Using deterministic planner');
    }
  }

  private async persistState(): Promise<void> {
    try {
      await chrome.storage.session.set({
        coordinatorState: this.state,
        // P1-G: Persist invalidated observation IDs alongside session state.
        // Stored as array for JSON serialization; restored as Set.
        invalidatedObservationIds: [...this._invalidatedObservationIds],
      });
    } catch (e) {
      console.warn('[Coordinator] Persist failed:', e);
      // P1-G: Rethrow so security-critical callers (observation
      // invalidation) can fail closed. Non-critical callers wrap
      // this in their own try/catch.
      throw e;
    }
  }

  // ── P1-E: Sender Authentication ──────────────────────────────
  //
  // Invariant: untrusted content-script / web page content must NEVER
  // be able to authorize a high-risk action.
  //
  // The coordinator authenticates the actual Chrome runtime sender,
  // NOT the claimed envelope.sender field.

  /**
   * Verify that the runtime sender is a trusted extension UI page
   * (e.g. popup.html). Used for CONFIRMATION_RESPONSE authorization.
   *
   * Checks:
   * 1. sender exists
   * 2. sender.id === chrome.runtime.id (same extension)
   * 3. sender.url starts with this extension's origin
   * 4. sender.url path matches a trusted UI page
   * 5. sender.tab is NOT set (extension pages don't have sender.tab;
   *    content scripts DO — this distinguishes them)
   */
  private _isTrustedExtensionUI(sender: chrome.runtime.MessageSender): boolean {
    if (!sender || !sender.id || !sender.url) return false;

    // Must be from the same extension package
    if (sender.id !== chrome.runtime.id) return false;

    // Content scripts have sender.tab — extension UI pages do NOT
    if (sender.tab) return false;

    // Verify the URL belongs to this extension's origin
    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    if (!sender.url.startsWith(extensionOrigin)) return false;

    // Verify the path matches a trusted UI page
    try {
      const senderPath = new URL(sender.url).pathname;
      if (!TRUSTED_UI_PATHS.includes(senderPath)) return false;
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Verify that the runtime sender is a trusted content-script
   * running in the active session tab. Used for ACTION_OUTCOME.
   *
   * Checks:
   * 1. sender exists
   * 2. sender.id === chrome.runtime.id (same extension)
   * 3. sender.tab exists (content scripts always have sender.tab)
   * 4. sender.tab.id === active session tab ID
   */
  private _isTrustedContentScript(sender: chrome.runtime.MessageSender): boolean {
    if (!sender || !sender.id) return false;

    // Must be from the same extension package
    if (sender.id !== chrome.runtime.id) return false;

    // Content scripts must have sender.tab
    if (!sender.tab || sender.tab.id === undefined) return false;

    // Must be from the active session tab
    if (sender.tab.id !== this.state.activeTabId) return false;

    return true;
  }

  /**
   * Verify that the runtime sender is the trusted offscreen document.
   * Used for OFFSCREEN_READY, INFERENCE_INIT_RESULT, INFERENCE_RESULT,
   * INFERENCE_ERROR.
   *
   * Checks:
   * 1. sender exists
   * 2. sender.id === chrome.runtime.id (same extension)
   * 3. sender.url starts with this extension's origin
   * 4. sender.url path === '/offscreen.html'
   * 5. sender.tab is NOT set (offscreen documents are extension pages)
   */
  private _isTrustedOffscreen(sender: chrome.runtime.MessageSender): boolean {
    if (!sender || !sender.id || !sender.url) return false;
    if (sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false;
    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    if (!sender.url.startsWith(extensionOrigin)) return false;
    try {
      const senderPath = new URL(sender.url).pathname;
      if (senderPath !== TRUSTED_OFFSCREEN_PATH) return false;
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Verify that the runtime sender is a trusted extension page
   * (UI or offscreen). Used for internal diagnostic messages like
   * SMOKE_OFFSCREEN_TEST.
   *
   * A trusted extension page has:
   * - sender.id === chrome.runtime.id
   * - sender.url starts with extension origin
   * - no sender.tab (extension pages, not content scripts)
   */
  private _isTrustedExtensionPage(sender: chrome.runtime.MessageSender): boolean {
    if (!sender || !sender.id || !sender.url) return false;
    if (sender.id !== chrome.runtime.id) return false;
    if (sender.tab) return false;
    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    return sender.url.startsWith(extensionOrigin);
  }

  /**
   * P1-F stale-pipeline guard: verify that an in-flight pipeline's
   * captured session+tab binding is still the current active binding.
   *
   * Returns true ONLY when:
   *   - this.state.isActive === true
   *   - this.state.sessionId === captured pipelineSessionId
   *   - this.state.activeTabId === captured pipelineTabId
   *
   * If the session was stopped, replaced, or the bound tab closed
   * during an async await, this returns false and the pipeline MUST
   * abort without executing any action or redeeming any token.
   */
  _isCurrentPipelineBinding(pipelineSessionId: string, pipelineTabId: number): boolean {
    return (
      this.state.isActive === true &&
      this.state.sessionId === pipelineSessionId &&
      this.state.activeTabId === pipelineTabId
    );
  }

  // -- Message handling ----------------------------------------------------

  handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): void {
    // STEP 1: Internal offscreen messages MUST be routed FIRST.
    // OFFSCREEN_READY, INFERENCE_INIT_RESULT, INFERENCE_RESULT, INFERENCE_ERROR
    // are NOT protocol-v2 MessageEnvelopes. Checking isValidMessageEnvelope()
    // before this gate rejects them silently, causing OFFSCREEN_READY timeout.
    if (isOffscreenToSwMessage(message)) {
      // P1-E: Offscreen messages must originate from the trusted offscreen document
      if (!this._isTrustedOffscreen(sender)) {
        console.warn('[Coordinator] P1-E: Offscreen message rejected — untrusted sender',
          { id: sender?.id, url: sender?.url, tab: sender?.tab?.id });
        sendResponse({ ack: false, error: 'Untrusted sender for offscreen message' });
        return;
      }
      this._handleOffscreenMessage(message);
      sendResponse({ ack: true });
      return;
    }

    // STEP 2a: Privileged internal diagnostic messages.
    // SMOKE_OFFSCREEN_TEST is an internal extension diagnostic -- it carries
    // no user data, screenshot data, tokens, or arbitrary payload.
    // It is NOT a protocol-v2 envelope and must be routed explicitly.
    // Only this exact type string is admitted. Any other non-envelope,
    // non-offscreen message still hits the rejection below.
    if (isSmokeOffscreenTestMessage(message)) {
      // P1-E: Smoke test must originate from a trusted extension page
      if (!this._isTrustedExtensionPage(sender)) {
        console.warn('[Coordinator] P1-E: Smoke test rejected — untrusted sender');
        sendResponse({ ack: false, error: 'Untrusted sender' });
        return;
      }
      this.handleSmokeOffscreenTest(sendResponse);
      return;
    }

    // STEP 2: All other messages must be valid protocol-v2 envelopes.
    if (!isValidMessageEnvelope(message)) {
      sendResponse({ error: 'Invalid message envelope' });
      return;
    }

    const msg = message as MessageEnvelope;

    // STEP 3: Dispatch by protocol-v2 message type.
    switch (msg.type) {
      case MESSAGE_TYPES.USER_TASK:
        // P1-E: USER_TASK must originate from trusted extension UI
        if (!this._isTrustedExtensionUI(sender)) {
          console.warn('[Coordinator] P1-E: USER_TASK rejected — untrusted sender',
            { id: sender?.id, url: sender?.url, tab: sender?.tab?.id });
          sendResponse({ ack: false, error: 'Untrusted sender' });
          break;
        }
        this.handleUserTask(msg.payload as UserTaskPayload, sendResponse);
        break;

      case MESSAGE_TYPES.SESSION_CONTROL:
        // P1-E: SESSION_CONTROL must originate from trusted extension UI
        if (!this._isTrustedExtensionUI(sender)) {
          console.warn('[Coordinator] P1-E: SESSION_CONTROL rejected — untrusted sender',
            { id: sender?.id, url: sender?.url, tab: sender?.tab?.id });
          sendResponse({ ack: false, error: 'Untrusted sender' });
          break;
        }
        this.handleSessionControl(
          msg.payload as SessionControlPayload,
          sendResponse,
        );
        break;

      case MESSAGE_TYPES.CONTENT_READY:
        this.handleContentReady(
          msg.payload as ContentReadyPayload,
          sender,
          sendResponse,
        );
        break;

      case MESSAGE_TYPES.CONFIRMATION_RESPONSE:
        // P1-E: CONFIRMATION_RESPONSE must originate from trusted extension UI
        if (!this._isTrustedExtensionUI(sender)) {
          console.warn('[Coordinator] P1-E: CONFIRMATION_RESPONSE rejected — untrusted sender',
            { id: sender?.id, url: sender?.url, tab: sender?.tab?.id });
          sendResponse({ ack: false, error: 'Untrusted sender' });
          break;
        }
        this.handleConfirmationResponse(
          msg.payload as ConfirmationResponsePayload,
          sender,
          sendResponse,
        );
        break;

      case MESSAGE_TYPES.ACTION_OUTCOME:
        // P1-E: ACTION_OUTCOME must originate from trusted content-script in active session tab
        if (!this._isTrustedContentScript(sender)) {
          console.warn('[Coordinator] P1-E: ACTION_OUTCOME rejected — untrusted sender',
            { id: sender?.id, url: sender?.url, tab: sender?.tab?.id });
          sendResponse({ ack: false, error: 'Untrusted sender' });
          break;
        }
        this.handleActionOutcome(
          msg.payload as ActionOutcomePayload,
          sender,
          sendResponse,
        );
        break;

      case MESSAGE_TYPES.DOM_SNAPSHOT:
        sendResponse({ ack: true });
        break;

      default:
        sendResponse({ ack: true });
    }
  }

  // ── Offscreen message router ──────────────────────────────────────────────

  private _handleOffscreenMessage(message: unknown): void {

    // -- Phase 1: OFFSCREEN_READY ------------------------------------------
    // Sent by offscreen.ts immediately after its onMessage listener is
    // registered. This proves the listener is live before INFERENCE_INIT.
    // OFFSCREEN_READY != inference ready.
    //
    // BUFFER: _offscreenReadyReceived is set immediately on arrival, even if
    // _waitForOffscreenReady() has not yet installed its resolver. This
    // eliminates the race where READY arrives during _ensureOffscreenDocument().
    //
    // IDEMPOTENT: multiple READY messages from the same instance are harmless.
    // A new instance ID updates _offscreenRuntimeInstanceId.
    if ((message as any)?.type === 'OFFSCREEN_READY') {
      const rid = (message as any).runtimeInstanceId ?? 'unknown';
      console.log('[Coordinator] Offscreen READY received -- instance=' + rid);

      // Buffer the READY signal -- survives race with _waitForOffscreenReady()
      this._offscreenReadyReceived = true;
      this._offscreenRuntimeInstanceId = rid;

      // If a waiter is already installed, resolve it now.
      // If not installed yet, _waitForOffscreenReady() will see the buffer.
      if (this._offscreenReadyResolve) {
        this._offscreenReadyResolve();
        this._offscreenReadyResolve = null;
        this._offscreenReadyReject = null;
      }
      return;
    }

    // -- Phase 2: INFERENCE_INIT_RESULT -----------------------------------
    if (isInferenceInitResult(message)) {
      const r = message as InferenceInitResult;
      if (r.success) {
        this.perception['_initialized'] = true;
        this._backend = r.backend;
        chrome.storage.local.set({
          modelBackend: r.backend,
          modelLoadedAt: new Date().toISOString(),
        }).catch(() => {});
        console.log('[Coordinator] Offscreen inference ready -- backend=' +
          r.backend + ' initMs=' + r.initMs);
        this._offscreenInitResolve?.();
      } else {
        const err = new Error(r.error ?? 'Offscreen inference init failed');
        this._offscreenInitReject?.(err);
      }
      this._offscreenInitResolve = null;
      this._offscreenInitReject = null;
      return;
    }

    // -- Inference result -------------------------------------------------
    if (isInferenceResult(message)) {
      try {
        assertInferenceResultTrustBoundary(message as InferenceResult);
      } catch (boundaryErr: any) {
        console.error('[Coordinator] TRUST BOUNDARY VIOLATION:', boundaryErr.message);
        this._pendingInference?.reject(boundaryErr);
        this._pendingInference = null;
        return;
      }
      const ir = message as InferenceResult;
      console.log('[Coordinator] Inference result:', {
        backend: ir.backend,
        transferDecodeMs: ir.transferDecodeMs,
        inferenceMs: ir.inferenceMs,
        totalMs: ir.totalMs,
      });
      this._pendingInference?.resolve(ir);
      this._pendingInference = null;
      return;
    }

    // -- Inference error --------------------------------------------------
    if (isInferenceError(message)) {
      const ie = message as any;
      console.error('[Coordinator] INFERENCE_ERROR from offscreen:', ie.error);
      this._modelLoadFailed = true;
      const err = new Error(ie.error ?? 'Offscreen inference error');
      this._pendingInference?.reject(err);
      this._offscreenInitReject?.(err);
      this._offscreenReadyReject?.(err);
      this._pendingInference = null;
      this._offscreenInitResolve = null;
      this._offscreenInitReject = null;
      this._offscreenReadyResolve = null;
      this._offscreenReadyReject = null;
      // Reset ready buffer: offscreen document is dead after a fatal error.
      // Next lifecycle must receive a fresh OFFSCREEN_READY.
      this._offscreenReadyReceived = false;
      this._offscreenRuntimeInstanceId = null;
      this._offscreenInitPromise = null;
    }
  }

  // ── Full pipeline ────────────────────────────────────────

  private async handleUserTask(
    payload: UserTaskPayload,
    sendResponse: (response: unknown) => void,
  ): Promise<void> {
    console.log('[Coordinator] ═══ Pipeline Start ═══');
    const pipelineStart = performance.now();

    // -- Readiness gate --
    // Ensures no user task can enter perception before the inference
    // runtime (offscreen document or Firefox direct) is fully ready.
    if (this._modelLoadFailed) {
      console.error('[Coordinator] FAIL-CLOSED: Inference runtime failed. Task rejected.');
      sendResponse({
        error: 'Inference runtime failed. Extension must be reloaded.',
        failClosed: true,
      });
      return;
    }
    try {
      await this._offscreenReady;
    } catch {
      sendResponse({
        error: 'Inference runtime failed. Extension must be reloaded.',
        failClosed: true,
      });
      return;
    }

    if (!this.state.isActive) {
      await this.startSession(payload.tabId);
    } else {
      // P1-F: Session-bound tab enforcement.
      // An action observed, planned, authorized, confirmed, or capability-bound
      // for Tab A MUST NEVER execute against Tab B.
      // If the session is already bound to a tab, reject any USER_TASK with a
      // different tabId. This prevents cross-tab confused-deputy attacks.
      if (payload.tabId !== this.state.activeTabId) {
        console.error(
          '[Coordinator] P1-F: CROSS-TAB REJECTED — session bound to tab',
          this.state.activeTabId, 'but payload claims tab', payload.tabId,
        );
        sendResponse({
          ack: false,
          error: `P1-F: session bound to tab ${this.state.activeTabId}, rejecting tab ${payload.tabId}`,
        });
        return;
      }
    }

    // P1-F: All downstream operations MUST use the session-bound tab ID,
    // never the payload's claimed tabId. This is the authoritative binding.
    const sessionTabId = this.state.activeTabId!;
    // P1-F stale-pipeline defense: snapshot BOTH session ID and tab ID.
    // If the session is stopped/replaced during async pipeline execution,
    // the guard detects the mismatch and aborts the stale pipeline.
    const pipelineSessionId = this.state.sessionId!;

    try {
      // ── Step 1: Capture visible tab ─────────────────────
      this.setPhase('capturing');
      const captureResult = await this.capture.captureVisibleTab(
        sessionTabId,
      );
      console.log('[Coordinator] [1/8] Captured:', {
        obs: captureResult.observationId,
        tiles: captureResult.tileCount,
        changed: captureResult.changedTileIds.length,
        bytes: captureResult.imageDataUrl.length,
      });

      // P1-F stale-pipeline check: after capture await
      if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
        console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed during capture');
        sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated during capture' });
        this.setPhase('idle');
        return;
      }

      // P1-G: Stale observation check.
      // After a state-changing action, the observation that authorized it is
      // marked invalid. If the capture returns the same observationId (e.g.
      // due to cache race or replay), reject immediately.
      // A new observation MUST have a distinct observationId.
      if (this._invalidatedObservationIds.has(captureResult.observationId as string)) {
        console.error('[Coordinator] P1-G: STALE OBSERVATION — obs',
          captureResult.observationId, 'was invalidated by prior state change');
        sendResponse({
          ack: false,
          error: `P1-G: observation ${captureResult.observationId} already consumed by a state-changing action`,
        });
        this.setPhase('idle');
        return;
      }

      // ── Step 2: Request DOM harvest + canvas context ─────
      const harvestResult = await this.requestHarvest(
        sessionTabId,
        captureResult.observationId,
      );
      console.log('[Coordinator] [2/8] Harvested:', {
        nodes: harvestResult?.nodeCount || 0,
        canvasTexts: harvestResult?.canvasContext?.canvasTexts?.length || 0,
        faceRegions: harvestResult?.canvasContext?.faceRegions?.length || 0,
        controlRegions: harvestResult?.canvasContext?.controlRegions?.length || 0,
      });

      // P1-F stale-pipeline check: after harvest await
      if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
        console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed during harvest');
        sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated during harvest' });
        this.setPhase('idle');
        return;
      }

      // -- Step 3: Perception --
      // Chrome: send imageDataUrl (PNG string) to offscreen document.
      //         Offscreen decodes via OffscreenCanvas, runs ORT.
      //         Awaits INFERENCE_RESULT via _pendingInference promise.
      // Firefox: decode in-process, call perception.run() directly.
      this.setPhase('perceiving' as any);
      const perceptionStart = performance.now();

      // Build tile rects from changed tile IDs
      const changedTileRects = this.buildTileRects(
        captureResult.changedTileIds,
        captureResult.width,
        captureResult.height,
      );

      const canvasCtx: CanvasRegionData = {
        canvasTexts: harvestResult?.canvasContext?.canvasTexts || [],
        faceRegions: harvestResult?.canvasContext?.faceRegions || [],
        controlRegions: harvestResult?.canvasContext?.controlRegions || [],
      };

      let perceptionResult: PerceptionResult | null = null;

      if (this._loadedModels) {
        // Firefox direct path: pipeline runs in-process
        let imageData: ImageData | null = null;
        try {
          imageData = await this.dataUrlToImageData(
            captureResult.imageDataUrl,
            captureResult.width,
            captureResult.height,
          );
        } catch (e) {
          console.warn('[Coordinator] ImageData decode failed, skipping perception:', e);
        }
        if (imageData) {
          perceptionResult = await this.perception.run(
            imageData,
            changedTileRects,
            captureResult.observationId as string,
            0,
            captureResult.stamp.documentGeneration,
            canvasCtx,
          );
        }
      } else {
        // Chrome offscreen path: send PNG data URL to offscreen document.
        // The string is passed as-is -- not serialized as bytes.
        // Offscreen decodes via createImageBitmap + OffscreenCanvas.
        const offscreenResult = await new Promise<InferenceResult>((resolve, reject) => {
          this._pendingInference = { resolve, reject };
          const msg: InferenceRunMessage = {
            type: 'INFERENCE_RUN',
            imageDataUrl: captureResult.imageDataUrl,
            changedTiles: changedTileRects,
            observationId: captureResult.observationId as string,
            frameId: 0,
            documentGeneration: captureResult.stamp.documentGeneration,
            canvasContext: canvasCtx,
            captureWidth: captureResult.width,
            captureHeight: captureResult.height,
          };
          chrome.runtime.sendMessage(msg);
        });
        perceptionResult = offscreenResult.result;
        console.log('[Coordinator] Offscreen inference timing:', {
          transferDecodeMs: offscreenResult.transferDecodeMs,
          inferenceMs: offscreenResult.inferenceMs,
          totalMs: offscreenResult.totalMs,
        });
      }

      const perceptionMs = Math.round(performance.now() - perceptionStart);
      if (perceptionResult) {
        console.log('[Coordinator] [3/8] Perception complete:', {
          totalMs: perceptionMs,
          textRegions: perceptionResult.textRegions.length,
          ocrResults: perceptionResult.ocrResults.length,
          faceDetections: perceptionResult.faceDetections.length,
          semanticRegions: perceptionResult.semanticRegions.length,
          groundings: perceptionResult.groundings.length,
          modelsInvoked: perceptionResult.metrics.length,
          groundedTargets: perceptionResult.groundings.filter(g => g.candidateTargetId !== null).length,
        });
      } else {
        console.log('[Coordinator] [3/8] Perception skipped (no image data)');
      }

      // P1-F stale-pipeline check: after perception await
      if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
        console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed during perception');
        sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated during perception' });
        this.setPhase('idle');
        return;
      }
      // ── Step 4: Build unified scene graph ──────────────────
      // Merge DOM nodes with visual-only nodes from perception
      const domNodes: SceneNode[] = harvestResult?.nodes || [];
      const visualNodes: SceneNode[] = perceptionResult
        ? this.groundingsToSceneNodes(
            perceptionResult,
            captureResult.observationId as string,
            captureResult.stamp.documentGeneration,
          )
        : [];

      const unifiedNodes = [...domNodes, ...visualNodes];
      console.log('[Coordinator] [4/8] Unified scene:', {
        domNodes: domNodes.length,
        visualNodes: visualNodes.length,
        total: unifiedNodes.length,
      });

      // ── Step 5: Sanitize unified scene ─────────────────────
      this.setPhase('sanitizing');
      const sanitized = this.sanitizer.sanitize(
        payload.rawTask,
        unifiedNodes,
        this.state.sessionId!,
        sessionTabId,
        0, // frameId
        captureResult.stamp.documentGeneration,
        captureResult.stamp.topOrigin,
      );

      // Update visual coverage based on perception results
      const visualCoverage = perceptionResult && perceptionResult.groundings.length > 0
        ? 'full' as const
        : perceptionResult ? 'partial' as const : 'none' as const;
      sanitized.scene.coverage.visualGrounding = visualCoverage;

      console.log('[Coordinator] [5/8] Sanitized:', {
        redactions: sanitized.redactions.length,
        nodes: sanitized.scene.nodes.length,
        risk: sanitized.risk,
        visualCoverage,
      });

      // ── Step 6: Build planner request ────────────────────
      const plannerRequest: PlannerRequestInput = {
        protocolVersion: '2.0',
        session: {
          id: this.state.sessionId!,
          step: this.state.step,
          observationId: captureResult.observationId as string,
          origin: captureResult.stamp.topOrigin,
          documentGeneration: captureResult.stamp.documentGeneration,
          viewport: {
            width: captureResult.stamp.viewportWidth,
            height: captureResult.stamp.viewportHeight,
            devicePixelRatio: captureResult.stamp.devicePixelRatio,
          },
        },
        task: {
          sanitized: sanitized.sanitizedTask,
          risk: sanitized.risk,
        },
        scene: sanitized.scene,
        redactions: sanitized.redactions,
        protectedVisualRegions:
          sanitized.protectedVisualRegions.length > 0
            ? sanitized.protectedVisualRegions
            : undefined,
        allowedActions: [...ALLOWED_ACTION_KINDS],
      };

      // INVARIANT: raw visual observations MUST NOT be in plannerRequest
      // Raw imageData, ocrResults, faceDetections are local-only
      // Only sanitized tokens and scene graph enter the egress verifier.

      // ── Step 7: Egress verification ──────────────────────
      this.setPhase('verifying');
      const verification = await this.verifier.verify(
        plannerRequest,
        this.state.plannerUrl || 'http://localhost:8000/plan',
      );

      if (!verification.approved) {
        const block = verification as { reason: string; category: string };
        console.error('[Coordinator] [7/8] EGRESS BLOCKED:', block.reason);
        sendResponse({
          ack: false,
          error: `Egress blocked: ${block.reason}`,
          category: block.category,
        });
        this.setPhase('idle');
        return;
      }

      console.log('[Coordinator] [7/8] Egress approved:', {
        sealSize: (verification as any).serializedSize,
        bodyHash: (verification as any).bodyHash?.substring(0, 16) + '…',
      });

      // P1-F stale-pipeline check: after egress verification await
      if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
        console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed during egress verification');
        sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated during egress verification' });
        this.setPhase('idle');
        return;
      }

      // ── Step 8: Plan ─────────────────────────────────────
      this.setPhase('planning');
      let plannerResponse: PlannerResponse;

      try {
        plannerResponse = await this.planner.plan(plannerRequest);
        console.log('[Coordinator] [8/8] Plan received:', {
          planId: plannerResponse.planId,
          actions: plannerResponse.actions.length,
          kinds: plannerResponse.actions.map((a) => a.kind),
        });
      } catch (e) {
        console.error('[Coordinator] [8/8] Planning failed:', e);
        sendResponse({ ack: false, error: `Planning failed: ${e}` });
        this.setPhase('idle');
        return;
      }

      // ── Validate plan ────────────────────────────────────
      const nodeIds = new Set(
        sanitized.scene.nodes.map((n) => n.id),
      );

      // P1-C: Build target fingerprints from harvested scene nodes
      // Uses ancestryFingerprint which is the canonical ancestry string
      // produced by getAncestorTags().join('>') during harvesting.
      const targetFingerprints = new Map<string, TargetFingerprint>();
      for (const node of (harvestResult?.nodes || [])) {
        if (node && node.id) {
          targetFingerprints.set(node.id, createTargetFingerprint(
            node.id,
            node.role || '',
            node.name || '',
            node.ancestryFingerprint || '',
            node.bbox || { x: 0, y: 0, w: 0, h: 0 },
            node.frameId ?? 0,
            node.documentGeneration || captureResult.stamp.documentGeneration,
            (node.observationId || captureResult.observationId) as string,
          ));
        }
      }

      const currentFreshness = {
        sessionId: this.state.sessionId!,
        tabId: sessionTabId,
        frameId: 0,
        documentGeneration: captureResult.stamp.documentGeneration,
        viewportFingerprint: `${captureResult.width}x${captureResult.height}`,
        observationId: captureResult.observationId,
        origin: captureResult.stamp.topOrigin,
        createdAt: new Date().toISOString(),
      };

      const sceneContext: SceneContext = {
        nodeIds,
        freshness: currentFreshness,
        targetFingerprints,
        planObservationId: captureResult.observationId as string,
        tokenValidator: (token: string) => this.vault.hasToken(token),
      };

      const validation = validatePlan(
        plannerResponse.actions,
        sceneContext,
      );

      if (!validation.valid) {
        const errors = validation.validations
          .flatMap((v) => v.errors)
          .join('; ');
        console.error('[Coordinator] Plan validation failed:', errors);
        sendResponse({ ack: false, error: `Plan invalid: ${errors}` });
        this.setPhase('idle');
        return;
      }

      // P1-F stale-pipeline check: after planner await
      if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
        console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed during planning');
        sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated during planning' });
        this.setPhase('idle');
        return;
      }

      // ── ONE ACTION → RE-OBSERVE (contract §1.5) ──────────
      // Execute ONLY the first state-changing action.
      // Non-state-changing actions (scroll, wait, finish) can be batched.
      // P0-A: Confirmation is checked per-action immediately before execution.
      this.setPhase('executing');
      let executedStateChangingAction = false;
      let executedActionCount = 0;

      for (let actionIdx = 0; actionIdx < plannerResponse.actions.length; actionIdx++) {
        const action = plannerResponse.actions[actionIdx];
        const actionValidation = validation.validations[actionIdx];
        const isStateChanging = STATE_CHANGING_ACTIONS.has(action.kind);

        // P0-A: If this action requires confirmation, block until authorized
        if (actionValidation?.requiresConfirmation) {
          this.setPhase('confirming');
          console.log('[Coordinator] P0-A: Requesting confirmation for', action.kind, action.id);
          const approved = await this.requestConfirmation(action);
          if (!approved) {
            console.log('[Coordinator] P0-A: Action REJECTED or timed out:', action.id);
            sendResponse({ ack: false, error: `Action ${action.kind} rejected by user` });
            this.setPhase('idle');
            return;
          }
          console.log('[Coordinator] P0-A: Action APPROVED:', action.id);
          this.setPhase('executing');

          // P1-F stale-pipeline check: after confirmation await
          if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
            console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed during confirmation');
            sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated during confirmation' });
            this.setPhase('idle');
            return;
          }
        }

        // P1-C: FINAL FRESHNESS CHECK — immediately before execution
        // This runs AFTER confirmation (P0-A) and BEFORE execution.
        // A user approval MUST NOT substitute for freshness validation.
        //
        // For target-bound actions: query the content script for the CURRENT
        // state of the exact harvested element (P0-B registry lookup).
        // Compare against original fingerprint to detect DOM mutations.
        const targetNodeId = 'targetNodeId' in action ? action.targetNodeId : undefined;
        let verifiedFingerprint: TargetFingerprint | undefined;

        if (targetNodeId) {
          try {
            const verifyResult = await chrome.tabs.sendMessage(
              sessionTabId,
              createMessage(
                MESSAGE_TYPES.VERIFY_TARGET,
                { nodeId: targetNodeId },
                'background',
              ),
            ) as { found?: boolean; error?: string;
                    fingerprint?: TargetFingerprint };

            if (!verifyResult || !verifyResult.found || !verifyResult.fingerprint) {
              const reason = verifyResult?.error || 'Target element no longer exists';
              console.error('[Coordinator] P1-C: TARGET LOST:', reason);
              sendResponse({ ack: false, error: `Target lost: ${reason}` });
              this.setPhase('idle');
              return;
            }

            verifiedFingerprint = verifyResult.fingerprint;

            // Compare current fingerprint against original harvest fingerprint
            const originalFp = targetFingerprints.get(targetNodeId);
            if (originalFp) {
              const mismatch = verifyTargetFingerprint(originalFp, verifiedFingerprint);
              if (mismatch) {
                console.error('[Coordinator] P1-C: TARGET STALE:', mismatch);
                sendResponse({ ack: false, error: `Stale target: ${mismatch}` });
                this.setPhase('idle');
                return;
              }
            }
          } catch (verifyErr) {
            // Content script unreachable → fail closed
            console.error('[Coordinator] P1-C: VERIFY_TARGET failed (fail closed):', verifyErr);
            sendResponse({ ack: false, error: 'Target verification failed — content script unreachable' });
            this.setPhase('idle');
            return;
          }
        }

        const freshnessError = checkActionFreshness(
          action,
          currentFreshness,
          plannerResponse.observationId,
          targetFingerprints,
        );
        if (freshnessError) {
          console.error('[Coordinator] P1-C: STALE ACTION REJECTED:', freshnessError);
          sendResponse({ ack: false, error: `Stale action: ${freshnessError}` });
          this.setPhase('idle');
          return;
        }

        if (isStateChanging && executedStateChangingAction) {
          // Contract §1.5: stop after first state-changing action
          // The next pipeline invocation will re-observe and replan
          console.log('[Coordinator] One-action boundary: halting at', action.kind, '(re-observe required)');
          break;
        }

        // P1-F stale-pipeline check: immediately before action execution
        if (!this._isCurrentPipelineBinding(pipelineSessionId, sessionTabId)) {
          console.error('[Coordinator] P1-F: STALE PIPELINE — session/tab changed before execution of', action.kind);
          sendResponse({ ack: false, error: 'P1-F: stale pipeline — session invalidated before execution' });
          this.setPhase('idle');
          return;
        }

        console.log('[Coordinator] Executing:', action.kind, action.id);
        await this.executeAction(
          sessionTabId,
          action,
          captureResult.stamp.documentGeneration,
          captureResult.stamp.topOrigin,
          verifiedFingerprint,
        );
        executedActionCount++;

        if (isStateChanging) {
          executedStateChangingAction = true;
          // P1-G: Mark this observation as consumed/invalidated.
          // No subsequent pipeline may reuse this observationId for a
          // state-changing action. The next pipeline MUST capture a
          // fresh observation with a distinct observationId.
          this._invalidatedObservationIds.add(captureResult.observationId as string);
          // Invalidate cache so next invocation re-observes
          this.capture.invalidateCache();
          // P1-G: Persist invalidation state so it survives SW restart.
          // Fail closed: if persistence fails, abort the pipeline.
          try {
            await this.persistState();
          } catch (persistErr) {
            console.error('[Coordinator] P1-G: FAIL CLOSED — could not persist invalidated observation:', persistErr);
            sendResponse({ ack: false, error: 'P1-G: failed to persist observation invalidation state' });
            this.setPhase('idle');
            return;
          }
          console.log('[Coordinator] P1-G: Observation', captureResult.observationId,
            'invalidated after state-changing action — re-observation required');
        }

        // finish/request_observation terminate the sequence
        if (action.kind === 'finish' || action.kind === 'request_observation') break;
      }

      this.state.lastObservationId = captureResult.observationId as string;
      this.state.step += 1;

      const pipelineMs = Math.round(performance.now() - pipelineStart);
      console.log(`[Coordinator] ═══ Pipeline Done (${pipelineMs}ms) ═══`);

      this.setPhase('idle');
      try { await this.persistState(); } catch { /* best-effort for pipeline completion */ }

      sendResponse({
        ack: true,
        observationId: captureResult.observationId,
        captureHash: captureResult.stamp.hash,
        redactions: sanitized.redactions.length,
        planId: plannerResponse.planId,
        actions: plannerResponse.actions.length,
        executedActions: executedActionCount,
        visualGrounding: {
          groundings: perceptionResult?.groundings.length || 0,
          faceDetections: perceptionResult?.faceDetections.length || 0,
          ocrResults: perceptionResult?.ocrResults.length || 0,
          perceptionMs: perceptionResult ? Math.round(perceptionResult.totalMs) : 0,
        },
        pipelineMs,
      });
    } catch (e) {
      console.error('[Coordinator] Pipeline error:', e);
      this.setPhase('idle');
      try { await this.persistState(); } catch { /* best-effort in error path */ }
      sendResponse({ error: `Pipeline failed: ${e}` });
    }
  }

  // ── Content script communication ─────────────────────────

  private async requestHarvest(
    tabId: number,
    observationId: string,
  ): Promise<any> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, createMessage(
        MESSAGE_TYPES.REQUEST_SNAPSHOT,
        { observationId },
        'background',
      ));
      return response;
    } catch (e) {
      console.warn('[Coordinator] Harvest request failed:', e);
      return null;
    }
  }

  private async executeAction(
    tabId: number,
    action: any,
    documentGeneration: string,
    origin: string,
    expectedFingerprint?: TargetFingerprint,
  ): Promise<void> {
    try {
      // ── type_token: TWO-PHASE REDEMPTION ─────────────────────
      //
      // P1-C invariant: content-side TOCTOU failure MUST occur
      // BEFORE the vault token is redeemed.
      //
      // Phase 1: Send EXECUTE_ACTION with deferredRedemption=true
      //          (no raw value). Content does TOCTOU check and
      //          responds with { toctouPassed: true/false }.
      //
      // Phase 2: Only if toctouPassed, redeem token and send
      //          DELIVER_TOKEN_VALUE with the raw value.
      //
      if (action.kind === 'type_token' && action.token) {
        // Phase 1: TOCTOU verification (NO redemption yet)
        const toctouResponse = await chrome.tabs.sendMessage(tabId, createMessage(
          MESSAGE_TYPES.EXECUTE_ACTION,
          {
            actionId: action.id,
            kind: 'type_token',
            targetNodeId: action.targetNodeId,
            // NO value — deferred redemption
            deferredRedemption: true,
            tokenRef: action.token,
            expectedRole: action.expectedRole,
            expectedFingerprint,
          },
          'background',
        )) as { toctouPassed?: boolean; error?: string };

        if (!toctouResponse || !toctouResponse.toctouPassed) {
          console.error('[Coordinator] P1-C: type_token TOCTOU failed — vault NOT redeemed:',
            toctouResponse?.error || 'unknown');
          return; // Token NOT redeemed — safe
        }

        // Phase 2: TOCTOU passed → redeem token now
        const redemption = this.redeemTokenForAction(
          action.token,
          action.targetNodeId || '',
          documentGeneration,
          origin,
        );
        if ('error' in redemption) {
          console.error('[Coordinator] Token redemption failed:', redemption.error);
          return;
        }
        console.log('[Coordinator] Token redeemed AFTER content-side TOCTOU passed');

        // Deliver the redeemed value to content for DOM mutation
        await chrome.tabs.sendMessage(tabId, createMessage(
          MESSAGE_TYPES.DELIVER_TOKEN_VALUE,
          {
            actionId: action.id,
            targetNodeId: action.targetNodeId,
            value: redemption.value,
            expectedFingerprint,
          },
          'background',
        ));
        return;
      }

      // ── All other actions: single-phase execution ────────────
      let resolvedValue: string | undefined;
      if (action.kind === 'type_text') {
        resolvedValue = action.text;
      }

      await chrome.tabs.sendMessage(tabId, createMessage(
        MESSAGE_TYPES.EXECUTE_ACTION,
        {
          actionId: action.id,
          kind: action.kind,
          targetNodeId: action.targetNodeId,
          value: resolvedValue,
          expectedRole: action.expectedRole,
          expectedFingerprint,
        },
        'background',
      ));
    } catch (e) {
      console.warn('[Coordinator] Action execution failed:', e);
    }
  }

  /**
   * Redeem a vault token for an authorized action.
   * TOKEN REFERENCE → LOCAL VAULT → AUTHORIZED ACTION → REAL VALUE
   * (contract §12)
   */
  private redeemTokenForAction(
    token: string,
    targetNodeId: string,
    documentGeneration: string,
    origin: string,
  ): { value: string } | { error: string } {
    const grant = this.vault.getGrant(token);
    if (!grant) return { error: 'GRANT_NOT_FOUND' };

    return this.vault.redeem(
      token,
      grant.sessionId,
      grant.tabId,
      grant.frameId,
      documentGeneration,
      origin,
      targetNodeId,
      grant.permittedOperation,
      grant.actionNonce,
    );
  }

  // ── P0-A: Confirmations ─────────────────────────────────
  //
  // Invariant: an unapproved, rejected, unknown, stale-session,
  // duplicate, timed-out, or failed-dispatch high-risk action
  // must execute ZERO times.

  /**
   * Request user confirmation for a high-risk action.
   *
   * Returns a Promise<boolean> that resolves:
   *   true  → user approved (execute exactly once)
   *   false → user rejected / timeout / dispatch failure / session ended
   *
   * The pending entry is created BEFORE dispatching the message.
   * Dispatch failure resolves false immediately (fail closed).
   * Duplicate pending actionId fails closed without overwriting.
   */
  private requestConfirmation(action: AgentAction): Promise<boolean> {
    const actionId = action.id;

    // Enforce non-empty actionId
    if (!actionId || typeof actionId !== 'string' || actionId.trim() === '') {
      console.error('[Coordinator] P0-A: Empty actionId — rejecting');
      return Promise.resolve(false);
    }

    // Duplicate pending actionId must fail closed, never overwrite
    if (this.pendingConfirmations.has(actionId)) {
      console.error('[Coordinator] P0-A: Duplicate pending actionId', actionId, '— rejecting');
      return Promise.resolve(false);
    }

    const sessionId = this.state.sessionId;
    if (!sessionId) {
      console.error('[Coordinator] P0-A: No active session — rejecting');
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      // Timeout: fail closed after CONFIRMATION_TIMEOUT_MS
      const timeoutId = setTimeout(() => {
        if (this.pendingConfirmations.has(actionId)) {
          console.warn('[Coordinator] P0-A: Confirmation TIMEOUT for', actionId);
          this.pendingConfirmations.delete(actionId);
          resolve(false);
        }
      }, CONFIRMATION_TIMEOUT_MS);

      // Insert pending entry BEFORE dispatching the message
      this.pendingConfirmations.set(actionId, { resolve, sessionId, timeoutId });

      // Build confirmation payload — NEVER includes raw vault values
      const payload: ConfirmationRequestPayload = {
        actionId,
        actionKind: action.kind,
        targetDescription: action.reason || action.kind,
        risk: 'high',
      };

      // Dispatch to UI — handle failure by resolving false
      chrome.runtime
        .sendMessage(createMessage(
          MESSAGE_TYPES.CONFIRMATION_REQUEST,
          payload,
          'background',
        ))
        .catch((err) => {
          console.error('[Coordinator] P0-A: Dispatch failed for', actionId, err);
          const pending = this.pendingConfirmations.get(actionId);
          if (pending) {
            clearTimeout(pending.timeoutId);
            this.pendingConfirmations.delete(actionId);
            resolve(false);
          }
        });
    });
  }

  /**
   * Handle a confirmation response from the UI.
   *
   * Security checks:
   * - Unknown actionId → ignored (no authorization)
   * - Stale session → rejected (fail closed)
   * - Duplicate response → no-op (entry already deleted)
   */
  private handleConfirmationResponse(
    payload: ConfirmationResponsePayload,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): void {
    const pending = this.pendingConfirmations.get(payload.actionId);

    if (!pending) {
      // Unknown or already-resolved actionId — no-op
      console.warn('[Coordinator] P0-A: No pending confirmation for', payload.actionId);
      sendResponse({ ack: true });
      return;
    }

    // Session binding: reject if session changed since confirmation was requested
    if (pending.sessionId !== this.state.sessionId) {
      console.warn('[Coordinator] P0-A: Stale session for', payload.actionId);
      clearTimeout(pending.timeoutId);
      this.pendingConfirmations.delete(payload.actionId);
      pending.resolve(false);
      sendResponse({ ack: true });
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingConfirmations.delete(payload.actionId);
    pending.resolve(payload.approved);
    sendResponse({ ack: true });
  }

  private handleActionOutcome(
    payload: ActionOutcomePayload,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): void {
    console.log('[Coordinator] Action outcome:', {
      id: payload.actionId,
      success: payload.success,
      outcome: payload.outcome,
    });

    // Re-observe after every state-changing action (contract §1.8)
    if (
      payload.outcome === 'navigated' ||
      payload.newDocumentGeneration
    ) {
      this.capture.invalidateCache();
    }

    sendResponse({ ack: true });
  }

  // ── Session control ──────────────────────────────────────

  private async handleSessionControl(
    payload: SessionControlPayload,
    sendResponse: (response: unknown) => void,
  ): Promise<void> {
    switch (payload.action) {
      case 'start': {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab?.id) {
          // P1-F: If a session is already active, end it first.
          // This revokes all vault grants, rejects pending confirmations,
          // and clears the stale tab binding before creating a new session.
          // Without this, a SESSION_CONTROL 'start' could silently rebind
          // an active session to a different tab.
          if (this.state.isActive) {
            console.log('[Coordinator] P1-F: Ending existing session before rebinding to tab', tab.id);
            await this.endSession();
          }
          await this.startSession(tab.id);
        }
        break;
      }
      case 'pause':
        this.state.isActive = false;
        this.setPhase('idle');
        break;
      case 'resume':
        this.state.isActive = true;
        break;
      case 'stop':
        await this.endSession();
        break;
    }

    try { await this.persistState(); } catch { /* best-effort for session control */ }
    this.broadcastStatus();
    sendResponse({ ack: true, sessionId: this.state.sessionId });
  }

  private handleContentReady(
    payload: ContentReadyPayload,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): void {
    console.log('[Coordinator] Content ready:', {
      tab: sender.tab?.id,
      origin: payload.origin,
    });
    sendResponse({
      ack: true,
      sessionActive: this.state.isActive,
      sessionId: this.state.sessionId,
    });
  }

  // ── Session lifecycle ────────────────────────────────────

  private async startSession(tabId: number): Promise<void> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const sessionId =
      'session-' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    this.state = {
      ...INITIAL_STATE,
      sessionId,
      isActive: true,
      activeTabId: tabId,
    };

    console.log('[Coordinator] Session started:', sessionId);
    try { await this.persistState(); } catch { /* best-effort for session start */ }
  }

  private async endSession(): Promise<void> {
    console.log('[Coordinator] Session ended:', this.state.sessionId);

    // P0-A: Reject all pending confirmations — session ended
    for (const [actionId, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeoutId);
      pending.resolve(false);
      console.log('[Coordinator] P0-A: Rejected pending confirmation on session end:', actionId);
    }
    this.pendingConfirmations.clear();

    // Revoke all vault grants for this session
    if (this.state.sessionId) {
      const revoked = this.vault.revokeSession(this.state.sessionId);
      console.log('[Coordinator] Revoked', revoked, 'vault grants');
    }

    this.capture.invalidateCache();
    this.vault.revokeExpired();
    // P1-G: Reset observation lifecycle on session end.
    // New sessions start with no invalidated observation.
    this._invalidatedObservationIds.clear();
    this.state = { ...INITIAL_STATE };
    try { await this.persistState(); } catch { /* best-effort for session end */ }
  }

  // ── Tab events ───────────────────────────────────────────

  handleTabUpdated(
    tabId: number,
    _changeInfo: chrome.tabs.TabChangeInfo,
    _tab: chrome.tabs.Tab,
  ): void {
    if (tabId === this.state.activeTabId) {
      console.log('[Coordinator] Active tab navigated — invalidating');
      this.capture.invalidateCache();
    }
  }

  handleTabRemoved(tabId: number): void {
    if (tabId === this.state.activeTabId) {
      this.endSession();
    }
  }

  handleTabActivated(activeInfo: chrome.tabs.TabActiveInfo): void {
    if (this.state.isActive) {
      console.log('[Coordinator] Tab activated:', activeInfo.tabId);
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private setPhase(phase: StatusUpdatePayload['currentPhase']): void {
    this.state.currentPhase = phase;
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    const payload: StatusUpdatePayload = {
      sessionId: this.state.sessionId,
      isActive: this.state.isActive,
      currentPhase: this.state.currentPhase,
      lastObservationId: this.state.lastObservationId,
    };

    chrome.runtime
      .sendMessage(
        createMessage(MESSAGE_TYPES.STATUS_UPDATE, payload, 'background'),
      )
      .catch(() => {});
  }

  // ── Perception helpers ────────────────────────────────────

  /**
   * Convert a data URL (PNG from captureVisibleTab) to ImageData.
   * Uses OffscreenCanvas available in Chrome service workers (109+).
   */
  private async dataUrlToImageData(
    dataUrl: string,
    width: number,
    height: number,
  ): Promise<ImageData> {
    // In Chrome service workers, OffscreenCanvas + createImageBitmap are available
    const base64 = dataUrl.split(',')[1];
    if (!base64) throw new Error('Invalid data URL');

    // Convert base64 to Uint8Array
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // Create ImageBitmap from PNG bytes
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);

    // Draw to OffscreenCanvas to get ImageData
    const canvas = new OffscreenCanvas(bitmap.width || width, bitmap.height || height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Build tile rectangles from changed tile IDs.
   * Tile IDs are in the format "tile-{row}-{col}".
   */
  private buildTileRects(
    changedTileIds: string[],
    viewportWidth: number,
    viewportHeight: number,
  ): Array<{ x: number; y: number; w: number; h: number }> {
    const TILE_SIZE = 256;
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];

    for (const tileId of changedTileIds) {
      const match = tileId.match(/^tile-(\d+)-(\d+)$/);
      if (!match) continue;
      const row = parseInt(match[1], 10);
      const col = parseInt(match[2], 10);
      const x = col * TILE_SIZE;
      const y = row * TILE_SIZE;
      rects.push({
        x,
        y,
        w: Math.min(TILE_SIZE, viewportWidth - x),
        h: Math.min(TILE_SIZE, viewportHeight - y),
      });
    }

    // If no tiles specified, process full viewport
    if (rects.length === 0) {
      rects.push({ x: 0, y: 0, w: viewportWidth, h: viewportHeight });
    }

    return rects;
  }

  /**
   * Convert visual groundings from perception to SceneNode records.
   * These represent visually-detected content not present in the DOM —
   * canvas-rendered text, visual-only controls, detected faces, etc.
   *
   * Contract §9: unified ID space — visual nodes join the scene graph.
   * They are distinguished by source: ['vision'] or ['ocr'].
   */
  private groundingsToSceneNodes(
    perception: PerceptionResult,
    observationId: string,
    documentGeneration: string,
  ): SceneNode[] {
    const nodes: SceneNode[] = [];
    let visualCounter = 0;

    for (const grounding of perception.groundings) {
      const nodeId = `vis-${observationId.substring(0, 8)}-${++visualCounter}`;

      // Determine source type
      const sources = grounding.evidence.map(e => e.source);
      const isOcr = sources.some(s => s === 'ocr');
      const isFace = grounding.class === 'face';
      const isControl = grounding.class === 'control' || grounding.class === 'payment-control';

      const source: SceneNode['source'] = isOcr
        ? ['ocr']
        : isFace
        ? ['vision']
        : ['vision'];

      // Determine sensitivity from grounding class
      const sensitivity: SensitivityFinding[] = [];

      if (isFace) {
        sensitivity.push({
          category: 'face',
          confidence: grounding.confidence,
          validationTier: 'visual',
          evidenceSource: 'face-detector',
        });
      }

      if (grounding.class === 'identifier') {
        sensitivity.push({
          category: 'account-number',
          confidence: grounding.confidence,
          validationTier: 'visual',
          evidenceSource: 'ocr',
        });
      }

      if (grounding.class === 'payment-control') {
        sensitivity.push({
          category: 'payment',
          confidence: grounding.confidence,
          validationTier: 'visual',
          evidenceSource: 'region-parser',
        });
      }

      // Map visual actionability
      const actionability = grounding.actionability;
      const affordances: SceneNode['affordances'] =
        actionability === 'clickable' ? ['click', 'focus']
        : actionability === 'typable' ? ['type', 'focus']
        : actionability === 'selectable' ? ['select']
        : [];

      const node: SceneNode = {
        id: nodeId,
        observationId,
        source,
        frameId: grounding.frameId,
        documentGeneration,
        originClass: 'top',
        tag: isFace ? 'canvas' : isControl ? 'canvas' : 'div',
        role: isFace ? 'img' : isControl ? 'button' : 'generic',
        name: grounding.semanticLabel || '',
        description: grounding.evidence.map(e => e.finding).join('; '),
        visibleText: isOcr ? (grounding.semanticLabel || '') : '',
        bbox: {
          x: grounding.bbox.x,
          y: grounding.bbox.y,
          w: grounding.bbox.w,
          h: grounding.bbox.h,
        },
        isClipped: false,
        zIndex: 0,
        opacity: 1,
        visibility: 'visible',
        affordances,
        isFocusable: isControl,
        isDisabled: false,
        isReadOnly: !isControl,
        tabIndex: isControl ? 0 : null,
        sensitivity,
        necessity: 'unknown',
        conflictFlags: grounding.conflictFlags as string[],
        stableTargetRef: `visual-${grounding.visualRegionId}`,
        ancestryFingerprint: `visual-${grounding.class}`,
        mutationVersion: 0,
        harvestedAt: new Date().toISOString(),
      };

      nodes.push(node);
    }

    return nodes;
  }

  // -- Offscreen Smoke Test (Phase 9) ------------------------------------

  /**
   * SMOKE_OFFSCREEN_TEST handler.
   *
   * Proves S1-S6 offscreen ONNX inference chain:
   *   S1 offscreen document created/exists
   *   S2 OFFSCREEN_READY received (uses Coordinator's buffered state)
   *   S3 ORT initialized (INFERENCE_INIT_RESULT.success)
   *   S4 real model session (face-detector)
   *   S5 real inference on 64×64 blank PNG
   *   S6 result returned to service worker
   *
   * IMPORTANT: This reuses the Coordinator's existing _initOffscreenInference()
   * path rather than duplicating the OFFSCREEN_READY handshake. The production
   * flow already owns _offscreenReadyReceived, PING, READY buffering, and the
   * INFERENCE_INIT round-trip. The smoke test just confirms that state and
   * then executes a real inference.
   *
   * If the production init already completed, _initOffscreenInference() returns
   * immediately (mutex singleton). If not, it runs the full handshake.
   *
   * A smoke test failure must NOT set _modelLoadFailed = true.
   *
   * Called by ort-smoke-test.js.
   */
  private handleSmokeOffscreenTest(
    sendResponse: (response: unknown) => void,
  ): void {
    (async () => {
      let offscreenCreated = false;
      let offscreenReadyReceived = false;
      let runtimeInstanceId = 'unknown';
      let initMs = 0;
      try {
        // --- S1: Ensure offscreen document ---
        // _initOffscreenInference() internally calls _ensureOffscreenDocument().
        // We call _ensureOffscreenDocument() first just to report whether it
        // already existed (for S1 display), then let _initOffscreenInference()
        // handle the full handshake.
        const existed = await this._ensureOffscreenDocument();
        offscreenCreated = true;
        console.log('[Coordinator] SMOKE S1: offscreen document ready (existed=' + existed + ')');

        // --- S2 + S3: Use the production handshake (buffered READY + INFERENCE_INIT) ---
        // _initOffscreenInference() is mutex-protected:
        //   - If already completed: returns immediately (0ms).
        //   - If in progress: awaits the existing promise.
        //   - If not started: runs full handshake (READY wait + INFERENCE_INIT).
        //
        // The production _waitForOffscreenReady() checks _offscreenReadyReceived
        // first, resolving instantly if READY was already buffered. This eliminates
        // the race that caused the smoke S2 timeout.
        const initT0 = performance.now();
        await this._initOffscreenInference();
        initMs = Math.round(performance.now() - initT0);

        // S2: OFFSCREEN_READY was received (production state is authoritative)
        offscreenReadyReceived = this._offscreenReadyReceived;
        runtimeInstanceId = this._offscreenRuntimeInstanceId ?? 'unknown';
        console.log('[Coordinator] SMOKE S2: OFFSCREEN_READY received (instance=' +
          runtimeInstanceId + ', buffered=' + offscreenReadyReceived + ')');

        // S3: ORT initialized (INFERENCE_INIT_RESULT.success was true)
        console.log('[Coordinator] SMOKE S3: ORT initialized in ' + initMs + 'ms backend=' + this._backend);

        // --- S4+S5: Send INFERENCE_RUN with 64×64 blank PNG ---
        const canvas = new OffscreenCanvas(64, 64);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 64, 64);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const arrayBuf = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let b64 = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const imageDataUrl = 'data:image/png;base64,' + btoa(b64);

        const inferenceResult = await new Promise<any>((resolve, reject) => {
          this._pendingInference = { resolve, reject };
          const msg: InferenceRunMessage = {
            type: 'INFERENCE_RUN',
            imageDataUrl,
            changedTiles: [{ x: 0, y: 0, w: 64, h: 64 }],
            observationId: 'smoke-' + Date.now(),
            frameId: 0,
            documentGeneration: 'smoke',
            canvasContext: { canvasTexts: [], faceRegions: [], controlRegions: [] },
            captureWidth: 64,
            captureHeight: 64,
          };
          chrome.runtime.sendMessage(msg);
          setTimeout(() => {
            if (this._pendingInference) {
              this._pendingInference = null;
              reject(new Error('Smoke S5 timeout: INFERENCE_RESULT not received in 120s'));
            }
          }, 120000);
        });
        // inferenceResult is now a full InferenceResult with timing fields.
        const ir = inferenceResult as InferenceResult;
        const perceptionResult = ir.result;
        const faceCount = perceptionResult?.faceDetections?.length ?? 0;

        console.log('[Coordinator] SMOKE S5+S6: inference complete' +
          ' faces=' + faceCount +
          ' transferDecodeMs=' + ir.transferDecodeMs +
          ' inferenceMs=' + ir.inferenceMs +
          ' totalMs=' + ir.totalMs);

        // Validate timing — if real inference ran, inferenceMs must be > 0.
        // A 0ms inference on a real ONNX model is physically impossible.
        if (typeof ir.inferenceMs !== 'number' || ir.inferenceMs <= 0) {
          throw new Error(
            'Smoke S5 timing invalid: inferenceMs=' + ir.inferenceMs +
            ' (expected > 0 from real ONNX session.run())'
          );
        }

        const totalSmokeMs = Math.round(performance.now() - initT0);

        sendResponse({
          success: true,
          offscreenCreated,
          offscreenReady: offscreenReadyReceived,
          runtimeInstanceId,
          ortReady: true,
          backend: ir.backend ?? this._backend,
          modelId: 'face-detector-v1',
          initMs,
          transferDecodeMs: ir.transferDecodeMs,
          inferenceMs: ir.inferenceMs,
          totalMs: totalSmokeMs,
          faceDetections: faceCount,
          timing: {
            initMs,
            transferDecodeMs: ir.transferDecodeMs,
            inferenceMs: ir.inferenceMs,
            offscreenTotalMs: ir.totalMs,
            smokeWallClockMs: totalSmokeMs,
          },
        });
      } catch (e) {
        const err = e as Error;
        console.error('[Coordinator] SMOKE_OFFSCREEN_TEST failed:', err.message);
        // IMPORTANT: Do NOT set _modelLoadFailed here. The smoke test is a
        // diagnostic -- its failure should not prevent production inference.
        sendResponse({
          success: false,
          error: err.message,
          offscreenCreated,
          offscreenReady: offscreenReadyReceived,
        });
      }
    })();
  }
}


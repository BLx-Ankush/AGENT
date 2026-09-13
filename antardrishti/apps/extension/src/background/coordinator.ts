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
import { validatePlan, type SceneContext } from '@antardrishti/planner';
import {
  PerceptionPipeline,
  type PerceptionResult,
  type CanvasRegionData,
  loadProductionModels,
  type LoadedModels,
} from '@antardrishti/model-runner';
import type { SceneNode, SensitivityFinding } from '@antardrishti/scene-graph';

import { CaptureManager } from './capture';

// ── Action kinds that require re-observation after execution ──

const STATE_CHANGING_ACTIONS = new Set([
  'click', 'type_text', 'type_token', 'select', 'submit',
]);

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

export class Coordinator {
  private state: CoordinatorState = { ...INITIAL_STATE };
  private capture = new CaptureManager();
  private vault = new TokenVault();
  private sanitizer = new Sanitizer(this.vault);
  private verifier = new EgressVerifier();
  private planner: PlannerAdapter = new DeterministicPlanner();
  private perception = new PerceptionPipeline();

  /**
   * Readiness gate — resolves when production models are loaded and registered.
   * All user-task handling awaits this before entering perception.
   * If model loading fails, this rejects and the coordinator enters fail-closed state.
   */
  private _modelReadiness: Promise<LoadedModels>;
  private _modelLoadFailed = false;
  private _loadedModels: LoadedModels | null = null;

  // Pending confirmations
  private pendingConfirmations = new Map<
    string,
    { resolve: (approved: boolean) => void }
  >();

  constructor() {
    // Start model loading immediately — initialize() will await the readiness gate.
    // This means model loading begins at service worker start, not at first user task.
    this._modelReadiness = this._loadModels();
  }

  /**
   * Load all production ONNX models and register them with the pipeline.
   *
   * FAIL-CLOSED contract:
   *   - If any model fails to load, _modelLoadFailed = true.
   *   - All subsequent handleUserTask calls will be rejected.
   *   - DEV_FALLBACK is NOT enabled. Failure is never silent.
   *
   * Startup log sequence:
   *   [ModelLoader] Starting production model load…
   *   [ModelLoader] Loading production models { browser, backend, webgpu, wasm }
   *   [ModelLoader] All models loaded { textDetector, ocrRecognizer, … }
   *   [Perception]  PRODUCTION ONNX models registered
   *   [Coordinator] ✅ Perception ready — all 4 ONNX models loaded
   */
  private async _loadModels(): Promise<LoadedModels> {
    console.log('[ModelLoader] Starting production model load…');
    try {
      // detectRuntime() inside loadProductionModels() selects:
      //   Chrome → WebGPU preferred, WASM fallback
      //   Firefox → WASM-first
      const models = await loadProductionModels();

      // Register with the perception pipeline — sets _initialized = true
      this.perception.registerOnnxModels(models);
      this._loadedModels = models;

      // Persist backend status for the popup model status panel
      chrome.storage.local.set({
        modelBackend: models.backend,
        modelLoadedAt: new Date().toISOString(),
      }).catch(() => {});

      return models;
    } catch (err) {
      this._modelLoadFailed = true;
      console.error(
        '[ModelLoader] FAIL-CLOSED: Production model loading failed. ' +
        'No user tasks will be processed until the extension is reloaded. ' +
        'Cause:', err,
      );
      // Rethrow so the readiness promise rejects and handleUserTask can detect failure
      throw err;
    }
  }

  // ── Public readiness accessors ────────────────────────────

  /** True once all 4 ONNX models are loaded and perception is initialized. */
  get isPerceptionReady(): boolean {
    return this.perception.isInitialized && !this._modelLoadFailed;
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
      const stored = await chrome.storage.session.get('coordinatorState');
      if (stored.coordinatorState) {
        this.state = { ...INITIAL_STATE, ...stored.coordinatorState };
        console.log('[Coordinator] Restored session:', this.state.sessionId);
      }
    } catch {
      console.log('[Coordinator] Fresh start');
    }

    // Wait for production models to be ready (they started loading in constructor).
    // This ensures initialize() does not return until perception is fully operational.
    try {
      await this._modelReadiness;
      console.log('[Coordinator] ✅ Perception ready — all 4 ONNX models loaded');
    } catch (err) {
      console.error('[Coordinator] ❌ Model load failed — coordinator in fail-closed state');
      // Do NOT re-throw — service worker lifecycle must complete.
      // The fail-closed flag is set; handleUserTask will reject all tasks.
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
      await chrome.storage.session.set({ coordinatorState: this.state });
    } catch (e) {
      console.warn('[Coordinator] Persist failed:', e);
    }
  }

  // ── Message handling ─────────────────────────────────────

  handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): void {
    if (!isValidMessageEnvelope(message)) {
      sendResponse({ error: 'Invalid message envelope' });
      return;
    }

    const msg = message as MessageEnvelope;

    switch (msg.type) {
      case MESSAGE_TYPES.USER_TASK:
        this.handleUserTask(msg.payload as UserTaskPayload, sendResponse);
        break;

      case MESSAGE_TYPES.SESSION_CONTROL:
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
        this.handleConfirmationResponse(
          msg.payload as ConfirmationResponsePayload,
          sendResponse,
        );
        break;

      case MESSAGE_TYPES.ACTION_OUTCOME:
        this.handleActionOutcome(
          msg.payload as ActionOutcomePayload,
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

  // ── Full pipeline ────────────────────────────────────────

  private async handleUserTask(
    payload: UserTaskPayload,
    sendResponse: (response: unknown) => void,
  ): Promise<void> {
    console.log('[Coordinator] ═══ Pipeline Start ═══');
    const pipelineStart = performance.now();

    // ── Readiness gate ──────────────────────────────────────
    // Ensures no user task can enter perception before all 4 ONNX models
    // are loaded and registered. Prevents race conditions at startup.
    if (this._modelLoadFailed) {
      console.error('[Coordinator] FAIL-CLOSED: Model loading failed. Task rejected.');
      sendResponse({
        error: 'Model loading failed. Extension must be reloaded.',
        failClosed: true,
      });
      return;
    }
    try {
      await this._modelReadiness;
    } catch {
      // _modelLoadFailed is already set; the error path above will catch future calls
      sendResponse({
        error: 'Model loading failed. Extension must be reloaded.',
        failClosed: true,
      });
      return;
    }

    if (!this.state.isActive) {
      await this.startSession(payload.tabId);
    }


    try {
      // ── Step 1: Capture visible tab ─────────────────────
      this.setPhase('capturing');
      const captureResult = await this.capture.captureVisibleTab(
        payload.tabId,
      );
      console.log('[Coordinator] [1/8] Captured:', {
        obs: captureResult.observationId,
        tiles: captureResult.tileCount,
        changed: captureResult.changedTileIds.length,
        bytes: captureResult.imageDataUrl.length,
      });

      // ── Step 2: Request DOM harvest + canvas context ─────
      const harvestResult = await this.requestHarvest(
        payload.tabId,
        captureResult.observationId,
      );
      console.log('[Coordinator] [2/8] Harvested:', {
        nodes: harvestResult?.nodeCount || 0,
        canvasTexts: harvestResult?.canvasContext?.canvasTexts?.length || 0,
        faceRegions: harvestResult?.canvasContext?.faceRegions?.length || 0,
        controlRegions: harvestResult?.canvasContext?.controlRegions?.length || 0,
      });

      // ── Step 3: Local perception pipeline ───────────────
      this.setPhase('perceiving' as any);
      const perceptionStart = performance.now();

      // Convert data URL to ImageData for perception
      // (OffscreenCanvas available in service worker context Chrome 109+)
      let imageData: ImageData | null = null;
      try {
        imageData = await this.dataUrlToImageData(
          captureResult.imageDataUrl,
          captureResult.width,
          captureResult.height,
        );
      } catch (e) {
        console.warn('[Coordinator] ImageData conversion failed, skipping pixel perception:', e);
      }

      // Build tile rects from changed tile IDs
      const changedTileRects = this.buildTileRects(
        captureResult.changedTileIds,
        captureResult.width,
        captureResult.height,
      );

      let perceptionResult: PerceptionResult | null = null;
      if (imageData) {
        const canvasCtx: CanvasRegionData = {
          canvasTexts: harvestResult?.canvasContext?.canvasTexts || [],
          faceRegions: harvestResult?.canvasContext?.faceRegions || [],
          controlRegions: harvestResult?.canvasContext?.controlRegions || [],
        };

        perceptionResult = await this.perception.run(
          imageData,
          changedTileRects,
          captureResult.observationId as string,
          0, // frameId
          captureResult.stamp.documentGeneration,
          canvasCtx,
        );

        const perceptionMs = Math.round(performance.now() - perceptionStart);
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
        console.log('[Coordinator] [3/8] Perception skipped (no ImageData)');
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
        payload.tabId,
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
      const sceneContext: SceneContext = {
        nodeIds,
        freshness: {
          sessionId: this.state.sessionId!,
          tabId: payload.tabId,
          frameId: 0,
          documentGeneration: captureResult.stamp.documentGeneration,
          viewportFingerprint: `${captureResult.width}x${captureResult.height}`,
          observationId: captureResult.observationId,
          origin: captureResult.stamp.topOrigin,
          createdAt: new Date().toISOString(),
        },
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

      // Check if any action requires user confirmation
      const needsConfirm = validation.validations.some(
        (v) => v.requiresConfirmation,
      );

      if (needsConfirm) {
        this.setPhase('confirming');
        const confirmAction = plannerResponse.actions.find(
          (_, i) => validation.validations[i].requiresConfirmation,
        );
        if (confirmAction) {
          this.requestConfirmation(confirmAction);
        }
      }

      // ── ONE ACTION → RE-OBSERVE (contract §1.5) ──────────
      // Execute ONLY the first state-changing action.
      // Non-state-changing actions (scroll, wait, finish) can be batched.
      this.setPhase('executing');
      let executedStateChangingAction = false;
      let executedActionCount = 0;

      for (const action of plannerResponse.actions) {
        const isStateChanging = STATE_CHANGING_ACTIONS.has(action.kind);

        if (isStateChanging && executedStateChangingAction) {
          // Contract §1.5: stop after first state-changing action
          // The next pipeline invocation will re-observe and replan
          console.log('[Coordinator] One-action boundary: halting at', action.kind, '(re-observe required)');
          break;
        }

        console.log('[Coordinator] Executing:', action.kind, action.id);
        await this.executeAction(
          payload.tabId,
          action,
          captureResult.stamp.documentGeneration,
          captureResult.stamp.topOrigin,
        );
        executedActionCount++;

        if (isStateChanging) {
          executedStateChangingAction = true;
          // Invalidate cache so next invocation re-observes
          this.capture.invalidateCache();
          console.log('[Coordinator] State-changing action executed — cache invalidated for re-observation');
        }

        // finish/request_observation terminate the sequence
        if (action.kind === 'finish' || action.kind === 'request_observation') break;
      }

      this.state.lastObservationId = captureResult.observationId as string;
      this.state.step += 1;

      const pipelineMs = Math.round(performance.now() - pipelineStart);
      console.log(`[Coordinator] ═══ Pipeline Done (${pipelineMs}ms) ═══`);

      this.setPhase('idle');
      await this.persistState();

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
      await this.persistState();
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
  ): Promise<void> {
    try {
      // TOKEN REDEMPTION (contract §12):
      // type_token actions MUST resolve the token from the vault.
      // The raw value is NEVER passed from planner output directly.
      // PLANNER OUTPUT → TOKEN REFERENCE → LOCAL VAULT → AUTHORIZED ACTION → REAL VALUE
      let resolvedValue: string | undefined;

      if (action.kind === 'type_token' && action.token) {
        const redemption = this.redeemTokenForAction(
          action.token,
          action.targetNodeId || '',
          documentGeneration,
          origin,
        );
        if ('error' in redemption) {
          console.error('[Coordinator] Token redemption failed:', redemption.error, 'token:', action.token);
          return; // refuse to execute with unredeemed token
        }
        resolvedValue = redemption.value;
        console.log('[Coordinator] Token redeemed for type_token action');
      } else if (action.kind === 'type_text') {
        // type_text uses safe text value (not a vault token)
        resolvedValue = action.text;
      }

      await chrome.tabs.sendMessage(tabId, createMessage(
        MESSAGE_TYPES.EXECUTE_ACTION,
        {
          actionId: action.id,
          kind: action.kind,
          targetNodeId: action.targetNodeId,
          // resolvedValue is the post-redemption value for type_token,
          // or safe text for type_text. NEVER the raw planner token.
          value: resolvedValue,
          expectedRole: action.expectedRole,
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

  // ── Confirmations ────────────────────────────────────────

  private requestConfirmation(action: any): void {
    const payload: ConfirmationRequestPayload = {
      actionId: action.id,
      actionKind: action.kind,
      targetDescription: action.reason || action.kind,
      risk: 'high',
    };

    chrome.runtime
      .sendMessage(createMessage(
        MESSAGE_TYPES.CONFIRMATION_REQUEST,
        payload,
        'background',
      ))
      .catch(() => {});
  }

  private handleConfirmationResponse(
    payload: ConfirmationResponsePayload,
    sendResponse: (r: unknown) => void,
  ): void {
    const pending = this.pendingConfirmations.get(payload.actionId);
    if (pending) {
      pending.resolve(payload.approved);
      this.pendingConfirmations.delete(payload.actionId);
    }
    sendResponse({ ack: true });
  }

  private handleActionOutcome(
    payload: ActionOutcomePayload,
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
        if (tab?.id) await this.startSession(tab.id);
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

    await this.persistState();
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
    await this.persistState();
  }

  private async endSession(): Promise<void> {
    console.log('[Coordinator] Session ended:', this.state.sessionId);

    // Revoke all vault grants for this session
    if (this.state.sessionId) {
      const revoked = this.vault.revokeSession(this.state.sessionId);
      console.log('[Coordinator] Revoked', revoked, 'vault grants');
    }

    this.capture.invalidateCache();
    this.vault.revokeExpired();
    this.state = { ...INITIAL_STATE };
    await this.persistState();
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
}

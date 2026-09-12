/**
 * ANTARDRISHTI — Session Coordinator (Phase 7 — Full Pipeline)
 *
 * Orchestrates the complete 13-step flow:
 *   USER TASK → LOCAL SANITIZATION → DOM + A11Y HARVEST →
 *   VISIBLE TAB CAPTURE → CHANGED-TILE ROUTING →
 *   LOCAL VISUAL PERCEPTION → SEMANTIC VISUAL RECOGNITION →
 *   VISUAL GROUNDING → DOM ↔ VISUAL RECONCILIATION →
 *   LOCAL PRIVACY CLASSIFICATION → TOKENIZATION / REDACTION →
 *   EXPLICIT REDACTION SCHEME → INDEPENDENT EGRESS VERIFICATION
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

import { CaptureManager } from './capture';

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

  // Pending confirmations
  private pendingConfirmations = new Map<
    string,
    { resolve: (approved: boolean) => void }
  >();

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

    if (!this.state.isActive) {
      await this.startSession(payload.tabId);
    }

    try {
      // ── Step 1: Capture visible tab ─────────────────────
      this.setPhase('capturing');
      const captureResult = await this.capture.captureVisibleTab(
        payload.tabId,
      );
      console.log('[Coordinator] [1/7] Captured:', {
        obs: captureResult.observationId,
        tiles: captureResult.tileCount,
        changed: captureResult.changedTileIds.length,
      });

      // ── Step 2: Request DOM harvest from content script ──
      const harvestResult = await this.requestHarvest(
        payload.tabId,
        captureResult.observationId,
      );
      console.log('[Coordinator] [2/7] Harvested:', {
        nodes: harvestResult?.nodeCount || 0,
      });

      // ── Step 3: Sanitize ─────────────────────────────────
      this.setPhase('sanitizing');
      const nodes = harvestResult?.nodes || [];
      const sanitized = this.sanitizer.sanitize(
        payload.rawTask,
        nodes,
        this.state.sessionId!,
        payload.tabId,
        0, // frameId
        captureResult.stamp.documentGeneration,
        captureResult.stamp.topOrigin,
      );
      console.log('[Coordinator] [3/7] Sanitized:', {
        redactions: sanitized.redactions.length,
        nodes: sanitized.scene.nodes.length,
        risk: sanitized.risk,
      });

      // ── Step 4: Build planner request ────────────────────
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

      // ── Step 5: Egress verification ──────────────────────
      this.setPhase('verifying');
      const verification = await this.verifier.verify(
        plannerRequest,
        this.state.plannerUrl || 'http://localhost:8000/plan',
      );

      if (!verification.approved) {
        const block = verification as { reason: string; category: string };
        console.error('[Coordinator] [5/7] EGRESS BLOCKED:', block.reason);
        sendResponse({
          ack: false,
          error: `Egress blocked: ${block.reason}`,
          category: block.category,
        });
        this.setPhase('idle');
        return;
      }

      console.log('[Coordinator] [5/7] Egress approved:', {
        sealSize: (verification as any).serializedSize,
        bodyHash: (verification as any).bodyHash?.substring(0, 16) + '…',
      });

      // ── Step 6: Plan ─────────────────────────────────────
      this.setPhase('planning');
      let plannerResponse: PlannerResponse;

      try {
        plannerResponse = await this.planner.plan(plannerRequest);
        console.log('[Coordinator] [6/7] Plan received:', {
          planId: plannerResponse.planId,
          actions: plannerResponse.actions.length,
          kinds: plannerResponse.actions.map((a) => a.kind),
        });
      } catch (e) {
        console.error('[Coordinator] [6/7] Planning failed:', e);
        sendResponse({ ack: false, error: `Planning failed: ${e}` });
        this.setPhase('idle');
        return;
      }

      // ── Step 7: Validate & execute actions ───────────────
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
        console.error('[Coordinator] [7/7] Plan validation failed:', errors);
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

      // Execute actions
      this.setPhase('executing');
      for (const action of plannerResponse.actions) {
        console.log('[Coordinator] Executing:', action.kind, action.id);
        await this.executeAction(payload.tabId, action);
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
  ): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, createMessage(
        MESSAGE_TYPES.EXECUTE_ACTION,
        {
          actionId: action.id,
          kind: action.kind,
          targetNodeId: action.targetNodeId,
          value: action.text || action.token,
          expectedRole: action.expectedRole,
        },
        'background',
      ));
    } catch (e) {
      console.warn('[Coordinator] Action execution failed:', e);
    }
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
}

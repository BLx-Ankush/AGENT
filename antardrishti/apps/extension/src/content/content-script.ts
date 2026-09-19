/**
 * ANTARDRISHTI — Content Script
 *
 * Injected into the active tab. Bridges the DOM with the extension
 * service worker. Collects DOM/A11y state on request using the
 * full harvester (Phase 2).
 *
 * Runs in the page context. Communicates ONLY with the extension
 * background via typed messages.
 */

import {
  createMessage,
  isValidMessageEnvelope,
  MESSAGE_TYPES,
  type ContentReadyPayload,
  type MessageEnvelope,
} from '@antardrishti/protocol-v2';

import { harvestDOM, getLastHarvestElementMap } from '@antardrishti/scene-graph';
import { hitTestNode, hitTestMultiPoint } from '@antardrishti/scene-graph';
import { executeAction, setNodeRegistry, queryTargetCurrentState } from './action-executor';

// ── State ────────────────────────────────────────────────────

let documentGeneration = `doc-${Date.now()}`;
let lastUrl = window.location.href;

// ── Init ─────────────────────────────────────────────────────

function notifyReady(): void {
  const payload: ContentReadyPayload = {
    tabId: 0,
    frameId: 0,
    origin: window.location.origin,
    url: window.location.href,
    documentGeneration,
  };
  chrome.runtime
    .sendMessage(createMessage(MESSAGE_TYPES.CONTENT_READY, payload, 'content'))
    .catch(() => {});
}

// ── Message handling ─────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ) => {
    if (!isValidMessageEnvelope(message)) return;
    const msg = message as MessageEnvelope;

    switch (msg.type) {
      case MESSAGE_TYPES.REQUEST_SNAPSHOT:
        handleSnapshotRequest(msg.payload, sendResponse);
        break;

      case MESSAGE_TYPES.REQUEST_HIT_TEST:
        handleHitTest(msg.payload, sendResponse);
        break;

      case MESSAGE_TYPES.EXECUTE_ACTION:
        handleExecuteAction(msg.payload, sendResponse);
        break;

      case MESSAGE_TYPES.VERIFY_TARGET:
        handleVerifyTarget(msg.payload, sendResponse);
        break;

      default:
        sendResponse({ ack: true });
    }

    return true;
  },
);

// ── Snapshot (full harvester) ────────────────────────────────

function handleSnapshotRequest(
  payload: unknown,
  sendResponse: (r: unknown) => void,
): void {
  const p = payload as { observationId?: string } | undefined;
  const obsId = p?.observationId || `obs-inline-${Date.now()}`;

  try {
    const result = harvestDOM(obsId, documentGeneration, 0);

    // P0-B: Install the harvester's authoritative nodeId→HTMLElement map.
    // The executor uses this exact mapping — no independent ID generation.
    setNodeRegistry(getLastHarvestElementMap(), documentGeneration);

    sendResponse({
      ack: true,
      nodeCount: result.nodes.length,
      mutationVersion: result.mutationVersion,
      documentGeneration: result.documentGeneration,
      origin: result.origin,
      viewportWidth: result.viewportWidth,
      viewportHeight: result.viewportHeight,
      harvestedAt: result.harvestedAt,
      // Full nodes shipped via structured clone
      nodes: result.nodes,
    });
  } catch (e) {
    console.error('[ANTARDRISHTI] Harvest failed:', e);
    sendResponse({ ack: false, error: `Harvest failed: ${e}` });
  }
}

// ── Hit-test ─────────────────────────────────────────────────

// ── Action execution ─────────────────────────────────────────

async function handleExecuteAction(
  payload: unknown,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const p = payload as {
    actionId: string;
    kind: string;
    targetNodeId?: string;
    value?: string;
    expectedRole?: string;
    expectedFingerprint?: {
      nodeId: string; role: string; name: string;
      ancestry: string;
      bbox: { x: number; y: number; w: number; h: number };
      frameId: number; documentGeneration: string;
      observationId: string;
    };
  };

  if (!p?.actionId || !p?.kind) {
    sendResponse({ ack: false, error: 'Missing actionId or kind' });
    return;
  }

  // P1-C: executeAction now handles TOCTOU internally —
  // it verifies the fingerprint IMMEDIATELY before each DOM mutation,
  // and fails closed if expectedFingerprint is missing for target-bound actions.
  const result = await executeAction(p);

  // Report outcome back to coordinator
  chrome.runtime
    .sendMessage(
      createMessage(
        MESSAGE_TYPES.ACTION_OUTCOME,
        {
          actionId: result.actionId,
          success: result.success,
          outcome: result.outcome,
          newDocumentGeneration: result.newDocumentGeneration,
          error: result.error,
        },
        'content',
      ),
    )
    .catch(() => {});

  sendResponse({ ack: true, ...result });
}

// ── P1-C: Target verification ────────────────────────────────

function handleVerifyTarget(
  payload: unknown,
  sendResponse: (r: unknown) => void,
): void {
  const p = payload as { nodeId?: string };
  if (!p?.nodeId) {
    sendResponse({ ack: false, found: false, error: 'Missing nodeId' });
    return;
  }

  const result = queryTargetCurrentState(p.nodeId);
  sendResponse({ ack: true, ...result });
}

function handleHitTest(
  payload: unknown,
  sendResponse: (r: unknown) => void,
): void {
  const p = payload as {
    nodeId: string;
    bbox: { x: number; y: number; w: number; h: number };
  };

  if (!p?.nodeId || !p?.bbox) {
    sendResponse({ ack: false, error: 'Missing nodeId or bbox' });
    return;
  }

  const singleResult = hitTestNode(p.nodeId, p.bbox);
  const multiResult = hitTestMultiPoint(p.bbox);

  sendResponse({
    ack: true,
    hitTest: singleResult,
    multiPoint: {
      hitElements: Array.from(multiResult.hitElements),
      overlayDetected: multiResult.overlayDetected,
    },
  });
}

// ── Navigation observer ──────────────────────────────────────

const navObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    documentGeneration = `doc-${Date.now()}`;
    chrome.runtime
      .sendMessage(
        createMessage(
          MESSAGE_TYPES.NAVIGATION,
          {
            url: window.location.href,
            origin: window.location.origin,
            documentGeneration,
          },
          'content',
        ),
      )
      .catch(() => {});
  }
});

navObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// ── Viewport / scroll / focus observers ──────────────────────

// Scroll completion
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('scroll', () => {
  if (scrollTimeout) clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    chrome.runtime
      .sendMessage(
        createMessage(
          MESSAGE_TYPES.SCROLL_COMPLETE,
          {
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            documentGeneration,
          },
          'content',
        ),
      )
      .catch(() => {});
  }, 200);
}, { passive: true });

// Viewport resize
window.addEventListener('resize', () => {
  chrome.runtime
    .sendMessage(
      createMessage(
        MESSAGE_TYPES.VIEWPORT_CHANGE,
        {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          documentGeneration,
        },
        'content',
      ),
    )
    .catch(() => {});
});

// Focus change (form field focus for sensitivity detection)
document.addEventListener('focusin', (e) => {
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    chrome.runtime
      .sendMessage(
        createMessage(
          MESSAGE_TYPES.FOCUS_CHANGE,
          {
            tag: target.tagName.toLowerCase(),
            type: target instanceof HTMLInputElement ? target.type : undefined,
            autocomplete: target instanceof HTMLInputElement ? target.autocomplete : undefined,
            documentGeneration,
          },
          'content',
        ),
      )
      .catch(() => {});
  }
});

// ── Start ────────────────────────────────────────────────────

notifyReady();
console.log('[ANTARDRISHTI] Content script loaded (Phase 2 harvester):', window.location.origin);

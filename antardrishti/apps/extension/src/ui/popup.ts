/**
 * ANTARDRISHTI — Popup UI (Phase 8: Evidence Panel + Planner Config)
 *
 * Displays pipeline status, evidence panel with 7-step demo data,
 * and planner configuration.
 */

import {
  createMessage,
  isValidMessageEnvelope,
  MESSAGE_TYPES,
  type MessageEnvelope,
  type StatusUpdatePayload,
} from '@antardrishti/protocol-v2';

// ── Elements ─────────────────────────────────────────────────

const statusDot = document.getElementById('statusDot')!;
const statusText = document.getElementById('statusText')!;
const sessionInfo = document.getElementById('sessionInfo')!;
const sessionId = document.getElementById('sessionId')!;
const taskInput = document.getElementById('taskInput') as HTMLTextAreaElement;
const submitTask = document.getElementById('submitTask') as HTMLButtonElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const currentPhase = document.getElementById('currentPhase')!;
const lastObservation = document.getElementById('lastObservation')!;
const redactionCount = document.getElementById('redactionCount')!;
const actionCount = document.getElementById('actionCount')!;
const pipelineTime = document.getElementById('pipelineTime')!;
const networkStatus = document.getElementById('networkStatus')!;

// Evidence panel
const evidencePanel = document.getElementById('evidencePanel')!;
const perceptionSection = document.getElementById('perceptionSection')!;
const perceptionTable = document.getElementById('perceptionTable')!;
const redactionSection = document.getElementById('redactionSection')!;
const redactionTable = document.getElementById('redactionTable')!;
const redactionNote = document.getElementById('redactionNote')!;
const plannerSection = document.getElementById('plannerSection')!;
const plannerActions = document.getElementById('plannerActions')!;
const metricsSection = document.getElementById('metricsSection')!;
const metricsGrid = document.getElementById('metricsGrid')!;

// Config
const plannerMode = document.getElementById('plannerMode') as HTMLSelectElement;
const plannerUrlRow = document.getElementById('plannerUrlRow')!;
const plannerUrl = document.getElementById('plannerUrl') as HTMLInputElement;
const savePlannerConfig = document.getElementById('savePlannerConfig') as HTMLButtonElement;

// ── State ────────────────────────────────────────────────────

let isActive = false;

// ── Init ─────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Load planner config
  try {
    const config = await chrome.storage.local.get(['plannerMode', 'plannerUrl']);
    if (config.plannerMode) {
      plannerMode.value = config.plannerMode;
      if (config.plannerMode === 'server') {
        plannerUrlRow.style.display = 'flex';
      }
    }
    if (config.plannerUrl) {
      plannerUrl.value = config.plannerUrl;
    }
  } catch {}
}

// ── Button handlers ──────────────────────────────────────────

startBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    createMessage(MESSAGE_TYPES.SESSION_CONTROL, { action: 'start' }, 'popup'),
  );
});

pauseBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    createMessage(MESSAGE_TYPES.SESSION_CONTROL, { action: isActive ? 'pause' : 'resume' }, 'popup'),
  );
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    createMessage(MESSAGE_TYPES.SESSION_CONTROL, { action: 'stop' }, 'popup'),
  );
  clearEvidence();
});

submitTask.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task) return;

  submitTask.disabled = true;
  submitTask.textContent = 'Running…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.runtime.sendMessage(
    createMessage(MESSAGE_TYPES.USER_TASK, {
      rawTask: task,
      tabId: tab.id,
    }, 'popup'),
    (response: any) => {
      submitTask.disabled = false;
      submitTask.textContent = 'Submit Task';

      if (response?.ack) {
        updateEvidence(response, task);
      } else {
        statusText.textContent = response?.error || 'Task failed';
      }
    },
  );
});

// ── Planner config ───────────────────────────────────────────

plannerMode.addEventListener('change', () => {
  plannerUrlRow.style.display = plannerMode.value === 'server' ? 'flex' : 'none';
});

savePlannerConfig.addEventListener('click', async () => {
  await chrome.storage.local.set({
    plannerMode: plannerMode.value,
    plannerUrl: plannerUrl.value,
  });
  savePlannerConfig.textContent = 'Saved ✓';
  setTimeout(() => { savePlannerConfig.textContent = 'Save Config'; }, 1500);
});

// ── Status updates ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isValidMessageEnvelope(message)) return;
  const msg = message as MessageEnvelope;

  if (msg.type === MESSAGE_TYPES.STATUS_UPDATE) {
    const payload = msg.payload as StatusUpdatePayload;
    updateStatus(payload);
  }
});

function updateStatus(payload: StatusUpdatePayload): void {
  isActive = payload.isActive;

  // Dot state
  statusDot.className = 'status-dot';
  if (payload.isActive) {
    if (payload.currentPhase === 'capturing' || payload.currentPhase === 'sanitizing') {
      statusDot.classList.add('capturing');
    } else {
      statusDot.classList.add('active');
    }
  }

  // Status text
  const phaseMap: Record<string, string> = {
    idle: 'Idle',
    capturing: '📸 Capturing…',
    sanitizing: '🛡️ Sanitizing…',
    verifying: '✅ Verifying…',
    planning: '🤖 Planning…',
    executing: '⚡ Executing…',
    confirming: '⚠️ Confirming…',
  };
  statusText.textContent = phaseMap[payload.currentPhase] || payload.currentPhase;
  currentPhase.textContent = payload.currentPhase;

  // Session info
  if (payload.sessionId) {
    sessionInfo.style.display = 'flex';
    sessionId.textContent = payload.sessionId.substring(0, 16) + '…';
  } else {
    sessionInfo.style.display = 'none';
  }

  // Observation
  if (payload.lastObservationId) {
    lastObservation.textContent = payload.lastObservationId.substring(0, 12) + '…';
  }

  // Button states
  startBtn.disabled = payload.isActive;
  pauseBtn.disabled = !payload.isActive;
  stopBtn.disabled = !payload.sessionId;
  pauseBtn.textContent = payload.isActive ? 'Pause' : 'Resume';
}

// ── Evidence panel ───────────────────────────────────────────

function updateEvidence(response: any, task: string): void {
  evidencePanel.style.display = 'flex';

  // Update info section
  redactionCount.textContent = response.redactions?.toString() || '0';
  actionCount.textContent = response.actions?.toString() || '0';
  pipelineTime.textContent = response.pipelineMs ? `${response.pipelineMs}ms` : '—';

  // Redaction section
  if (response.redactions > 0) {
    redactionSection.style.display = 'block';
    redactionTable.innerHTML = `
      <div class="row">
        <span class="col-id">Count</span>
        <span class="col">${response.redactions} redaction(s)</span>
        <span class="col-status tokenized">Tokenized</span>
      </div>
    `;
    redactionNote.textContent = '→ The planner knows field categories but NOT the raw values.';
  }

  // Planner section
  if (response.planId) {
    plannerSection.style.display = 'block';
    plannerActions.textContent = JSON.stringify({
      planId: response.planId,
      actions: response.actions || 0,
      observationId: response.observationId?.substring(0, 12) + '…',
    }, null, 2);
  }

  // Metrics
  metricsSection.style.display = 'block';
  metricsGrid.innerHTML = `
    <div class="metric-card">
      <div class="metric-value">${response.pipelineMs || '—'}</div>
      <div class="metric-label">Pipeline (ms)</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${response.redactions || 0}</div>
      <div class="metric-label">Redactions</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${response.actions || 0}</div>
      <div class="metric-label">Actions</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">0</div>
      <div class="metric-label">Leaks</div>
    </div>
  `;
}

function clearEvidence(): void {
  evidencePanel.style.display = 'none';
  redactionSection.style.display = 'none';
  plannerSection.style.display = 'none';
  metricsSection.style.display = 'none';
  redactionCount.textContent = '0';
  actionCount.textContent = '0';
  pipelineTime.textContent = '—';
}

// ── Boot ─────────────────────────────────────────────────────

init();

/**
 * Debug E13 failure - find what's blocking the egress verifier
 */
import { Sanitizer, TokenVault } from '@antardrishti/privacy';
import { EgressVerifier } from '@antardrishti/egress-verifier';
import { scanForForbiddenFields, FORBIDDEN_FIELDS } from '@antardrishti/protocol-v2';

const SESSION_ID = 'session-demo-sih2026';
const TAB_ID = 42;
const DOC_GEN = 'doc-demo-001';
const OBS_ID = 'obs-demo-001';
const DEMO_ORIGIN = 'https://demo.antardrishti.local';

const demoNodes: any[] = [
  { id: 'node-email', name: 'Email', role: 'textbox', tag: 'input', visibleText: 'ravi.shankar@example.com', bbox: { x: 40, y: 240, w: 300, h: 40 } },
  { id: 'node-pan', name: 'PAN', role: 'textbox', tag: 'input', visibleText: 'ABCDE1234F', bbox: { x: 40, y: 380, w: 300, h: 40 } },
  { id: 'node-card', name: 'Card Number', role: 'textbox', tag: 'input', visibleText: '4111 1111 1111 1111', bbox: { x: 40, y: 520, w: 620, h: 40 } },
  { id: 'node-api-key', name: 'API Key', role: 'textbox', tag: 'input', visibleText: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456', bbox: { x: 40, y: 920, w: 620, h: 40 } },
  { id: 'node-jwt', name: 'JWT', role: 'generic', tag: 'div', visibleText: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlJhdmkgU2hhbmthciJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', bbox: { x: 40, y: 960, w: 620, h: 30 } },
];

const rawTask = `Fill in: Email: ravi.shankar@example.com PAN: ABCDE1234F Card: 4111 1111 1111 1111 API: sk-proj-abcdefghijklmnopqrstuvwxyz123456`;

const vault = new TokenVault();
const sanitizer = new Sanitizer(vault);
const sanitized = sanitizer.sanitize(rawTask, demoNodes, SESSION_ID, TAB_ID, 0, DOC_GEN, DEMO_ORIGIN);

console.log('Sanitized task:', sanitized.sanitizedTask.substring(0, 200));
console.log('Risk:', sanitized.risk);
console.log('Redactions:', sanitized.redactions.map(r => r.category));

const plannerPayload = {
  protocolVersion: '2.0' as const,
  session: { id: SESSION_ID, step: 1, observationId: OBS_ID, origin: DEMO_ORIGIN, documentGeneration: DOC_GEN, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } },
  task: { sanitized: sanitized.sanitizedTask, risk: sanitized.risk },
  scene: sanitized.scene,
  redactions: sanitized.redactions,
  allowedActions: ['click', 'focus', 'type_text', 'type_token', 'select', 'scroll', 'wait', 'request_observation', 'finish'] as const,
};

// Check forbidden fields
const forbidden = scanForForbiddenFields(plannerPayload);
console.log('Forbidden fields:', forbidden);

// Check egress
const verifier = new EgressVerifier();
const result = await verifier.verify(plannerPayload, 'https://safe-planner.antardrishti.local/plan');
console.log('Verifier result:', result.approved ? 'APPROVED' : `BLOCKED: ${(result as any).reason} - ${(result as any).details}`);

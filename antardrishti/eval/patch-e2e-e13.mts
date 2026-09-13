/**
 * Patches E13 in eval/test-e2e-demo.mts to use a schema-compliant payload.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const filePath = join(process.cwd(), 'eval', 'test-e2e-demo.mts');
let content = readFileSync(filePath, 'utf8');

// Find and replace the E13 plannerPayload definition
const oldPayload = `  // Build a clean planner request (like coordinator would)
  const plannerPayload = {
    protocolVersion: '2.0',
    session: {
      id: SESSION_ID,
      step: 1,
      observationId: OBS_ID,
      origin: DEMO_ORIGIN,
      documentGeneration: DOC_GEN,
    },
    task: {
      sanitized: sanitized.sanitizedTask,
      risk: sanitized.risk,
    },
    scene: sanitized.scene,
    redactions: sanitized.redactions,
  };`;

const newPayload = `  // Build a schema-compliant planner request (like coordinator would)
  // Note: PlannerRequestSchema requires exact field structure
  const plannerPayload = {
    protocolVersion: '2.0' as const,
    session: {
      id: SESSION_ID,
      step: 1,
      observationId: OBS_ID,
      origin: DEMO_ORIGIN,
      documentGeneration: DOC_GEN,
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    },
    task: {
      sanitized: sanitized.sanitizedTask,
      risk: sanitized.risk,
    },
    scene: sanitized.scene,
    redactions: sanitized.redactions,
    allowedActions: [
      'click', 'focus', 'type_text', 'type_token', 'select',
      'scroll', 'wait', 'request_observation', 'finish',
    ] as const,
  };`;

content = content.replace(oldPayload, newPayload);

writeFileSync(filePath, content, 'utf8');
console.log('Patched E13. File size:', content.length);

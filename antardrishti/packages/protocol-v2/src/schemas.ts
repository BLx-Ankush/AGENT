/**
 * ANTARDRISHTI Protocol v2 — Zod Schemas
 *
 * Runtime validation schemas. Used by the egress verifier to validate
 * the exact payload before transmission. All schemas use strict mode
 * (additionalProperties: false equivalent).
 */

import { z } from 'zod';
import {
  REDACTION_CATEGORIES,
  REDACTION_SHAPES,
  REDACTION_REPRESENTATIONS,
  DISCLOSURE_LEVELS,
  REASON_CODES,
  FORBIDDEN_FIELDS,
} from './redaction';

// ── Shared ───────────────────────────────────────────────────

export const BboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();

export const ViewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  devicePixelRatio: z.number().positive(),
}).strict();

// ── Scene ────────────────────────────────────────────────────

export const PlannerSceneNodeSchema = z.object({
  id: z.string().min(1),
  role: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  bbox: BboxSchema.optional(),
  actionability: z
    .enum([
      'clickable', 'typable', 'selectable',
      'readable', 'non-actionable', 'unknown',
    ])
    .optional(),
  state: z
    .record(z.union([z.boolean(), z.number(), z.string()]))
    .optional(),
}).strict();

export const SceneCoverageSchema = z.object({
  visualGrounding: z.enum([
    'complete-for-task-regions', 'partial', 'none',
  ]),
  unresolvedRegions: z.number().int().min(0),
  structuredGate: z.enum(['passed', 'pending', 'failed']),
  visualGate: z.enum(['passed', 'pending', 'failed', 'not-applicable']),
}).strict();

export const PlannerSceneSchema = z.object({
  nodes: z.array(PlannerSceneNodeSchema).max(500),
  unexplainedRegions: z
    .array(
      z.object({
        visualRegionId: z.string(),
        bbox: BboxSchema,
        description: z.string().optional(),
      }).strict(),
    )
    .optional(),
  coverage: SceneCoverageSchema,
}).strict();

// ── Redaction ────────────────────────────────────────────────

export const RedactionDeclarationSchema = z.object({
  token: z.string().min(1),
  category: z.enum(REDACTION_CATEGORIES),
  shape: z.enum(REDACTION_SHAPES),
  region: z.string().min(1),
  visualRegionId: z.string().optional(),
  representation: z.enum(REDACTION_REPRESENTATIONS),
  disclosure: z.enum(DISCLOSURE_LEVELS),
  reasonCode: z.enum(REASON_CODES),
}).strict();

export const ProtectedVisualRegionSchema = z.object({
  visualRegionId: z.string().min(1),
  category: z.enum(REDACTION_CATEGORIES),
  representation: z.enum(['masked', 'omitted'] as const),
  bbox: BboxSchema,
}).strict();

// ── Planner request ──────────────────────────────────────────

export const PlannerRequestSchema = z.object({
  protocolVersion: z.literal('2.0'),
  session: z.object({
    id: z.string().min(1),
    step: z.number().int().min(0),
    observationId: z.string().min(1),
    origin: z.string().min(1),
    documentGeneration: z.string().min(1),
    viewport: ViewportSchema,
  }).strict(),
  task: z.object({
    sanitized: z.string().min(1).max(2000),
    risk: z.enum(['low', 'medium', 'high']),
  }).strict(),
  scene: PlannerSceneSchema,
  redactions: z.array(RedactionDeclarationSchema),
  protectedVisualRegions: z
    .array(ProtectedVisualRegionSchema)
    .optional(),
  allowedActions: z.array(
    z.enum([
      'click', 'focus', 'type_text', 'type_token', 'select',
      'scroll', 'wait', 'request_observation', 'finish',
    ]),
  ),
}).strict();

// ── Planner response ─────────────────────────────────────────

export const PlannerActionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    'click', 'focus', 'type_text', 'type_token', 'select',
    'scroll', 'wait', 'request_observation', 'finish',
  ]),
  targetNodeId: z.string().optional(),
  token: z.string().optional(),
  text: z.string().optional(),
  optionId: z.string().optional(),
  containerNodeId: z.string().optional(),
  direction: z.enum(['up', 'down']).optional(),
  amount: z.enum(['small', 'page']).optional(),
  milliseconds: z.number().positive().max(30_000).optional(),
  reason: z.string().max(500).optional(),
  expectedRole: z.string().optional(),
  expectedRedactionCategory: z.string().optional(),
  expectedShape: z.string().optional(),
  targetDocumentGeneration: z.string().optional(),
  summary: z.string().max(1000).optional(),
}).strict();

export const PlannerResponseSchema = z.object({
  protocolVersion: z.literal('2.0'),
  observationId: z.string().min(1),
  planId: z.string().min(1),
  expiresAt: z.string(),
  actions: z.array(PlannerActionSchema).min(1).max(10),
}).strict();

// ── Forbidden field scanner ──────────────────────────────────

/**
 * Recursively scan an object for forbidden fields.
 * Returns paths where forbidden fields were found.
 */
export function scanForForbiddenFields(
  obj: unknown,
  path = '',
): string[] {
  const violations: string[] = [];
  if (typeof obj !== 'object' || obj === null) return violations;

  for (const [key, val] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if ((FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      violations.push(currentPath);
    }
    if (typeof val === 'object' && val !== null) {
      violations.push(...scanForForbiddenFields(val, currentPath));
    }
  }
  return violations;
}

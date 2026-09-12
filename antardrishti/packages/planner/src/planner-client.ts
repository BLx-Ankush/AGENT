/**
 * ANTARDRISHTI — Planner Client
 *
 * Planner interface + deterministic fallback + LLM adapter.
 *
 * Contract §17: real server-side LLM/VLM for final SIH demo.
 * Contract §18: deterministic planner is dev/test fallback only.
 *
 * The planner client uses the sealed transport from egress-verifier.
 * It NEVER modifies the sealed payload.
 */

import {
  type AgentAction,
  isAllowedActionKind,
  PlannerResponseSchema,
} from '@antardrishti/protocol-v2';

import {
  EgressVerifier,
  transportSealed,
  type TransportConfig,
  type VerificationResult,
} from '@antardrishti/egress-verifier';

// ── Planner request (input) ──────────────────────────────────

export interface PlannerRequestInput {
  protocolVersion: '2.0';
  session: {
    id: string;
    step: number;
    observationId: string;
    origin: string;
    documentGeneration: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
  };
  task: {
    sanitized: string;
    risk: 'low' | 'medium' | 'high';
  };
  scene: unknown;
  redactions: unknown[];
  protectedVisualRegions?: unknown[];
  allowedActions: string[];
}

// ── Planner response (output) ────────────────────────────────

export interface PlannerResponse {
  protocolVersion: '2.0';
  observationId: string;
  planId: string;
  expiresAt: string;
  actions: AgentAction[];
}

// ── Planner interface ────────────────────────────────────────

export interface PlannerAdapter {
  readonly name: string;
  readonly isDeterministic: boolean;
  plan(request: PlannerRequestInput): Promise<PlannerResponse>;
}

// ── Deterministic Fallback Planner ───────────────────────────

/**
 * Deterministic planner: DEVELOPMENT/TEST FALLBACK ONLY.
 * Uses simple heuristics to generate actions from the scene.
 *
 * Does NOT make any network calls. Returns hardcoded plans
 * based on pattern matching the task + scene.
 */
export class DeterministicPlanner implements PlannerAdapter {
  readonly name = 'deterministic-fallback';
  readonly isDeterministic = true;

  async plan(request: PlannerRequestInput): Promise<PlannerResponse> {
    const { task, scene, session } = request;
    const taskLower = task.sanitized.toLowerCase();
    const nodes = (scene as any)?.nodes || [];

    const actions: AgentAction[] = [];
    let actionId = 0;

    // Pattern: "click" + target name
    const clickMatch = taskLower.match(/click\s+(?:on\s+)?(?:the\s+)?["']?([^"']+)["']?/);
    if (clickMatch) {
      const target = clickMatch[1].toLowerCase();
      const matchNode = nodes.find((n: any) =>
        n.name?.toLowerCase()?.includes(target) ||
        n.role === 'button' || n.role === 'link',
      );
      if (matchNode) {
        actions.push({
          kind: 'click',
          id: `action-${++actionId}`,
          targetNodeId: matchNode.id,
          expectedRole: matchNode.role,
          reason: `Click "${target}"`,
        });
      }
    }

    // Pattern: "type" + field + text
    const typeMatch = taskLower.match(/(?:type|enter|fill)\s+["']?([^"']+)["']?\s+(?:in|into)\s+["']?([^"']+)["']?/);
    if (typeMatch) {
      const text = typeMatch[1];
      const target = typeMatch[2].toLowerCase();
      const matchNode = nodes.find((n: any) =>
        n.name?.toLowerCase()?.includes(target) &&
        (n.actionability === 'typable' || n.role === 'textbox'),
      );
      if (matchNode) {
        // Check if the text looks like a token
        if (text.startsWith('<SENSITIVE_')) {
          actions.push({
            kind: 'type_token',
            id: `action-${++actionId}`,
            targetNodeId: matchNode.id,
            token: text,
            expectedRole: matchNode.role,
            reason: `Type token into "${target}"`,
          });
        } else {
          actions.push({
            kind: 'type_text',
            id: `action-${++actionId}`,
            targetNodeId: matchNode.id,
            text,
            expectedRole: matchNode.role,
          });
        }
      }
    }

    // If no specific actions, request observation
    if (actions.length === 0) {
      actions.push({
        kind: 'request_observation',
        id: `action-${++actionId}`,
        reason: 'No actionable pattern found, requesting fresh observation',
      });
    }

    return {
      protocolVersion: '2.0',
      observationId: session.observationId,
      planId: `det-plan-${Date.now()}`,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      actions,
    };
  }
}

// ── Server LLM Planner Adapter ───────────────────────────────

/**
 * Server-side LLM/VLM planner adapter.
 * Uses the sealed transport from egress-verifier.
 * Contract §17: real LLM for SIH demo.
 */
export class ServerPlannerAdapter implements PlannerAdapter {
  readonly name = 'server-llm';
  readonly isDeterministic = false;

  private verifier: EgressVerifier;
  private transportConfig: TransportConfig;

  constructor(plannerUrl: string, timeoutMs = 30_000) {
    this.verifier = new EgressVerifier({
      allowedPlannerOrigin: new URL(plannerUrl).origin,
    });
    this.transportConfig = {
      plannerUrl,
      timeoutMs,
    };
  }

  async plan(request: PlannerRequestInput): Promise<PlannerResponse> {
    // 1. Verify through egress verifier
    const verification = await this.verifier.verify(
      request,
      this.transportConfig.plannerUrl,
    );

    if (!verification.approved) {
      throw new Error(
        `Egress blocked: ${(verification as any).reason} [${(verification as any).category}]`,
      );
    }

    // 2. Transport sealed bytes
    const result = await transportSealed(verification, this.transportConfig);

    if (!result.success) {
      throw new Error(`Planner request failed: ${result.error}`);
    }

    // 3. Validate response
    const responseData = JSON.parse(result.body);
    const responseResult = PlannerResponseSchema.safeParse(responseData);

    if (!responseResult.success) {
      throw new Error(
        `Invalid planner response: ${responseResult.error.issues.map(i => i.message).join('; ')}`,
      );
    }

    // 4. Validate all action kinds are allowed
    for (const action of responseResult.data.actions) {
      if (!isAllowedActionKind(action.kind)) {
        throw new Error(`Planner returned disallowed action kind: ${action.kind}`);
      }
    }

    return responseResult.data as unknown as PlannerResponse;
  }
}

/**
 * ANTARDRISHTI Protocol v2 — Scene Types (planner-visible)
 *
 * These are the sanitized scene types sent to the planner.
 * Raw values, vault references, and DOM selectors are excluded.
 */

/** Planner-visible scene node. Contains only safe information. */
export interface PlannerSceneNode {
  id: string;
  role?: string;
  name?: string;
  /** May be a token like <SENSITIVE_XXXX>, never a raw value */
  value?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  actionability?:
    | 'clickable'
    | 'typable'
    | 'selectable'
    | 'readable'
    | 'non-actionable'
    | 'unknown';
  state?: Record<string, boolean | number | string>;
}

/** Coverage information for the scene. */
export interface SceneCoverage {
  visualGrounding: 'complete-for-task-regions' | 'partial' | 'none';
  unresolvedRegions: number;
  structuredGate: 'passed' | 'pending' | 'failed';
  visualGate: 'passed' | 'pending' | 'failed' | 'not-applicable';
}

/** Planner-visible scene. No raw values, no DOM selectors. */
export interface PlannerScene {
  nodes: PlannerSceneNode[];
  unexplainedRegions?: Array<{
    visualRegionId: string;
    bbox: { x: number; y: number; width: number; height: number };
    description?: string;
  }>;
  coverage: SceneCoverage;
}

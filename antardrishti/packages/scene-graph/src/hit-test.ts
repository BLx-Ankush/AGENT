/**
 * ANTARDRISHTI — Hit-Test Helper
 *
 * Verifies that an element at a given point is the expected target.
 * Detects transparent overlays, z-index interception, and
 * off-screen elements. Used before every click action.
 */

import type { SceneNode } from './scene-node';

export interface HitTestResult {
  /** Whether the expected target is the top-most element at the point */
  isTopmost: boolean;
  /** The actual element found at the point */
  actualTag: string;
  /** The actual element's role */
  actualRole: string;
  /** Whether an overlay was detected intercepting the target */
  overlayDetected: boolean;
  /** Description of the issue if not topmost */
  issue?: string;
}

/**
 * Perform a hit-test at the center of a scene node's bbox.
 * Returns whether the expected element is the topmost at that point.
 */
export function hitTestNode(
  expectedNodeId: string,
  bbox: { x: number; y: number; w: number; h: number },
): HitTestResult {
  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;

  const hitEl = document.elementFromPoint(centerX, centerY);

  if (!hitEl) {
    return {
      isTopmost: false,
      actualTag: 'none',
      actualRole: 'none',
      overlayDetected: false,
      issue: 'No element at target point',
    };
  }

  const actualTag = hitEl.tagName.toLowerCase();
  const actualRole = hitEl.getAttribute('role') || inferBasicRole(hitEl);

  // Check if the hit element is an overlay
  const overlayDetected = isTransparentOverlay(hitEl);

  // For now, we compare the element at point with the expected bbox
  // Full verification needs the actual DOM node reference (Phase 7)
  const hitRect = hitEl.getBoundingClientRect();
  const bboxMatch =
    Math.abs(hitRect.x - bbox.x) < 5 &&
    Math.abs(hitRect.y - bbox.y) < 5 &&
    Math.abs(hitRect.width - bbox.w) < 5 &&
    Math.abs(hitRect.height - bbox.h) < 5;

  return {
    isTopmost: bboxMatch,
    actualTag,
    actualRole,
    overlayDetected,
    issue: bboxMatch ? undefined : overlayDetected
      ? 'Transparent overlay intercepting target'
      : `Different element at point: ${actualTag}[${actualRole}]`,
  };
}

/**
 * Multi-point hit-test for better coverage.
 * Tests center and four quadrant points.
 */
export function hitTestMultiPoint(
  bbox: { x: number; y: number; w: number; h: number },
): { hitElements: Set<string>; overlayDetected: boolean } {
  const points = [
    { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 }, // center
    { x: bbox.x + bbox.w * 0.25, y: bbox.y + bbox.h * 0.25 }, // top-left quad
    { x: bbox.x + bbox.w * 0.75, y: bbox.y + bbox.h * 0.25 }, // top-right quad
    { x: bbox.x + bbox.w * 0.25, y: bbox.y + bbox.h * 0.75 }, // bottom-left quad
    { x: bbox.x + bbox.w * 0.75, y: bbox.y + bbox.h * 0.75 }, // bottom-right quad
  ];

  const hitElements = new Set<string>();
  let overlayDetected = false;

  for (const { x, y } of points) {
    const el = document.elementFromPoint(x, y);
    if (el) {
      hitElements.add(el.tagName.toLowerCase());
      if (isTransparentOverlay(el)) {
        overlayDetected = true;
      }
    }
  }

  return { hitElements, overlayDetected };
}

/**
 * Detect transparent overlays that intercept clicks.
 */
function isTransparentOverlay(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);

  // Common overlay patterns: full-size, transparent, high z-index
  const isFullSize =
    el.offsetWidth >= window.innerWidth * 0.8 &&
    el.offsetHeight >= window.innerHeight * 0.8;
  const isTransparent =
    parseFloat(style.opacity) < 0.1 ||
    style.backgroundColor === 'transparent' ||
    style.backgroundColor === 'rgba(0, 0, 0, 0)';
  const isHighZ = parseInt(style.zIndex) > 100;

  return isFullSize && isTransparent && isHighZ;
}

function inferBasicRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') return 'textbox';
  return 'generic';
}

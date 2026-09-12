/**
 * ANTARDRISHTI — Capture Pipeline
 *
 * Captures the visible tab, generates capture stamps, and manages
 * the tile engine for changed-region detection.
 *
 * INVARIANT: Raw screenshots stay in memory only. ZERO network calls.
 * Raw image data is NEVER serialized to planner requests.
 */

import {
  type CaptureStamp,
  type ObservationId,
  createObservationId,
  computeCaptureHash,
} from '@antardrishti/protocol-v2';

// ── Types ────────────────────────────────────────────────────

export interface CaptureResult {
  observationId: ObservationId;
  stamp: CaptureStamp;
  /** Raw image data — LOCAL ONLY, never serialized to planner */
  imageDataUrl: string;
  width: number;
  height: number;
  tileCount: number;
  tileHashes: Map<string, string>;
  changedTileIds: string[];
}

interface TileInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Configuration ────────────────────────────────────────────

const TILE_SIZE = 256;
const SAFETY_MARGIN = 16;

// ── Capture Manager ──────────────────────────────────────────

export class CaptureManager {
  private previousTileHashes = new Map<string, string>();
  private lastStamp: CaptureStamp | null = null;

  /**
   * Capture the visible tab.
   * Requires activeTab permission / user gesture.
   * Raw image data stays LOCAL — never transmitted.
   */
  async captureVisibleTab(tabId: number): Promise<CaptureResult> {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) throw new Error('Cannot capture tab without URL');

    const origin = new URL(tab.url).origin;
    const now = new Date().toISOString();

    // Capture — requires activeTab permission
    const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    });

    // Parse PNG header for dimensions (service worker has no Image/DOM)
    const { width, height } = this.parsePngDimensions(imageDataUrl);

    // Build capture stamp
    const stampFields = {
      tabId,
      frameTreeGeneration: `ftg-${Date.now()}`,
      topOrigin: origin,
      documentGeneration: `doc-${tab.id}-${Date.now()}`,
      viewportWidth: width,
      viewportHeight: height,
      devicePixelRatio: 1,
      zoom: 1,
      scrollX: 0,
      scrollY: 0,
      capturedAt: now,
    };

    const hash = await computeCaptureHash(stampFields);
    const stamp: CaptureStamp = { ...stampFields, hash };

    // Generate tile grid and compute hashes
    const observationId = createObservationId();
    const tiles = this.generateTileGrid(width, height);
    const tileHashes = new Map<string, string>();

    for (const tile of tiles) {
      // Phase 1: position-based hash. Phase 3: pixel-content hash via OffscreenCanvas.
      tileHashes.set(tile.id, `${tile.id}-${hash.substring(0, 8)}`);
    }

    const changedTileIds = this.detectChangedTiles(tileHashes);

    this.previousTileHashes = new Map(tileHashes);
    this.lastStamp = stamp;

    return {
      observationId,
      stamp,
      imageDataUrl,
      width,
      height,
      tileCount: tiles.length,
      tileHashes,
      changedTileIds,
    };
  }

  /** Generate a tile grid covering the viewport. */
  private generateTileGrid(width: number, height: number): TileInfo[] {
    const tiles: TileInfo[] = [];
    const cols = Math.ceil(width / TILE_SIZE);
    const rows = Math.ceil(height / TILE_SIZE);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * TILE_SIZE;
        const y = row * TILE_SIZE;
        tiles.push({
          id: `tile-${row}-${col}`,
          x,
          y,
          width: Math.min(TILE_SIZE, width - x),
          height: Math.min(TILE_SIZE, height - y),
        });
      }
    }
    return tiles;
  }

  /** Detect tiles that changed since the last capture. */
  private detectChangedTiles(current: Map<string, string>): string[] {
    if (this.previousTileHashes.size === 0) {
      return Array.from(current.keys()); // first capture → all changed
    }
    const changed: string[] = [];
    for (const [tileId, hash] of current) {
      if (this.previousTileHashes.get(tileId) !== hash) {
        changed.push(tileId);
      }
    }
    return changed;
  }

  /**
   * Parse PNG dimensions from a data URL without DOM.
   * PNG IHDR: bytes 16–19 = width, 20–23 = height (big-endian).
   */
  private parsePngDimensions(dataUrl: string): {
    width: number;
    height: number;
  } {
    try {
      const base64 = dataUrl.split(',')[1];
      const bin = atob(base64);
      const width =
        ((bin.charCodeAt(16) << 24) |
          (bin.charCodeAt(17) << 16) |
          (bin.charCodeAt(18) << 8) |
          bin.charCodeAt(19)) >>>
        0;
      const height =
        ((bin.charCodeAt(20) << 24) |
          (bin.charCodeAt(21) << 16) |
          (bin.charCodeAt(22) << 8) |
          bin.charCodeAt(23)) >>>
        0;
      return { width, height };
    } catch {
      console.warn('[Capture] PNG parse failed, using defaults');
      return { width: 1920, height: 1080 };
    }
  }

  /**
   * Invalidate all cached tiles.
   * Called on navigation, zoom, DPR change, document generation change.
   */
  invalidateCache(): void {
    this.previousTileHashes.clear();
    this.lastStamp = null;
    console.log('[Capture] Cache invalidated');
  }

  getLastStamp(): CaptureStamp | null {
    return this.lastStamp;
  }
}

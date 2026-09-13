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

    // Capture - requires activeTab permission
    const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
    });

    // Decode PNG → ImageBitmap → OffscreenCanvas (available in Chrome MV3 SW 109+)
    const { bitmap, width, height } = await this.decodeImageDataUrl(imageDataUrl);

    // Build capture stamp (stamp hash is metadata-only, NOT used for tile content)
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

    // Tile grid + per-tile pixel content hashes
    const observationId = createObservationId();
    const tiles = this.generateTileGrid(width, height);

    // Hash each tile’s pixel content independently
    const tileHashes = await this.computeTileHashes(bitmap, tiles, width, height);
    bitmap.close();

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

  /**
   * Compute per-tile pixel content hashes via OffscreenCanvas.
   *
   * Each tile's RGBA pixel bytes are hashed independently with SHA-256
   * (truncated to 16 hex chars for cache efficiency).
   *
   * This is the fix for the "all tiles always changed" bug where the
   * old implementation used `tileId + globalCaptureHash` as the tile
   * content hash — meaning every tile appeared changed whenever any
   * pixel on the screen changed.
   */
  private async computeTileHashes(
    bitmap: ImageBitmap,
    tiles: TileInfo[],
    _viewportWidth: number,
    _viewportHeight: number,
  ): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();

    // Single shared OffscreenCanvas, resized per tile to avoid allocations
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d')!;

    for (const tile of tiles) {
      // Clear + draw only the tile's region
      ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      ctx.drawImage(
        bitmap,
        tile.x, tile.y,              // source x, y
        tile.width, tile.height,      // source w, h
        0, 0,                          // dest x, y
        tile.width, tile.height,      // dest w, h
      );

      const pixelData = ctx.getImageData(0, 0, tile.width, tile.height);

      // SHA-256 of raw RGBA bytes — crypto.subtle is available in Chrome SW
      const hashBuffer = await crypto.subtle.digest('SHA-256', pixelData.data.buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      // 16 hex chars (64-bit) — sufficient for change detection, minimal memory
      const hex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
      hashes.set(tile.id, hex);
    }

    return hashes;
  }

  /**
   * Decode a PNG data URL to an ImageBitmap + dimensions.
   * Uses createImageBitmap (available in Chrome MV3 service workers).
   */
  private async decodeImageDataUrl(
    dataUrl: string,
  ): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
    // Fast dimension parse from PNG IHDR (no image decode needed)
    const { width, height } = this.parsePngDimensions(dataUrl);

    // Decode PNG → ImageBitmap (GPU-accelerated in Chrome)
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);

    return { bitmap, width: bitmap.width || width, height: bitmap.height || height };
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

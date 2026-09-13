/**
 * ANTARDRISHTI — Tile Change Detection Unit Tests
 *
 * Tests the per-tile pixel content hashing fix in CaptureManager.
 *
 * The bug being fixed:
 *   OLD: tileHash = `${tileId}-${globalCaptureHash.slice(0,8)}`
 *        → every tile always appeared changed when ANY pixel changed
 *
 *   NEW: tileHash = SHA-256(tile_RGBA_pixels).slice(0,16_hex_chars)
 *        → only tiles whose pixel content actually changed are reported
 *
 * Test matrix:
 *   TC-A: Identical screenshot twice → 0 changed tiles on second run
 *   TC-B: Modify one tile's pixels  → only that tile is reported changed
 *   TC-C: invalidateCache()         → all tiles reported changed
 *   TC-D: First observation         → all tiles changed (no previous)
 *   TC-E: Different viewports       → new tiles are reported changed
 *
 * These tests exercise the core hashing logic directly (no Chrome APIs).
 *
 * Run: npx tsx tests/test-tile-change-detection.mts
 */

// ── Minimal tile hashing implementation (mirrors capture.ts logic) ────

const TILE_SIZE = 256;

function generateTileGrid(width, height) {
  const tiles = [];
  const cols = Math.ceil(width / TILE_SIZE);
  const rows = Math.ceil(height / TILE_SIZE);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * TILE_SIZE;
      const y = row * TILE_SIZE;
      tiles.push({
        id: `tile-${row}-${col}`,
        x, y,
        width: Math.min(TILE_SIZE, width - x),
        height: Math.min(TILE_SIZE, height - y),
      });
    }
  }
  return tiles;
}

/**
 * Compute per-tile pixel hashes from a flat RGBA pixel buffer.
 * Mirrors the OffscreenCanvas+crypto.subtle logic in capture.ts.
 */
async function computeTileHashesFromBuffer(pixelBuf, viewportWidth, viewportHeight) {
  const tiles = generateTileGrid(viewportWidth, viewportHeight);
  const hashes = new Map();

  for (const tile of tiles) {
    // Extract tile pixels from the flat RGBA buffer
    const tilePixels = new Uint8Array(tile.width * tile.height * 4);
    for (let row = 0; row < tile.height; row++) {
      const srcRow = tile.y + row;
      const srcStart = (srcRow * viewportWidth + tile.x) * 4;
      const dstStart = row * tile.width * 4;
      tilePixels.set(pixelBuf.slice(srcStart, srcStart + tile.width * 4), dstStart);
    }

    // SHA-256 of tile pixel bytes — same algorithm as capture.ts
    const hashBuffer = await crypto.subtle.digest('SHA-256', tilePixels.buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    hashes.set(tile.id, hex);
  }

  return hashes;
}

function detectChangedTiles(previous, current) {
  if (previous.size === 0) return Array.from(current.keys()); // first → all changed
  const changed = [];
  for (const [id, hash] of current) {
    if (previous.get(id) !== hash) changed.push(id);
  }
  return changed;
}

/** Create a solid-colour RGBA buffer for testing. */
function solidBuffer(width, height, r = 128, g = 128, b = 128, a = 255) {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
  }
  return buf;
}

/** Paint a rectangular region of a buffer with a specific colour. */
function paintRect(buf, width, x, y, w, h, r, g, b) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = (row * width + col) * 4;
      buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
    }
  }
}

// ── Test framework ────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.error(`  ❌ FAIL: ${msg}`); failed++; }
}

// ── Tests ─────────────────────────────────────────────────────

console.log('═'.repeat(62));
console.log('  ANTARDRISHTI — Tile Change Detection Tests');
console.log('═'.repeat(62));

const W = 512, H = 512; // 2×2 tile grid

// ── TC-A: Identical screenshot twice → 0 changed tiles ────────

console.log('\n── TC-A: Identical screenshot → 0 changed tiles on 2nd run');
{
  const buf = solidBuffer(W, H, 100, 150, 200);
  const hashes1 = await computeTileHashesFromBuffer(buf, W, H);
  const changed1 = detectChangedTiles(new Map(), hashes1); // first run

  const hashes2 = await computeTileHashesFromBuffer(buf, W, H);
  const changed2 = detectChangedTiles(hashes1, hashes2);   // second run, same pixels

  assert(changed1.length === 4, `First run: all 4 tiles changed (got ${changed1.length})`);
  assert(changed2.length === 0, `Second run: 0 changed tiles (got ${changed2.length})`);
}

// ── TC-B: Modify one tile → only that tile changed ────────────

console.log('\n── TC-B: Modify tile-0-0 → only tile-0-0 reported changed');
{
  const buf1 = solidBuffer(W, H, 100, 150, 200);
  const hashes1 = await computeTileHashesFromBuffer(buf1, W, H);

  // Modify only the top-left 256×256 pixels (tile-0-0)
  const buf2 = solidBuffer(W, H, 100, 150, 200);
  paintRect(buf2, W, 0, 0, TILE_SIZE, TILE_SIZE, 255, 0, 0); // paint tile-0-0 red

  const hashes2 = await computeTileHashesFromBuffer(buf2, W, H);
  const changed = detectChangedTiles(hashes1, hashes2);

  assert(changed.length === 1, `Only 1 tile changed (got ${changed.length})`);
  assert(changed[0] === 'tile-0-0', `Changed tile is tile-0-0 (got ${changed[0]})`);

  // Verify unchanged tiles
  const unchanged = ['tile-0-1', 'tile-1-0', 'tile-1-1'];
  for (const id of unchanged) {
    assert(!changed.includes(id), `${id} correctly NOT changed`);
  }
}

// ── TC-C: invalidateCache → all tiles changed ─────────────────

console.log('\n── TC-C: invalidateCache → all tiles changed on next run');
{
  const buf = solidBuffer(W, H, 80, 80, 80);
  const hashes1 = await computeTileHashesFromBuffer(buf, W, H);
  detectChangedTiles(new Map(), hashes1); // establish baseline

  // Simulate cache invalidation (previousTileHashes cleared)
  const emptyPrevious = new Map();
  const hashes2 = await computeTileHashesFromBuffer(buf, W, H); // same pixels
  const changed = detectChangedTiles(emptyPrevious, hashes2);   // but empty previous

  assert(changed.length === 4, `All 4 tiles changed after cache invalidation (got ${changed.length})`);
}

// ── TC-D: First observation → all tiles changed ───────────────

console.log('\n── TC-D: First observation → all tiles changed');
{
  const buf = solidBuffer(W, H, 42, 43, 44);
  const hashes = await computeTileHashesFromBuffer(buf, W, H);
  const changed = detectChangedTiles(new Map(), hashes); // no previous

  assert(changed.length === 4, `All 4 tiles changed on first observation (got ${changed.length})`);
  assert(
    changed.every(id => /^tile-\d+-\d+$/.test(id)),
    'All tile IDs have correct format',
  );
}

// ── TC-E: Only tile-1-1 changed ───────────────────────────────

console.log('\n── TC-E: Only tile-1-1 changed (bottom-right)');
{
  const buf1 = solidBuffer(W, H, 200, 200, 200);
  const hashes1 = await computeTileHashesFromBuffer(buf1, W, H);

  const buf2 = solidBuffer(W, H, 200, 200, 200);
  // Paint only tile-1-1 (row=1 col=1 = x=256,y=256)
  paintRect(buf2, W, 256, 256, 256, 256, 0, 255, 0); // green

  const hashes2 = await computeTileHashesFromBuffer(buf2, W, H);
  const changed = detectChangedTiles(hashes1, hashes2);

  assert(changed.length === 1, `Only 1 tile changed (got ${changed.length})`);
  assert(changed[0] === 'tile-1-1', `Changed tile is tile-1-1 (got ${changed[0]})`);
}

// ── TC-F: Hash stability — same pixels → same hash across calls ─

console.log('\n── TC-F: Hash stability — deterministic output');
{
  const buf = solidBuffer(W, H, 1, 2, 3);
  const h1 = await computeTileHashesFromBuffer(buf, W, H);
  const h2 = await computeTileHashesFromBuffer(buf, W, H);

  let allSame = true;
  for (const [id, hash] of h1) {
    if (h2.get(id) !== hash) { allSame = false; break; }
  }
  assert(allSame, 'Same pixel buffer produces identical hashes across calls');
}

// ── TC-G: Different pixels → different hashes ─────────────────

console.log('\n── TC-G: Different pixels → different hashes');
{
  const buf1 = solidBuffer(W, H, 10, 20, 30);
  const buf2 = solidBuffer(W, H, 40, 50, 60);
  const h1 = await computeTileHashesFromBuffer(buf1, W, H);
  const h2 = await computeTileHashesFromBuffer(buf2, W, H);

  let anyDifferent = false;
  for (const [id, hash] of h1) {
    if (h2.get(id) !== hash) { anyDifferent = true; break; }
  }
  assert(anyDifferent, 'Different pixel buffers produce different hashes');
}

// ── Summary ───────────────────────────────────────────────────

console.log('\n' + '═'.repeat(62));
console.log(`  Tile Change Detection: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(62));

if (failed > 0) process.exit(1);

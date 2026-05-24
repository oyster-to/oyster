// Pixel-art sprites for the MP client. Ported from the original
// single-player `docs/arcade/invaders/index.html` so MP's visual
// language matches the SP version. Pure rendering data + a paint
// helper — engine.js stays free of any visual concerns.
//
// Each invader sprite is a pair of frames (toggled every 300 ms in
// the renderer). Each frame is an array of strings, one per row,
// where 'X' = filled pixel, anything else = transparent. paintPixels
// draws them at a given playfield position + scale + colour.

// Per-row pastel palette, top → bottom. Matches the SP arcade pal.
//   row 0 — mint    squid
//   row 1 — pink    crab
//   row 2 — yellow  crab
//   row 3 — orange  octopus
//   row 4 — blue    octopus
export const ROW_COLORS = ['#7adfb1', '#f088bc', '#f0d070', '#f0a070', '#7088dc'];

// 6×8 source. Half a column narrower than the crab/octopus tiers so
// the renderer adds a small horizontal offset to centre it in the
// 8-wide grid cell.
export const SQUID = [
  ['..XX..', '.XXXX.', 'XXXXXX', 'XX..XX', 'XXXXXX', '.X..X.', 'X.XX.X', '.X..X.'],
  ['..XX..', '.XXXX.', 'XXXXXX', 'XX..XX', 'XXXXXX', '.X..X.', 'X....X', 'X.XX.X'],
];
export const SQUID_W = 6;

// 8×8 source.
export const CRAB = [
  ['..X..X..', '...XX...', '..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'X.XXXX.X', 'X.X..X.X', '.X....X.'],
  ['X..X..X.', '.X.XX.X.', 'XXXXXXXX', 'XXX..XXX', 'XXXXXXXX', '.XXXXXX.', 'X......X', '.X....X.'],
];

// 8×8 source.
export const OCTOPUS = [
  ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '..X..X..', '.X.XX.X.', 'X.X..X.X'],
  ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '...XX...', '..X..X..', '.X....X.'],
];

// Pick the invader bitmap for a grid row (0-indexed from the top).
// MP grid is 5 rows: squid / crab / crab / octopus / octopus.
export function spriteForRow(row) {
  if (row === 0) return { frames: SQUID, w: SQUID_W };
  if (row === 1 || row === 2) return { frames: CRAB, w: 8 };
  return { frames: OCTOPUS, w: 8 };
}

// Paint a bitmap to the canvas in playfield units. Each source pixel
// becomes a scale × scale rect. Kept exported for ad-hoc use; the
// invader renderer prefers getInvaderSprite + drawImage so it can
// land non-integer scales (1.5× SP match) without anti-aliased blur.
export function paintPixels(ctx, px, py, pixels, scale, color) {
  ctx.fillStyle = color;
  for (let y = 0; y < pixels.length; y++) {
    const row = pixels[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === 'X') {
        ctx.fillRect(px + x * scale, py + y * scale, scale, scale);
      }
    }
  }
}

// Pre-rendered invader sprite cache. Each row/frame combo gets one
// offscreen canvas at the sprite's native source resolution (8×8 or
// 6×8), painted once at 1:1 — no fractional pixels in the source.
// The renderer later does ctx.drawImage(sprite, dx, dy, dstW, dstH)
// with ctx.imageSmoothingEnabled = false, so the browser does
// nearest-neighbour upscale to the destination size. That keeps
// pixels crisp even at non-integer scales (8→12 at SP's 1.5×
// produces a mix of 1- and 2-PF-wide sprite pixels — the standard
// pixel-art trade for sub-integer scaling, still sharp not blurry).
const _invaderCache = new Map();
export function getInvaderSprite(row, frame) {
  const key = row * 2 + (frame & 1);
  const hit = _invaderCache.get(key);
  if (hit) return hit;

  const { frames, w } = spriteForRow(row);
  const px = frames[frame & 1];
  const h = px.length;
  const color = ROW_COLORS[row] || '#ffffff';

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cctx = canvas.getContext('2d');
  cctx.fillStyle = color;
  for (let y = 0; y < h; y++) {
    const rowStr = px[y];
    for (let x = 0; x < w; x++) {
      if (rowStr[x] === 'X') cctx.fillRect(x, y, 1, 1);
    }
  }
  const sprite = { canvas, w, h };
  _invaderCache.set(key, sprite);
  return sprite;
}

// Player ship — body sits at shipY (the engine's collision top edge);
// turret base + white tip stack upward above it, matching the SP
// cabinet silhouette where the antenna pokes out above the hit box.
export function paintShip(ctx, x, shipY, shipW, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x,            shipY,            shipW,         4); // body
  ctx.fillRect(x + 4,        shipY - 2,        shipW - 8,     2); // turret base
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + shipW/2 - 2, shipY - 4,     4,             2); // turret tip
}

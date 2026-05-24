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
// becomes a scale × scale rect. Used by the invader renderer with
// scale=1.5 to match SP's drawSquid/drawCrab/drawOctopus pipeline —
// the canvas is at display resolution (set via fitCanvas), so
// fractional rects anti-alias at sub-device-pixel level (invisible)
// rather than warping like they would in a low-res CSS-upscaled
// bitmap.
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

// Boss sprite (Phase H — single CRIMSON OCTOPUS type for now).
// 8×8 source painted at scale 5 → 40×40 PF. Two-frame animation
// toggles every ~300 ms in the renderer. Body uses a 3-band gradient
// (top=highlight, middle=mid red, bottom=deep red) so the chunky
// silhouette reads with some depth instead of as a flat blob.
export const BOSS_FRAMES = [
  ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '..X..X..', '.X.XX.X.', 'X.X..X.X'],
  ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '...XX...', '..X..X..', '.X....X.'],
];
const BOSS_BAND_COLOURS = ['#ff7a7a', '#e05050', '#c0303a'];   // hi / mid / shadow

export function paintBoss(ctx, x, y, scale, frame) {
  const px = BOSS_FRAMES[frame & 1];
  for (let row = 0; row < px.length; row++) {
    const band = row < 3 ? 0 : (row < 5 ? 1 : 2);
    ctx.fillStyle = BOSS_BAND_COLOURS[band];
    const cells = px[row];
    const py = y + row * scale;
    for (let col = 0; col < cells.length; col++) {
      if (cells[col] === 'X') ctx.fillRect(x + col * scale, py, scale, scale);
    }
  }
}

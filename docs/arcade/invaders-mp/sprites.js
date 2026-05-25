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

// Boss sprite roster (Phase H/2). 4 types — one per set — ported
// from SP's BOSS_TYPES. Each entry: two 8×8 frames + a 3-band colour
// gradient (hi → mid → shadow, applied to rows 0-2, 3-4, 5-7).
// Painted at scale 5 → 40×40 PF; 2-frame anim toggles every ~300 ms.
//
// Set rotation: stageSet 1 → CRIMSON OCTOPUS, 2 → VIOLET CRAB,
// 3 → AZURE SQUID, 4 → JADE SKULL. Defeating the JADE SKULL boss
// triggers the win cutscene — the game has a real end.
export const BOSS_TYPES = [
  {
    name: 'CRIMSON OCTOPUS',
    frames: [
      ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '..X..X..', '.X.XX.X.', 'X.X..X.X'],
      ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '...XX...', '..X..X..', '.X....X.'],
    ],
    bands: ['#ff7a7a', '#e05050', '#c0303a'],
  },
  {
    name: 'VIOLET CRAB',
    frames: [
      ['.X....X.', '..X..X..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', 'X.XXXX.X', '.X....X.', 'X.X..X.X'],
      ['X.X..X.X', '.X.XX.X.', 'XXXXXXXX', 'XXX..XXX', 'XXXXXXXX', '.XXXXXX.', 'X......X', '.X....X.'],
    ],
    bands: ['#b080f0', '#8050d0', '#5020a0'],
  },
  {
    name: 'AZURE SQUID',
    frames: [
      ['...XX...', '..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', '.X....X.', 'X.X..X.X'],
      ['...XX...', '..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XX.XX.XX', 'XXXXXXXX', 'X......X', '.X.XX.X.'],
    ],
    bands: ['#50d0f0', '#30a0c0', '#1070a0'],
  },
  {
    name: 'JADE SKULL',
    frames: [
      ['.XXXXXX.', 'X.XXXX.X', 'XXXXXXXX', 'X.X..X.X', 'XXXXXXXX', 'XX.XX.XX', 'X.XXXX.X', '.X.XX.X.'],
      ['.XXXXXX.', 'X.XXXX.X', 'XXXXXXXX', 'X.X..X.X', 'XXXXXXXX', 'XXX..XXX', 'X.XXXX.X', '..X..X..'],
    ],
    bands: ['#60c060', '#408040', '#205020'],
  },
];

// Paint a boss frame at (x, y) PF coords using a SINGLE body color.
// SP matches its boss palette to HP — healthy → bands[0], hurt →
// bands[1], near-dead → bands[2] — so the caller picks the band
// index from boss.hp / boss.hpMax. `type` is an index into
// BOSS_TYPES; out-of-range defensively falls back to the first.
// (Earlier H/2 builds applied a 3-row hi/mid/shadow gradient — but
// SP never did that; it's a single-colour silhouette.)
export function paintBoss(ctx, x, y, scale, frame, type, bandIndex) {
  const def = BOSS_TYPES[type | 0] || BOSS_TYPES[0];
  const px = def.frames[frame & 1];
  ctx.fillStyle = def.bands[Math.max(0, Math.min(2, bandIndex | 0))];
  for (let row = 0; row < px.length; row++) {
    const cells = px[row];
    const py = y + row * scale;
    for (let col = 0; col < cells.length; col++) {
      if (cells[col] === 'X') ctx.fillRect(x + col * scale, py, scale, scale);
    }
  }
}

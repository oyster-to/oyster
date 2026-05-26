// Arcade.Engine — pure game primitives.
//
// The "game primitive" layer of the arcade framework, distinct from the
// cabinet chrome (Arcade.Audio / Music / Splash / Pause / Touch / Initials /
// Leaderboard / EndOverlay). Everything here is pure (no DOM lookups at load,
// no module state); a game includes engine.js and calls the helpers directly.
//
//   Arcade.Engine.canvas.configure(canvas, { maxDpr })  -> backing store + DPR transform; returns facts
//   Arcade.Engine.rectsOverlap(ax,ay,aw,ah, bx,by,bw,bh) -> strict AABB overlap (touching edges => false)
//   Arcade.Engine.rand.tileHash(i)                       -> stable pseudo-random in [0,1) keyed by index
//   Arcade.Engine.draw.circle(ctx, cx, cy, r)            -> filled disc via integer scanlines

(function () {
  // canvas.configure — owns ONLY the backing store + 2D transform, never layout
  // (no letterboxing / tile sizing / camera; the game maps its world from the
  // returned facts). DPR is opt-in and capped: maxDpr defaults to 1, so the
  // default is rendering-equivalent to a plain `canvas.width = cssWidth`.
  //
  // FOOTGUN: this resets the 2D transform on every call — to (dpr,0,0,dpr,0,0),
  // i.e. identity when dpr === 1. Call it on resize, NOT per-frame (setting
  // canvas.width clears the canvas). A game that applies its own persistent
  // transform must re-apply it after configure().
  function configure(canvas, opts) {
    opts = opts || {};
    const maxDpr = Math.max(1, Number(opts.maxDpr) || 1);   // guards 0 / null / NaN / negative
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, cssWidth, cssHeight, dpr, pixelWidth, pixelHeight };
  }

  // Strict axis-aligned bounding-box overlap. Touching edges return false
  // (named rectsOverlap rather than aabb so it reads for non-game-dev callers).
  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // Stable per-index pseudo-random in [0,1). Keyed off the index (not a
  // per-frame value), so whatever it drives is stable across frames.
  function tileHash(i) {
    let x = ((i | 0) + 100000) >>> 0;
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  }

  // Filled disc via integer scanlines. Caller sets ctx.fillStyle first; pass
  // any 2D context (main or offscreen). Top/bottom rows (y = ±r) round to w=0
  // → zero-width no-op rects, giving small discs a slight flat cap; this is the
  // verbatim algorithm the games already ship, kept as-is for rendering parity.
  function circle(ctx, cx, cy, r) {
    for (let y = -r; y <= r; y++) {
      const w = Math.round(Math.sqrt(r * r - y * y));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
    }
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Engine = {
    canvas: { configure },
    rectsOverlap,
    rand: { tileHash },
    draw: { circle },
  };
})();

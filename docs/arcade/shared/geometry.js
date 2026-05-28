// Simulation-safe geometry primitives — pure functions with no DOM, no
// globals, no environment assumptions. Safe to import from both the
// browser (game code) and Cloudflare Workers (server-authoritative
// simulation).
//
// Distinct from `shared/engine.js`, which owns the browser-facing
// `Arcade.Engine` surface (canvas configuration, render helpers,
// chrome-adjacent primitives). This module is the simulation layer's
// own primitive — narrower, dependency-free, ESM-only.
//
// The browser-facing `Arcade.Engine.rectsOverlap` (in shared/engine.js)
// keeps an inline copy of the same one-liner so the IIFE attach pattern
// stays synchronous; both paths return identical results.

// Strict AABB overlap test — touching edges do NOT count as overlapping.
// Args are flat scalars (not objects) so callsites pass whatever shape
// of rect they hold without allocating.
export function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

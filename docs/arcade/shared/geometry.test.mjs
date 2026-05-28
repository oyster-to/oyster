// Tests for shared/geometry.js — run with `node geometry.test.mjs`.
//
// geometry.js is the ESM-only source of truth for the rectsOverlap
// primitive used by simulation code that runs in both the browser
// (game host-mode client) and a Cloudflare Worker (server-authoritative
// sim). The IIFE copy on `Arcade.Engine.rectsOverlap` in
// shared/engine.js is exercised separately by engine.test.cjs; this
// file locks the ESM copy so the two paths can't silently drift.

import { rectsOverlap } from './geometry.js';

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}

// Clear overlap — A's right edge crosses into B.
check('overlapping rects', rectsOverlap(0, 0, 10, 10, 5, 5, 10, 10), true);

// Disjoint along x.
check('disjoint along x', rectsOverlap(0, 0, 5, 5, 10, 0, 5, 5), false);

// Disjoint along y.
check('disjoint along y', rectsOverlap(0, 0, 5, 5, 0, 10, 5, 5), false);

// A fully contains B.
check('containment', rectsOverlap(0, 0, 20, 20, 5, 5, 5, 5), true);

// Strict edge-touching — A's right edge (x=10) meets B's left edge
// (x=10). Touching does NOT count as overlapping. This is the
// load-bearing property that distinguishes rectsOverlap from a
// non-strict variant; bullets that just barely kiss an invader's
// edge should not register a hit.
check('edge-touching x (strict)', rectsOverlap(0, 0, 10, 10, 10, 0, 10, 10), false);
check('edge-touching y (strict)', rectsOverlap(0, 0, 10, 10, 0, 10, 10, 10), false);

// One-pixel overlap on the x edge.
check('1-pixel overlap x', rectsOverlap(0, 0, 11, 10, 10, 0, 10, 10), true);

if (failures) {
  console.log(`\n${failures} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');

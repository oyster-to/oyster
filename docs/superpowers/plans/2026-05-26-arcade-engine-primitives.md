# Arcade Engine Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `shared/engine.js` module (`Arcade.Engine`) holding four pure game primitives — `canvas.configure`, `rectsOverlap`, `rand.tileHash`, `draw.circle` — and adopt them in the single-player games with no rendering change.

**Architecture:** A plain IIFE in `docs/arcade/shared/`, same pattern as the existing chrome modules (audio/music/splash/…), exposing one namespace `window.Arcade.Engine`. The games adopt it by replacing their local definitions with thin forwarders (so existing call sites are untouched), keeping the change mechanical and rendering-equivalent. DPR support is opt-in and capped; the default reproduces today's behaviour.

**Tech Stack:** Vanilla browser JS (no build step). Node-based unit tests via `vm` (`*.test.cjs`), run with `node <file>`. Manual browser parity check via `python3 -m http.server`.

**Spec:** `docs/superpowers/specs/2026-05-26-arcade-engine-primitives-design.md`

**Scope note:** Per spec, this slice is **pure helpers only**. The game loop, tilemap collision resolver, and `draw.pixels` are explicitly out of scope. Per a follow-up scoping decision, **Invaders adopts `canvas.configure` only** this slice — converting its inline collision conditionals to `rectsOverlap` is deferred (a higher-risk hand-rewrite; `rectsOverlap` is already proven by Space Jumper). No CHANGELOG entry (arcade is out of consumer-changelog scope).

---

## File structure

- **Create** `docs/arcade/shared/engine.js` — the `Arcade.Engine` module.
- **Create** `docs/arcade/shared/engine.test.cjs` — node unit tests for all four helpers.
- **Modify** `docs/arcade/space-jumper/index.html` — add the `<script>` tag; adopt `canvas.configure` + forward `aabbOverlap`/`tileHash`/`fillCircle`/`fillCircleOn` to the shared helpers.
- **Modify** `docs/arcade/invaders/index.html` — add the `<script>` tag; adopt `canvas.configure` in `resize()`.
- **Modify** `docs/arcade/shared/README.md` — document the module (table row + two-layer note + the `configure` transform footgun).

---

## Task 1: Create the `Arcade.Engine` module (TDD)

**Files:**
- Create: `docs/arcade/shared/engine.js`
- Test: `docs/arcade/shared/engine.test.cjs`

- [ ] **Step 1: Write the failing test**

Create `docs/arcade/shared/engine.test.cjs` with exactly this content:

```js
// Tests for Arcade.Engine — run with `node engine.test.cjs`.
// Loads the real shared/engine.js into a DOM stub, then checks canvas.configure
// (DPR cap + clamp + backing-store sizing + transform reset + returned facts),
// rectsOverlap (strict AABB), rand.tileHash (stable PRNG), and draw.circle
// (integer scanline spans).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console };
sandbox.window = sandbox;
sandbox.devicePixelRatio = 1;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8'), sandbox);
const E = sandbox.Arcade.Engine;

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ---- mock canvas + 2D context --------------------------------------------
function makeCanvas(cssW, cssH) {
  const ctx = {
    _transform: null,
    _rects: [],
    fillStyle: '',
    setTransform(a, b, c, d, e, f) { this._transform = [a, b, c, d, e, f]; },
    fillRect(x, y, w, h) { this._rects.push([x, y, w, h]); },
  };
  return {
    width: 0,
    height: 0,
    getBoundingClientRect() { return { width: cssW, height: cssH }; },
    getContext() { return ctx; },
  };
}

// ---- canvas.configure -----------------------------------------------------
// maxDpr omitted => dpr 1 even on a high-density device.
sandbox.devicePixelRatio = 2;
let c = makeCanvas(800, 600);
let s = E.canvas.configure(c);
check('maxDpr omitted => dpr 1', s.dpr, 1);
check('omitted: backing width = css*1', c.width, 800);
check('omitted: backing height = css*1', c.height, 600);

// devicePixelRatio 3 + maxDpr 2 => dpr 2, backing = css*2.
sandbox.devicePixelRatio = 3;
c = makeCanvas(800, 600);
s = E.canvas.configure(c, { maxDpr: 2 });
check('dpr capped at maxDpr', s.dpr, 2);
check('backing width = css*dpr', c.width, 1600);
check('backing height = css*dpr', c.height, 1200);
check('transform reset to (dpr,0,0,dpr,0,0)', c.getContext()._transform, [2, 0, 0, 2, 0, 0]);
check('returns the five facts + ctx', [s.cssWidth, s.cssHeight, s.dpr, s.pixelWidth, s.pixelHeight, !!s.ctx], [800, 600, 2, 1600, 1200, true]);

// invalid maxDpr values are clamped to 1.
sandbox.devicePixelRatio = 2;
for (const bad of [0, null, NaN, -2]) {
  const cc = makeCanvas(100, 100);
  const ss = E.canvas.configure(cc, { maxDpr: bad });
  check(`invalid maxDpr ${JSON.stringify(bad)} => dpr 1`, ss.dpr, 1);
}

// ---- rectsOverlap (strict AABB) ------------------------------------------
check('overlapping rects => true', E.rectsOverlap(0, 0, 10, 10, 5, 5, 10, 10), true);
check('disjoint rects => false', E.rectsOverlap(0, 0, 10, 10, 20, 20, 5, 5), false);
check('edge-touching => false (strict)', E.rectsOverlap(0, 0, 10, 10, 10, 0, 10, 10), false);

// ---- rand.tileHash --------------------------------------------------------
check('tileHash deterministic', E.rand.tileHash(7), E.rand.tileHash(7));
checkTrue('tileHash in [0,1)', E.rand.tileHash(7) >= 0 && E.rand.tileHash(7) < 1);
checkTrue('tileHash varies by index', E.rand.tileHash(1) !== E.rand.tileHash(2));
checkTrue('tileHash(0) known value ~0.2655', Math.abs(E.rand.tileHash(0) - 0.2655) < 1e-3);

// ---- draw.circle (integer scanlines) -------------------------------------
const dctx = makeCanvas(10, 10).getContext();
E.draw.circle(dctx, 10, 10, 2);
check('draw.circle scanline spans (r=2 at 10,10)', dctx._rects,
  [[10, 8, 0, 1], [8, 9, 4, 1], [8, 10, 4, 1], [8, 11, 4, 1], [10, 12, 0, 1]]);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd docs/arcade/shared && node engine.test.cjs`
Expected: throws `ENOENT: no such file or directory, open '.../engine.js'` (module doesn't exist yet).

- [ ] **Step 3: Write the module**

Create `docs/arcade/shared/engine.js` with exactly this content:

```js
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
    // Assign css*dpr and read back: the canvas width/height attributes coerce
    // to integers by truncation, so the read-back is the TRUE backing-store size.
    // Matches `canvas.width = rect.width` exactly at dpr 1 (no Math.round drift on
    // fractional CSS pixels) and makes the returned facts equal reality.
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const pixelWidth = canvas.width;
    const pixelHeight = canvas.height;
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
  // any 2D context (main or offscreen).
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd docs/arcade/shared && node engine.test.cjs`
Expected: every line `PASS`, final line `ALL PASS`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add docs/arcade/shared/engine.js docs/arcade/shared/engine.test.cjs
git commit -m "arcade(shared): add Arcade.Engine pure primitives (canvas/rectsOverlap/rand/draw)

New shared/engine.js — the game-primitive layer alongside the cabinet chrome.
canvas.configure owns backing-store + capped DPR transform and returns facts
(never layout); rectsOverlap is a strict AABB test; rand.tileHash is the stable
per-index PRNG; draw.circle is the integer-scanline disc. Node tests in
engine.test.cjs cover DPR cap/clamp, transform reset, strict overlap, PRNG
determinism, and scanline spans.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Adopt in Space Jumper

Space Jumper gets `canvas.configure` plus forwarders for all four of its local
helpers. Forwarders keep the exact signatures, so the 13 `tileHash`, 5
`aabbOverlap`, 1 `fillCircle`, and 4 `fillCircleOn` call sites are untouched.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html`

- [ ] **Step 1: Add the `<script>` tag**

In `docs/arcade/space-jumper/index.html`, after the last shared script tag
(`<script src="../shared/end-overlay.js"></script>`, line ~254), add:

```html
<script src="../shared/engine.js"></script>
```

So the block reads:
```html
<script src="../shared/end-overlay.js"></script>
<script src="../shared/engine.js"></script>
```

- [ ] **Step 2: Adopt `canvas.configure` in `resize()`**

Replace the `resize()` function (currently):
```js
function resize() {
  const rect = canvas.getBoundingClientRect();
  W = canvas.width = rect.width;
  H = canvas.height = rect.height;
}
```
with:
```js
function resize() {
  // Arcade.Engine.canvas.configure sizes the backing store + normalises the
  // transform; default maxDpr:1 keeps this rendering-equivalent. W/H stay in
  // CSS pixels (the game's drawing coordinate space).
  const surface = Arcade.Engine.canvas.configure(canvas);
  W = surface.cssWidth;
  H = surface.cssHeight;
}
```

- [ ] **Step 3: Forward `aabbOverlap` to the shared helper**

Replace the `aabbOverlap` definition (currently):
```js
function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
```
with:
```js
// Forwards to the shared primitive (single source of truth). Same signature,
// so existing call sites are unchanged.
function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return Arcade.Engine.rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh);
}
```

- [ ] **Step 4: Forward `tileHash` to the shared helper**

Replace the `tileHash` definition (currently):
```js
function tileHash(i) {
  let x = ((i | 0) + 100000) >>> 0;
  x = (x * 9301 + 49297) % 233280;
  return x / 233280;
}
```
with (keep the explanatory comment block above it intact):
```js
function tileHash(i) {
  return Arcade.Engine.rand.tileHash(i);
}
```

- [ ] **Step 5: Forward `fillCircle` and `fillCircleOn` to the shared helper**

Replace both definitions (currently):
```js
function fillCircle(cx, cy, r) {
  for (let y = -r; y <= r; y++) {
    const w = Math.round(Math.sqrt(r * r - y * y));
    ctx.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
  }
}
function fillCircleOn(c, cx, cy, r) {
  for (let y = -r; y <= r; y++) {
    const w = Math.round(Math.sqrt(r * r - y * y));
    c.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
  }
}
```
with:
```js
// Forward to the shared scanline disc. fillCircle draws on the main ctx;
// fillCircleOn takes an explicit context (offscreen moon canvas, etc.).
function fillCircle(cx, cy, r) { Arcade.Engine.draw.circle(ctx, cx, cy, r); }
function fillCircleOn(c, cx, cy, r) { Arcade.Engine.draw.circle(c, cx, cy, r); }
```

- [ ] **Step 6: Browser parity check**

Run a local server from the worktree's `docs/`:
```bash
python3 -m http.server 8012 --directory docs
```
Open `http://localhost:8012/arcade/space-jumper/index.html`. Verify:
- Title screen renders (the planet/moon disc — exercises `draw.circle` via `fillCircleOn`).
- No errors in the browser console (e.g. `Arcade.Engine is undefined`).
- Start a run: the player moves/jumps, enemies walk, coins/jetpacks/goal render, collision feels identical (stomp, walls, jetpack refuel on landing — exercises `aabbOverlap` and the unchanged collision code).
- Background props (city/pines/etc.) render stably across frames (exercises `tileHash`).

Stop the server (`Ctrl-C` or `pkill -f "http.server 8012"`).

- [ ] **Step 7: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "arcade(space-jumper): adopt Arcade.Engine primitives

resize() uses Arcade.Engine.canvas.configure (default maxDpr:1, rendering-
equivalent); aabbOverlap/tileHash/fillCircle/fillCircleOn become thin forwarders
to the shared helpers so call sites are untouched. Verified in-browser: title,
gameplay, collision, and per-tile background art render identically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Adopt in Invaders (`canvas.configure` only)

Invaders adopts `canvas.configure`; its inline collision conditionals are left
as-is this slice (deferred per the scope note).

**Files:**
- Modify: `docs/arcade/invaders/index.html`

- [ ] **Step 1: Add the `<script>` tag**

In `docs/arcade/invaders/index.html`, after the last shared script tag
(`<script src="../shared/splash.js"></script>`, line ~93), add:

```html
<script src="../shared/engine.js"></script>
```

So the block reads:
```html
<script src="../shared/splash.js"></script>
<script src="../shared/engine.js"></script>
```

- [ ] **Step 2: Adopt `canvas.configure` in `resize()`**

Replace the `resize()` function (currently):
```js
function resize() {
  const rect = canvas.getBoundingClientRect();
  W = canvas.width = rect.width;
  H = canvas.height = rect.height;
  // Build the washed navy gradient once per resize — matches the splash.
  bgGradient = ctx.createLinearGradient(0, 0, 0, H);
  bgGradient.addColorStop(0, '#0d1a60');
  bgGradient.addColorStop(1, '#050a30');
}
```
with:
```js
function resize() {
  // Arcade.Engine.canvas.configure sizes the backing store + normalises the
  // transform; default maxDpr:1 keeps this rendering-equivalent. W/H stay in
  // CSS pixels (the playfield letterbox + sprites map from these).
  const surface = Arcade.Engine.canvas.configure(canvas);
  W = surface.cssWidth;
  H = surface.cssHeight;
  // Build the washed navy gradient once per resize — matches the splash.
  bgGradient = ctx.createLinearGradient(0, 0, 0, H);
  bgGradient.addColorStop(0, '#0d1a60');
  bgGradient.addColorStop(1, '#050a30');
}
```

- [ ] **Step 3: Browser parity check**

Run a local server from the worktree's `docs/`:
```bash
python3 -m http.server 8012 --directory docs
```
Open `http://localhost:8012/arcade/invaders/index.html`. Verify:
- Title/leaderboard splash renders; no console errors (e.g. `Arcade.Engine is undefined`).
- Start a run: the invader grid, player, bullets, shields, and the navy background gradient render and animate identically; the playfield fills the tube the same as before.

Stop the server (`Ctrl-C` or `pkill -f "http.server 8012"`).

- [ ] **Step 4: Commit**

```bash
git add docs/arcade/invaders/index.html
git commit -m "arcade(invaders): adopt Arcade.Engine.canvas.configure in resize()

resize() uses the shared canvas helper (default maxDpr:1, rendering-equivalent);
the bgGradient build is unchanged. Inline collision tests are left for a later
pass. Verified in-browser: splash + gameplay render identically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Document `engine.js` in the shared README

**Files:**
- Modify: `docs/arcade/shared/README.md`

- [ ] **Step 1: Add the module to the "Module reference" table**

In `docs/arcade/shared/README.md`, in the `## Module reference` table, add this
row after the `splash.js` row (the last data row before the `### Stylesheet
class contracts` heading):

```md
| `engine.js` | `Engine` | none — pure helpers, no DOM lookups at load | Game primitives (the layer below the chrome above): `canvas.configure(canvas,{maxDpr})` (backing store + capped DPR transform, returns `{ctx,cssWidth,cssHeight,dpr,pixelWidth,pixelHeight}`); `rectsOverlap(...)` (strict AABB); `rand.tileHash(i)`; `draw.circle(ctx,cx,cy,r)`. **`canvas.configure` resets the 2D transform on every call — call it on resize, not per-frame.** |
```

- [ ] **Step 2: Add the two-layer note**

In `docs/arcade/shared/README.md`, immediately after the first paragraph
(the line ending "…the CSS sheets style a fixed set of class/id names.") add:

```md
The framework has **two layers**. The modules above are *cabinet chrome* —
`Audio`, `Music`, `Splash`, `Pause`, `Touch`, `Initials`, `Leaderboard`,
`EndOverlay`. `engine.js` adds the *game-primitive* layer under `Arcade.Engine`
(canvas backing-store, rect overlap, stable PRNG, pixel draw) — the building
blocks of a game's own simulation and rendering, not the surrounding cabinet.
```

(If the exact opening wording differs, place this note as its own paragraph
directly after the first paragraph of the file.)

- [ ] **Step 3: Verify it renders sensibly**

Run: `cd docs/arcade/shared && node -e "const t=require('fs').readFileSync('README.md','utf8'); if(!t.includes('engine.js')||!t.includes('two layers')) { console.error('README missing engine.js/two-layer note'); process.exit(1);} console.log('README OK');"`
Expected: `README OK`.

- [ ] **Step 4: Commit**

```bash
git add docs/arcade/shared/README.md
git commit -m "docs(arcade): document engine.js + the chrome/engine two-layer split

Add the engine.js row to the shared module reference (incl. the canvas.configure
transform-reset footgun) and a note framing the two framework layers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cd docs/arcade/shared && node engine.test.cjs` → `ALL PASS`.
- [ ] Both games open and play identically to pre-change (Tasks 2 & 3 checks).
- [ ] `git log --oneline` shows four commits (module+tests, space-jumper, invaders, README).
- [ ] No CHANGELOG edit (arcade out of scope).
- [ ] Ready to push and open a PR for review.

# Arcade engine primitives — `Arcade.Engine` (slice 1)

**Date:** 2026-05-26
**Status:** design — approved direction, pending written-spec review
**Scope:** item #3 of the 2026-05-25 arcade-framework audit

## Motivation

`docs/arcade/shared/` currently centralises the **cabinet chrome** — `Arcade.Audio`,
`Music`, `Splash`, `Pause`, `Touch`, `Initials`, `Leaderboard`, `EndOverlay`. It has
**zero engine layer**: every game re-implements canvas setup, box-overlap tests, a
stable per-tile PRNG, and pixel-drawing helpers inline.

This slice introduces a second, clearly-named layer for the building blocks of a
game's own simulation and rendering, without touching the riskier shared concerns
(game loop, collision resolution) that the games have **not** yet proven to need in
the same shape.

```
Arcade.Audio / Music / Splash / Pause / Touch / Initials / Leaderboard / EndOverlay   ← cabinet chrome
Arcade.Engine.{ canvas, rectsOverlap, rand, draw }                                    ← game primitives (NEW)
```

This directly serves the framework ambition (`shared/` as a target an agent can build
a new game against): naming the chrome-vs-engine boundary gives a future reader — human
or agent — two clean buckets instead of one flat bag of ~30 helpers.

## Principles guiding the slice

1. **Restraint over reuse.** Extract only pure, generic helpers with a real adopter
   today. A primitive nobody uses is dead weight.
2. **No hidden coupling smuggled into shared code.** Space Jumper's `resolveX`/`resolveY`
   mutate the `player` object and refuel the jetpack on landing; Invaders' `paintPixels`
   is welded to its playfield→canvas letterbox transform. Extracting either would drag
   game-world-mapping policy into the engine layer. Both are deferred.
3. **Parity first.** Adopting a helper must be rendering-equivalent — no gameplay or
   visual change in this slice. Verified by unit tests + a browser spot-check of both
   games.
4. **Separation of concerns in the API.** Backing-store sizing (DPR/crispness/perf),
   viewport/layout (size, safe area, aspect), and world mapping (playfield, camera, tile
   size) are three different jobs. The engine owns only the first; the game keeps the
   other two.
5. **Names must be unambiguous to a future agent.** Prefer a name that says exactly what
   the function touches over a short name that implies more than it does.

## Module

- New file: `docs/arcade/shared/engine.js` (plain IIFE, no build step).
- Exposes a single namespace `window.Arcade.Engine` — preserving the shared/ "one file →
  one `Arcade.*` namespace" convention; the sub-objects are structure within it.
- Load order: a `<script src="../shared/engine.js"></script>` alongside the other shared
  modules at body-top (no inter-module dependencies; it only defines functions).
- `docs/arcade/shared/README.md` gains: an `engine.js` row in the module table, and a
  short note framing the two layers (chrome vs engine).

## API surface (slice 1)

### `Arcade.Engine.canvas`

```js
const surface = Arcade.Engine.canvas.configure(canvas, { maxDpr = 1 } = {});
// → { ctx, cssWidth, cssHeight, dpr, pixelWidth, pixelHeight }
```

**Name:** `configure` — chosen to avoid the "make it fit the screen" layout implication
of `fit`, and to signal it owns the canvas's backing-store + transform setup as a bundle.
*(Open alternative: `resizeBackingStore` if a maximally-literal name is preferred. One
veto point left for the reviewer.)*

**Behaviour:**
- Reads the CSS box via `canvas.getBoundingClientRect()` → `cssWidth`, `cssHeight`.
- `maxDpr = Math.max(1, Number(maxDpr) || 1)` — guards `0` / `null` / `NaN` / negative
  so a bad value can't produce a zero-size or broken canvas.
- `dpr = min(window.devicePixelRatio || 1, maxDpr)`.
- `pixelWidth = round(cssWidth * dpr)`, `pixelHeight = round(cssHeight * dpr)`.
- Sets `canvas.width = pixelWidth`, `canvas.height = pixelHeight`.
- Grabs `ctx = canvas.getContext('2d')` and **always** normalises the transform:
  `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` (identity when `dpr === 1`), so game code keeps
  drawing in CSS-pixel coordinates regardless of DPR.
- Returns the facts object (incl. `ctx`).

**Does NOT:** letterbox, derive tile sizes, set up a camera, or otherwise map the game
world. The game does that from the returned facts, e.g.:
```js
const surface = Arcade.Engine.canvas.configure(canvas);
letterboxFixedPlayfield(surface, 260, 280);   // Invaders
deriveTileSize(surface);                       // Space Jumper
```

**Footgun (must be documented in the header + README, and tested):** `configure` resets
the 2D transform on every call. Call it on resize, **not** per-frame (setting
`canvas.width` clears the canvas and costs a reallocation), and don't expect a
game-applied persistent transform to survive it — re-apply after `configure` if needed.

**Parity:** default `maxDpr: 1` ⇒ `dpr = 1` ⇒ backing store in CSS pixels + identity
transform ⇒ rendering-equivalent to today's `resize()`. DPR crispness is strictly
opt-in (`{ maxDpr: 2 }`) because both games repaint the full screen every frame, so a
higher backing store is ~`dpr²`× the fill cost — a real hit on phones/tablets. Opting
in later should be a one-flag change for games that draw in CSS-pixel coordinates; games
with custom transforms, cached gradients/image buffers, or pixel-perfect assumptions may
still need local work. The cost can be measured per game.

### `Arcade.Engine.rectsOverlap`

```js
Arcade.Engine.rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh);  // → boolean
// AABB test; strict overlap — touching edges return false
```

Named `rectsOverlap` (not `aabb`) so it reads for a reader who isn't game-engine fluent;
the comment keeps the AABB term discoverable.

The pure axis-aligned box-overlap test (Space Jumper's `aabbOverlap`, verbatim
semantics: `ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by`). Documented as
**strict overlap** — edges that merely touch do not count — because a future caller will
eventually assume the opposite.

### `Arcade.Engine.rand`

```js
Arcade.Engine.rand.tileHash(i);  // → number in [0, 1)
```

Space Jumper's stable per-index PRNG, verbatim algorithm:
`x = ((i|0)+100000)>>>0; x = (x*9301+49297) % 233280; return x/233280;`
Deterministic for a given `i` — used to keep per-tile art stable across frames.

### `Arcade.Engine.draw`

```js
Arcade.Engine.draw.circle(ctx, cx, cy, r);  // filled disc via integer scanlines
```

The scanline disc fill (`for y in -r..r: w = round(√(r²−y²)); ctx.fillRect(round(cx−w),
round(cy+y), w*2, 1)`). Takes an explicit `ctx`, so it unifies Space Jumper's `fillCircle`
(main ctx) **and** `fillCircleOn` (offscreen ctx) into one helper. Caller sets
`ctx.fillStyle` before calling.

**Deferred — not in this slice:** `draw.pixels` (the 'X' string-art sprite painter).
Invaders' `paintPixels` routes through its `drawRect`/`pfToCanvas` letterbox transform, so
a generic version has no clean adopter today; extracting it now would smuggle
world-mapping policy into `Engine.draw`. Added when a second game needs it.

## Adoption plan (same PR)

A helper nobody calls is dead weight, so both single-player games adopt in the same
change. Each swap is mechanical and individually parity-checkable.

| Helper | `invaders/index.html` | `space-jumper/index.html` |
|---|---|---|
| `canvas.configure` | `resize()` backing-store lines (keeps building `bgGradient` locally) | `resize()` backing-store lines |
| `rectsOverlap` | *(deferred this slice — see note below)* | `aabbOverlap` definition + call sites |
| `rand.tileHash` | — | `tileHash` definition + call sites |
| `draw.circle` | — | `fillCircle` + `fillCircleOn` definitions + call sites |

`invaders-mp` is **out of scope** (separate engine/netcode path; not a single-player
canvas game in the same shape).

**Invaders `rectsOverlap` deferred (scoping decision):** converting Invaders' 5 bespoke
inline collision conditionals to `rectsOverlap` is a higher-risk hand-rewrite of live
gameplay logic, and `rectsOverlap` is already proven by Space Jumper's adoption. Invaders
adopts `canvas.configure` only this slice; the collision conversion is a fast-follow.

Note on `canvas.configure` adoption: today both games do `W = canvas.width = rect.width`.
After adoption, geometry uses `surface.cssWidth`/`surface.cssHeight`; with the default
`maxDpr: 1` these equal the pixel dimensions, so the change is rendering-equivalent.

## Tests — `docs/arcade/shared/engine.test.cjs`

Node-based, modelled on the existing `music.test.cjs` / `splash.test.cjs` (mock
`canvas`/`ctx`/`devicePixelRatio`; no real DOM).

- **`canvas.configure`:**
  - `maxDpr` omitted ⇒ `dpr === 1`.
  - `devicePixelRatio = 3`, `{ maxDpr: 2 }` ⇒ `dpr === 2`.
  - `canvas.width === round(cssWidth * dpr)`, `canvas.height === round(cssHeight * dpr)`.
  - `ctx.setTransform` called with `(dpr, 0, 0, dpr, 0, 0)` after the call (transform
    reset / normalised).
  - invalid `maxDpr` (`0`, `null`, `NaN`, `-2`) ⇒ clamped, `dpr === 1`.
  - return object exposes `ctx` + all five facts.
- **`rectsOverlap`:** overlapping boxes ⇒ `true`; disjoint ⇒ `false`; **edge-touching ⇒ `false`**
  (named test, pins the strict-overlap contract).
- **`rand.tileHash`:** deterministic for a fixed `i`; result in `[0, 1)`; a known
  fixed value for a known `i`.
- **`draw.circle`:** against a mock `ctx`, the emitted `fillRect` scanline spans match
  `w = round(√(r²−y²))` for a small `r`.

## Parity verification (beyond unit tests)

Serve the worktree and spot-check both games in the browser (same method as the #1
leaderboard PR): title/leaderboard render + a short play loop. With `maxDpr: 1` the
canvas backing store and transform are unchanged, so this confirms the refactor is
rendering-equivalent rather than relying on inspection alone.

## Out of scope (explicit boundary)

Layered onto `Arcade.Engine` later, none requiring a reshape of this slice:

- **Game loop** — the two games use genuinely different models (Invaders: `dt`-based,
  pause-checked inside, always repaints bg; Space Jumper: fixed-step, gated on
  `Splash.isPlaying()`). Unifying changes one game's feel.
- **Tilemap collision resolver** (`resolveX`/`resolveY`) — coupled to the player object
  and jetpack refuel; a real refactor, not a lift.
- **`draw.pixels`** — coupled to Invaders' letterbox transform (see above).
- **DPR-by-default** and a **fixed-internal-resolution** render mode — both possible
  future `canvas` options.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Adoption silently changes rendering | `maxDpr: 1` default = rendering-equivalent; unit tests + browser parity check both games |
| `setTransform` reset surprises a later contributor | Documented in header + README; asserted in tests |
| "Engine" overpromises while the surface is small | Acceptable — it's the deliberate home for the loop/collision work to come; draw/rand/rectsOverlap/canvas already cohere as primitives |
| Over-fragmentation | Single `engine.js`, single namespace — one script tag, one row in the README |

## Acceptance criteria

- `shared/engine.js` defines `Arcade.Engine` with `canvas.configure`, `rectsOverlap`,
  `rand.tileHash`, `draw.circle` exactly as specified.
- Both single-player games adopt all applicable helpers; their inline copies are removed.
- `shared/engine.test.cjs` passes, covering the cases above.
- Browser spot-check: both games render and play identically to pre-change.
- `shared/README.md` documents `engine.js` (module row + two-layer note + the
  `configure` transform footgun).
- No CHANGELOG entry (arcade is out of consumer-changelog scope).

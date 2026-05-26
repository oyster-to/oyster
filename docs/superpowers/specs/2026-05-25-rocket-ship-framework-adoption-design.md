# Rocket Ship — full framework adoption (SP-0)

**Date:** 2026-05-25
**Status:** Design / pre-plan
**Branch:** `rocket-ship-adopt`
**Roadmap context:** [`docs/plans/arcade-framework-roadmap.md`](../../plans/arcade-framework-roadmap.md) — this is sub-project **SP-0**.

## Why

Rocket Ship is the arcade's "middle child." It adopted three shared JS modules
(`splash.js`, `initials.js`, `leaderboard.js`) but skipped the rest: it drives
its game-over overlay with bespoke inline JS, has no pause/volume overlay, and
loads **zero** shared CSS — instead inlining ~700 lines that duplicate
`cabinet.css`, `pixel-font.css`, `touch.css`, `overlays.css`, and `splash.css`.

The goal is not cleanup for its own sake. The arcade framework's north star is
"someone asks for a new game and the building blocks are already in place"
(see roadmap). Rocket Ship is the oldest game and the proof that the **cabinet
chrome layer is complete enough for any game to adopt**. If the framework's
first customer can't fully use it, the framework isn't done. Adopting it here
both removes drift and validates the chrome APIs against a third, differently
shaped game.

## Scope

Four independently shippable steps, in risk order. **In place** — the file
stays at `docs/rocket-ship.html`; relocation into `docs/arcade/rocket-ship/`
is explicitly **out of scope** (see "Decisions" below).

| Step | What | Risk |
|---|---|---|
| **A** | Adopt `Arcade.EndOverlay` for game-over | Medium (behavioural) |
| **B** | Adopt `Arcade.Pause` (pause + volume overlay) | Low |
| **C** | Load the 6 shared stylesheets, delete inline duplicates | High (visual) |
| **D** | Adopt `Arcade.Music` for BGM | Low |

`Arcade.Music` shipped in **FW-0 (#594)** after this spec was first written, so
the BGM migration that was originally deferred is now in scope as Step D — making
this a *complete* adoption rather than "complete except BGM."

**Out of scope:**
- **File relocation + redirect stub.** Decoupled — see Decisions.
- Any gameplay change. Physics, scoring, entities, the SVG title rocket, the
  celebration sequence, and the SYSTEM BOOT animation are untouched.

## Current state (what we're replacing)

All line numbers are `docs/rocket-ship.html` at branch point `ff1e670`.

- **Includes (734–739):** `audio.js`, `touch.js`, `leaderboard.js`, `splash.js`,
  `initials.js`, `iframe-host.js`. No CSS includes; no `end-overlay.js`; no
  `pause.js`.
- **Inline `<style>` (19–718):** the full sheet — cabinet bezel/tube/CRT, Press
  Start 2P `@font-face` + tap-callout/selection suppression, on-screen button
  cluster, `.gameover`/`.go-*` overlay, `.splash` shell, plus genuinely
  game-specific rules (SYSTEM BOOT, `.celebrate` flag, `.title-rocket` SVG,
  parallax stars).
- **Game-over driver (1707–1801):** bespoke. `showGameOverWith(score)` →
  `paintGameOverOverlay(beat)` toggles `#gameover.is-visible`, writes the
  hi-score line, calls `Initials.open()` or shows the prompt. Two dismiss
  listeners (a `click` on the overlay and a global `keydown`) hide the overlay
  and call `Arcade.Splash.enterAttract()`. No explicit grace window — it leans
  on a `setTimeout` fade-in before `__rocketShowGameOver` fires.
- **ESC handling (1701–1704):** bespoke `keydown` → `postMessage('oyster-rocket-close')`.
- **Game loop gate (1189):** `if (!Arcade.Splash.isPlaying() || gameOver)`.

The `#gameover` DOM (822–836) already matches `EndOverlay`'s default selector
contract exactly (`#gameover`, `#go-title`, `#go-score-val`, `#go-hiscore`,
`#go-prompt`, `#go-initials` with `.go-slot[data-slot]`). So Step A is
behavioural, not structural.

## Step A — `Arcade.EndOverlay`

Replace the bespoke driver (1707–1801) with the shared module while preserving
Rocket Ship's distinctive **celebration-before-initials for a new #1**.

**Mount once:** `Arcade.EndOverlay.mount()` (defaults match the DOM). Rocket
Ship's hi-score line is custom in both branches, so each `show()` passes an
explicit `hiscoreText` rather than relying on the default formatter.

**The three game-over paths:**

1. **No qualify** — `show({ score, qualifies: false, hiscoreText: 'HIGH SCORE NNN III' })`.
   Prompt shown. Any post-grace input → `hide()` + `Splash.enterAttract()`.
2. **Qualifies, not a new #1** — `show({ score, qualifies: true, hiscoreText: 'RANK ON THE LEADERBOARD — TOP N' })`
   then `Initials.open()` **immediately** (preserves today's behaviour — Rocket
   Ship opens initials directly, with no intermediate "press a key to enter
   initials" step).
3. **New #1** — run the existing celebration overlay first (game-specific,
   unchanged); on its dismissal, `show(...)` + `Initials.open()`.

**Dismiss listeners collapse** to the standard gate:
```
if (!Arcade.EndOverlay.acceptsInput()) return;   // grace window
if (Arcade.Initials.isActive()) return;          // initials owns input
Arcade.EndOverlay.hide();
Arcade.Splash.enterAttract();
```
Keep both the overlay `click` handler and the global `keydown` handler (iOS
inside-iframe reliability — the existing comment explains why both exist).

`Initials.onSubmit` stays: `addToLeaderboard(pendingScore, initials)` → `hide()`
→ `enterAttract()`. Consider `EndOverlay.extendGrace(...)` after submit so the
confirming keypress doesn't instantly restart (matches the other games).

**Behavioural delta (intended):** Rocket Ship *gains* an explicit `graceMs`
instead of relying on the fade-in timing — a held key at the moment of death no
longer risks blowing past the overlay.

**Shared-module risk:** adopting `EndOverlay` in a third game with a
celebration-first flow is a test of API completeness. The expectation is **no
change to `end-overlay.js`** — the immediate-`Initials.open()` paths and
`acceptsInput()` cover it, and `setPendingInitials`/`consumePending` aren't
required here because initials open immediately rather than on a follow-up key.
If a gap surfaces, the fix is a small additive change to the shared module,
recorded in the plan.

## Step B — `Arcade.Pause`

Bring Rocket Ship to parity with Invaders and Space Jumper.

- Add `<script src="arcade/shared/pause.js"></script>`.
- Gate the loop: `if (!Arcade.Splash.isPlaying() || gameOver || Arcade.Pause.isPaused()) ...`.
- Set the gate so you can't pause the title/attract or a finished game:
  `Arcade.Pause.canPause = () => Arcade.Splash.isPlaying() && !gameOver;`
  (mirrors Invaders' `canPause = () => running`).
- **BGM already conforms:** Rocket Ship's `bgm` and `bgm-game` both match
  pause.js's `audio[id^="bgm"]` selector, so the MUSIC slider works with no
  extra wiring.
- **Remove** the bespoke ESC→`postMessage('oyster-rocket-close')` handler
  (1701–1704). `iframe-host.js` no-ops ESC whenever `Arcade.Pause` is present,
  so pause takes ESC, exactly like the other games.

**ESC-to-close is preserved by the hosts, not the game:**
- Arcade cabinet (`docs/arcade/index.html:1357–1367`): its own `×` button +
  a `message` listener for `arcade-close`/`oyster-rocket-close` → `close()`.
- Easter-egg host (`docs/index.html:2185`): its own parent-level ESC handler
  closes the launched mock independently of any postMessage.

**Reconcile the existing mute toggle.** Rocket Ship has an inline mute button
(`applyMusic` ~1541 + `Arcade.Audio.setMuted` ~1545). It now overlaps the pause
overlay's volume sliders. First confirm which channel(s) it actually toggles
(music, SFX, or both), then route it through the matching `Arcade.Pause`
setter(s) so the button and the sliders stay in sync. Keep this minimal — no new
UI.

**Verify no key conflict:** confirm Rocket Ship doesn't already bind `p`/`P`
in-game before pause.js claims it. (Expected clear — it's an arrows/thrust
dodger.)

## Step C — Shared CSS swap (the careful one)

Load the six shared stylesheets, delete the inline rules they now cover, and
keep a small, clearly-marked **rocket-ship-specific** block.

**Load order** (in `<head>`, matching the other games):
`pixel-font.css` → `cabinet.css` → `touch.css` → `overlays.css` → `splash.css` →
`leaderboard.css`. (`leaderboard.css` was extracted to shared in #598 after this
spec was first drafted — hence "six", not five.)

**Keep inline (game-specific):**
- SYSTEM BOOT intro animation
- `.celebrate` flag (pole, cloth, "1ST")
- `.title-rocket` SVG animation
- parallax stars + game canvas styling
- any genuine colour/layout override needed for parity (see below)

**Known divergences to expect a thin override block for:**
- Game-over title is `.title.go-title` (an extra `.title` class) vs the shared
  `.go-title`.
- Splash markup nests `.splash-main .splash-view` (the `Splash.mount` config
  already targets `#splash .splash-main .splash-view`).
- Rocket Ship's hi-score line uses 3-digit zero-pad (`padStart(3)`); the shared
  overlay defaults to 4. This is handled in JS (`hiscoreText`), not CSS, but
  flag it so the score column width still looks right.

**Risk mitigation = the pass condition for this step.** Before/after screenshots
of every screen — boot, title, leaderboard view, in-game, game-over (each of the
3 paths), initials entry, celebration — on desktop **and** a touch device, via
the LAN dev server (`/tmp/arcade-dev-server.mjs` pattern, see
`reference_arcade_deploy_and_lan_test`). Visual parity is the bar. **If a screen
cannot reach parity without fighting the shared sheet, that rule stays inline and
is documented** — we do not contort shared CSS for one game.

## Step D — `Arcade.Music`

Replace Rocket Ship's bespoke two-track BGM control with the shared module
(`docs/arcade/shared/music.js`, shipped in FW-0). Rocket Ship has `bgm` (title
music) and `bgm-game` (game music), driven today by `startTitleMusic` /
`startGameMusic` + an `awaiting` autoplay-retry flag, plus some out-of-IIFE
`bgm-game` pause/play in the restart / game-over paths.

- **Splash hooks** (the `Arcade.Splash.mount` config):
  `onTitle` → `Arcade.Music.play('bgm', { gain })`; `onPlay` →
  `Arcade.Music.play('bgm-game', { gain })` (which pauses+resets the title track);
  `unlockAudio` → `Arcade.Music.retryPending()` (replaces the `awaiting`-flag
  retry).
- **Out-of-IIFE `bgm-game` touches** (the restart / game-over paths): route
  through `Arcade.Music.play('bgm-game', …)` / `Arcade.Music.stop()` rather than
  manipulating the element directly.
- **Preserve the tuned volumes** by passing each track's current value as
  `{ gain }` (game music is `0.4` today; the writing-plans step reads the exact
  values — including the title track's — from the file and reproduces them).
- Add `<script src="arcade/shared/music.js"></script>` with the other shared
  includes (before the inline game script).

**Interaction with Step B:** once `pause.js` is adopted, the MUSIC slider owns
volume via the `audio[id^="bgm"]` selector exactly as in Invaders/Space Jumper;
`Arcade.Music`'s `{ gain }` is the per-track base, and the pre-existing
slider-vs-gain interaction is unchanged (same as the other games — not a new
concern introduced here). `bgm` and `bgm-game` both match the `bgm` prefix, and
neither is a one-shot, so authored-loop handling needs no special care.

**Behaviour-preserving** — a wiring swap, not a re-tune. Verify the title ↔ game
music transitions and the iOS first-tap unlock are unchanged.

## Decisions

- **In place, no relocation.** Moving to `docs/arcade/rocket-ship/` buys only
  folder tidiness (it already loads `arcade/shared/...` fine) while carrying the
  most blast radius: the public shipped URL `oyster.to/rocket-ship.html` (which
  the arcade tile treats as canonical) would 404, requiring a permanent
  meta-refresh stub, plus edits to both inbound refs and the oyster.to-vs-
  arcade.oyster.to domain wrinkle. Decoupled into an optional later step so a CSS
  regression never tangles with a URL change. If done later: keep a permanent
  stub at `docs/rocket-ship.html` (`<meta http-equiv="refresh">` +
  `<link rel="canonical">` + `location.replace()` fallback) and update
  `docs/index.html:1425` and `docs/arcade/index.html:889`.
- **BGM adopts `Arcade.Music`** (Step D) — FW-0 shipped it (#594), so rocket-ship
  is migrated here, completing the adoption. (FW-0 deliberately migrated only
  invaders + space-jumper and routed rocket-ship's BGM to this PR, to avoid two
  branches editing `rocket-ship.html`.)
- **Four steps**, A → B → C → D, each independently shippable and reviewable.

## Testing

- **A:** exercise all three game-over paths (no-qualify, qualify-not-#1,
  new-#1-with-celebration). Confirm: overlay shows, grace window holds, initials
  entry works (the original son-found bug class — letter stepping + last-letter
  save), submit writes the score and returns to attract, dismiss returns to
  attract. The existing headless suites (`touch.test.cjs`, `splash.test.cjs`)
  must still pass.
- **B:** P and ESC toggle pause; volume sliders move music + SFX; `canPause`
  blocks pause on title/attract/game-over; close works from **both** hosts
  (arcade `×` + message, easter-egg parent ESC); no `p`/`P` key conflict.
- **C:** screenshot parity matrix above. No console errors from missing/duplicate
  rules.
- **D:** title screen plays the title music; pressing start swaps to game music;
  the restart / game-over paths leave music in the right state; iOS first-tap
  starts music (autoplay unlock via `retryPending`); the MUSIC slider still
  controls volume. No change to `music.js` expected — the shared suites stay green.

## Out of scope (explicit)

- File relocation + redirect stub.
- The MP substrate / session-layer work (roadmap `FW-1`+).
- Any change to Invaders, Space Jumper, or invaders-mp (incl. their BGM — FW-0
  already migrated them; this PR touches only `rocket-ship.html`).

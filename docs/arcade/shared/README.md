# Arcade shared framework — DOM contract & wiring guide

Everything in `docs/arcade/shared/` is the common cabinet for the arcade games
(`invaders/`, `space-jumper/`, …). The JS modules attach to a single global
`window.Arcade.*` namespace; the CSS sheets style a fixed set of class/id names.

The framework has **two layers**. The modules below are *cabinet chrome* —
`Audio`, `Music`, `Splash`, `Pause`, `Touch`, `Initials`, `Leaderboard`,
`EndOverlay`. `engine.js` adds the *game-primitive* layer under `Arcade.Engine`
(canvas backing-store, rect overlap, stable PRNG, pixel draw) — the building
blocks of a game's own simulation and rendering, not the surrounding cabinet.

**The one gotcha:** every module is **selector-driven with silent defaults**.
If your markup doesn't use the exact ids/classes a module expects, the module
no-ops quietly — no error, just a dead button or an unstyled panel. This file
is the source of truth for those selectors so a new game (or an agent building
one) can be scaffolded correctly the first time.

Each module is a plain IIFE — no build step, no imports. Drop the `<script>`
tags in and the `window.Arcade.*` objects appear.

---

## Load order

Order matters: stylesheets reference each other's `@keyframes`, and a few JS
modules read another's API at call time. Use this order.

**In `<head>` — stylesheets:**

```html
<link rel="stylesheet" href="../shared/pixel-font.css">  <!-- 1st: @font-face + body reset -->
<link rel="stylesheet" href="../shared/cabinet.css">     <!-- defines the @keyframes the others use -->
<link rel="stylesheet" href="../shared/touch.css">
<link rel="stylesheet" href="../shared/overlays.css">    <!-- game-over overlay -->
<link rel="stylesheet" href="../shared/splash.css">      <!-- title/attract screen -->
<link rel="stylesheet" href="../shared/leaderboard.css"> <!-- splash leaderboard view -->
```

**At the top of `<body>` — scripts (load only what you use, in this order):**

```html
<script src="../shared/audio.js"></script>       <!-- before pause.js (pause reads Arcade.Audio) -->
<script src="../shared/music.js"></script>
<script src="../shared/pause.js"></script>
<script src="../shared/touch.js"></script>
<script src="../shared/iframe-host.js"></script> <!-- after pause.js (checks Arcade.Pause for ESC) -->
<script src="../shared/leaderboard.js"></script>
<script src="../shared/initials.js"></script>
<script src="../shared/end-overlay.js"></script>
<script src="../shared/splash.js"></script>
<script src="../shared/engine.js"></script>     <!-- game primitives; pure, no deps, order-independent -->
```

Skip any module you don't need — but mind the noted dependencies (`pause`
wants `audio` loaded first; `iframe-host` checks for `pause`).

**Your game's own script goes at the *end* of `<body>`, after the markup** — not
up here with the shared modules. The shared modules just define `window.Arcade.*`
and do no DOM lookups at load, but your init code calls `Arcade.Splash.mount()` /
`paintList()` / etc., which need `#splash`, `#lb-list`, `#gameover` … to already
exist. Run it at body-top and it silently no-ops on the missing elements. (Or
give your script `defer`, or wrap init in `DOMContentLoaded`.)

---

## Module reference

| Module | `window.Arcade.*` | Required DOM / selectors | Notes |
|---|---|---|---|
| `audio.js` | `Audio` | `<audio id="…">` for each SFX key passed to `init({sfx})` | Web Audio SFX. The `<audio>` element is only the pre-decode fallback; ids **must** match the `sfx` keys. Call `ensureCtx()` on the first user gesture (iOS unlock). |
| `music.js` | `Music` | `<audio id="bgm…">` — **any id starting with `bgm`** | BGM. One track at a time; `play('bgm-x', {gain})` pauses the rest. New tracks **must** be named `bgm` / `bgm-*` or neither `Music` nor the pause slider will manage them. |
| `pause.js` | `Pause` | none — injects its own overlay + styles | P / ESC toggles a pause card with MUSIC + SFX volume sliders. Reads `audio[id^="bgm"]`. Gate your loop with `if (Arcade.Pause.isPaused()) return;`. Optional `Arcade.Pause.canPause = () => …`. |
| `touch.js` | `Touch` | you pass element refs; convention: `.touch-controls` with `.tc-btn` buttons | `bind(btn,onDown,onUp)` for a hold button; `movePad(left,right,…)` for a ◀▶ analog d-pad. Also installs a coarse-pointer `contextmenu` guard. Touch controls only show once `.tube.is-ready`. |
| `iframe-host.js` | *(self-installs)* | none | Adds `.is-embedded` to `<body>` when iframed; ESC posts a close message to the parent — unless `Arcade.Pause` is loaded, which then owns ESC. No API. |
| `leaderboard.js` | `Leaderboard` | `paintList({listSelector})` → an `<ol>` (conventionally `#lb-list`); `paintHiScoreRow({valueSelector, initialsSelector, rowSelector})` | Cloud (`/api/leaderboard`) + localStorage mirror. `init({game, max})` — `game` must be in the worker allowlist (`infra/leaderboard-worker/src/worker.ts`). Mirror key: `oyster-arcade-leaderboard-<game>`. |
| `initials.js` | `Initials` | `#go-initials` container, `#go-initials .go-slot` cells each with `data-slot="N"`, `#go-prompt` | High-score initials state machine (keyboard + touch). `mount({onSubmit, fireButton})`, `open()`. Gate your restart listeners on `if (Arcade.Initials.isActive()) return;`. |
| `end-overlay.js` | `EndOverlay` | `#gameover` root + `#go-title`, `#go-score-val`, `#go-hiscore`, `#go-prompt` (toggles `.is-visible`) | Game-over/complete overlay + the grace-window + "next keypress restarts" gate. `show({score, title, titleClass, hiscore, graceMs, qualifies})`, `acceptsInput()`, `consumePending()`. `mount()` is optional (defaults match the ids above). |
| `splash.js` | `Splash` | `#splash`, `#splash .splash-view` (index 0 = title, 1 = leaderboard), `.tube` | Full attract-mode lifecycle: booting → title → playing → attract. `mount({onTitle, onPlay, onLeaderboardShow, unlockAudio, isBusy})`, `enterAttract()`. Gate your loop with `if (!Arcade.Splash.isPlaying()) return;`. Toggles `.tube.is-ready` and `body.is-ingame`. |
| `engine.js` | `Engine` | none — pure helpers, no DOM lookups at load | Game primitives (the layer below the chrome above): `canvas.configure(canvas,{maxDpr})` (backing store + capped DPR transform, returns `{ctx,cssWidth,cssHeight,dpr,pixelWidth,pixelHeight}`); `rectsOverlap(...)` (strict AABB); `rand.tileHash(i)`; `draw.circle(ctx,cx,cy,r)`. **`canvas.configure` resets the 2D transform on every call — call it on resize, not per-frame.** |

### Stylesheet class contracts

- **`pixel-font.css`** — `@font-face` for *Press Start 2P* (self-hosted from `../../assets/PressStart2P-Regular.ttf`; the Google subset drops the ★ ♪ ← → glyphs) + a full-screen body reset that locks scroll/zoom/selection. Load first.
- **`cabinet.css`** — the bezel/tube/CRT shell: `.screen` › `.tube` › (`canvas`, `.overlay`, `.vignette`). `.tube.is-ready` reveals the canvas + touch controls; `.tube.is-shaking` plays a crash shake. Owns the shared `@keyframes`: `splash-poweron`, `crt-shutoff`, `crt-shake`, `arcade-blink`. References `../../assets/crt.png`.
- **`overlays.css`** — `.gameover` (`.is-visible`) and `.go-*` children (`.go-title` with `.is-win`/`.is-loss`, `.go-score`, `.go-hiscore`, `.go-prompt`, `.go-initials`, `.go-initials-label`, `.go-initials-slots`, `.go-slot` w/ `.is-active`, `.go-initials-hint`). Retint via `--go-*` CSS vars — don't restate geometry.
- **`splash.css`** — `.splash` (`.is-hidden`), `.splash-main`, `.start`, `.controls` (`.key`/`.desc`), `.credit`, `.hiscore-row` (`.hs-val`/`.hs-initials`), and `.splash-view` (`.is-active`). Background via `--splash-bg`. **Per-game (not here):** `.splash .title` marquee.
- **`touch.css`** — `.touch-controls` › `.tc-group` › `.tc-btn` (`.is-pressed`). Plus the `.key-only` / `.touch-only` utility pair that swaps keyboard vs touch hint copy on coarse pointers.
- **`leaderboard.css`** — `.leaderboard` › `.lb-title` / `.lb-list` (`li`) / `.lb-rank` / `.lb-initials` / `.lb-score` / `.lb-empty`. Tune just the heading via `--lb-title-size` (set it on `.leaderboard`; it inherits to `.lb-title`).

---

## Minimal game skeleton

Real, working markup trimmed to the essentials (from `invaders/`). Replace the
SFX/BGM lists, the title art, and the control hints with your own.

```html
<!-- <head>: the six <link>s from "Load order" above -->
<body>
  <!-- the nine shared <script>s from "Load order" go here at body-top;
       your game's OWN script goes at the end of <body> (see bottom) -->


  <!-- SFX: id MUST match the key in Arcade.Audio.init({sfx}) -->
  <audio id="sfx-shoot" src="sfx-shoot.mp3" preload="auto"></audio>
  <!-- BGM: id MUST start with "bgm" -->
  <audio id="bgm"       src="bgm.mp3"       preload="auto" loop></audio>
  <audio id="bgm-title" src="bgm-title.mp3" preload="auto" loop></audio>

  <div class="screen">
    <div class="tube">
      <canvas id="c"></canvas>
      <div class="overlay"></div>
      <div class="vignette"></div>

      <!-- Touch controls (auto-shown on coarse pointers once .tube.is-ready) -->
      <div class="touch-controls">
        <div class="tc-group">
          <button type="button" class="tc-btn" id="tc-left"  aria-label="Move left"  tabindex="-1">◀</button>
          <button type="button" class="tc-btn" id="tc-right" aria-label="Move right" tabindex="-1">▶</button>
        </div>
        <div class="tc-group">
          <button type="button" class="tc-btn" id="tc-fire" aria-label="Fire" tabindex="-1">FIRE</button>
        </div>
      </div>

      <!-- Game-over overlay (EndOverlay + Initials) -->
      <div class="gameover" id="gameover" aria-hidden="true">
        <div class="go-title" id="go-title">GAME OVER</div>
        <div class="go-score">SCORE <span id="go-score-val">0</span></div>
        <div class="go-hiscore" id="go-hiscore"></div>
        <div class="go-prompt" id="go-prompt">
          <span class="key-only">PRESS ANY KEY TO CONTINUE</span>
          <span class="touch-only">TAP TO CONTINUE</span>
        </div>
        <div class="go-initials" id="go-initials" hidden>
          <div class="go-initials-label">NEW HIGH SCORE — ENTER INITIALS</div>
          <div class="go-initials-slots">
            <span class="go-slot is-active" data-slot="0">A</span>
            <span class="go-slot"           data-slot="1">A</span>
            <span class="go-slot"           data-slot="2">A</span>
          </div>
          <div class="go-initials-hint">
            <span class="key-only">↑↓ LETTER · ←→ SLOT · ENTER SAVE</span>
            <span class="touch-only">TAP SLOT · SWIPE LETTER · SELECT SAVES</span>
          </div>
        </div>
      </div>

      <!-- Splash: title card ↔ leaderboard, auto-cycled by Arcade.Splash -->
      <div class="splash" id="splash">
        <div class="splash-main">
          <div class="title-card splash-view is-active">
            <div class="title">YOUR GAME</div>
            <div class="start"><span class="key-only">INSERT COIN TO PLAY</span><span class="touch-only">TAP TO PLAY</span></div>
            <div class="hiscore-row" id="hiscore-row">HIGH SCORE
              <span class="hs-val" id="hs-val-splash">0000</span>
              <span class="hs-initials" id="hs-initials-splash">---</span>
            </div>
          </div>
          <div class="leaderboard splash-view">
            <div class="lb-title">HIGH SCORES</div>
            <ol class="lb-list" id="lb-list"></ol>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Your game's own script goes HERE — after the markup — so its
       Arcade.*.mount() / paintList() calls can find the elements above. -->
  <script src="your-game.js"></script>
</body>
```

### Wiring (in your game's `<script>`, placed at the end of `<body>` after the markup)

```js
Arcade.Audio.init({ sfx: { 'sfx-shoot': 'sfx-shoot.mp3' }, volumeKey: 'oyster-arcade-sfx-volume' });
Arcade.Leaderboard.init({ game: 'your-game', max: 10 });   // 'your-game' must be in the worker allowlist
Arcade.Leaderboard.refresh();

Arcade.Initials.mount({
  fireButton: '#tc-fire',
  onSubmit: (initials) => {
    Arcade.Leaderboard.submit(score, initials);
    Arcade.EndOverlay.extendGrace(800);     // beat before the next key restarts
  },
});

Arcade.Splash.mount({
  onTitle:           () => Arcade.Music.play('bgm-title', { gain: 0.4 }),
  onPlay:            () => { Arcade.Music.play('bgm', { gain: 0.35 }); startRun(); },
  onLeaderboardShow: () => Arcade.Leaderboard.paintList({ listSelector: '#lb-list' }),
  unlockAudio:       () => { Arcade.Audio.ensureCtx(); Arcade.Music.retryPending(); },  // first-gesture iOS unlock
  isBusy:            () => Arcade.Initials.isActive(),
});

// On game over:
function endRun() {
  Arcade.EndOverlay.show({
    score,
    title:     win ? 'GAME COMPLETE' : 'GAME OVER',
    titleClass: win ? 'is-win' : '',
    hiscore:   Arcade.Leaderboard.getHighScore(),
    qualifies: Arcade.Leaderboard.qualifies(score),
    graceMs:   1200,
  });
}

// Restart listener (keyboard/tap):
function onRestartKey() {
  if (Arcade.Initials.isActive()) return;
  if (!Arcade.EndOverlay.acceptsInput()) return;            // inside the grace window
  if (Arcade.EndOverlay.consumePending()) { Arcade.Initials.open(); return; }  // qualified → enter initials
  Arcade.EndOverlay.hide();
  Arcade.Splash.enterAttract();
}

// Game loop:
function tick(now) {
  requestAnimationFrame(tick);
  if (!Arcade.Splash.isPlaying()) return;   // frozen on title/attract
  if (Arcade.Pause.isPaused()) { draw(); return; }
  update(dt);
  draw();
}
```

---

## Conventions

- **SFX ids** = the keys in `Arcade.Audio.init({sfx})`. The matching `<audio>`
  element is just the pre-decode fallback.
- **BGM ids** must start with `bgm` (`bgm`, `bgm-title`, `bgm-boss`, …). That
  prefix is how both `Arcade.Music` and the pause MUSIC slider find tracks.
- **Leaderboard `game` key** must be in the worker's `GAMES` allowlist
  (`infra/leaderboard-worker/src/worker.ts`). Mirror lives at
  `localStorage['oyster-arcade-leaderboard-<game>']`.
- **Shared volume keys** (cabinet-wide, set by `pause.js`):
  `oyster-arcade-music-volume`, `oyster-arcade-sfx-volume` (each `0..1`).
- **Retint, don't restate.** Override per-game colour via the documented CSS
  vars — `--splash-bg`, `--go-*` (overlays), `--lb-title-size` (leaderboard) —
  rather than re-declaring the shared rules. The only block each game writes
  from scratch is its own `.splash .title` marquee + bespoke title art.
- **`.key-only` / `.touch-only`** swap keyboard vs touch hint copy automatically
  on coarse pointers (from `touch.css`). Author both; the cabinet shows the right one.

> Adding a new shared module or stylesheet? Update this file's reference table
> and load-order list in the same change so the contract stays trustworthy.

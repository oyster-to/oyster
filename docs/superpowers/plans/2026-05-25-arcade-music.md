# Arcade.Music (FW-0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated background-music control from invaders and space-jumper into a shared `Arcade.Music` module (a track multiplexer + iOS autoplay-retry), behaviour-preserving.

**Architecture:** A small IIFE at `docs/arcade/shared/music.js` exposing `window.Arcade.Music` with `play/pause/stop/resume/current`. It operates on the `<audio id^="bgm">` elements already in each game's DOM (the same prefix `pause.js` uses), so games register nothing — they just call `Music.play('bgm-theme')`. Per-track volume is passed as `{ gain }` so each game keeps its tuned mix. A headless Node test (`music.test.cjs`) covers the logic; the two games are then re-wired to call the module.

**Tech Stack:** Plain browser JS (no build step), Node `vm` + `fs` for the headless DOM-stub test (matching `touch.test.cjs` / `splash.test.cjs`).

**Spec:** `docs/superpowers/specs/2026-05-25-arcade-music-module-design.md`

**Scope note:** rocket-ship's BGM is **not** migrated here — it's folded into SP-0 (the rocket-ship PR) to avoid two branches editing `rocket-ship.html`. See the spec's Migration section.

---

## File Structure

- **Create** `docs/arcade/shared/music.js` — the module. One responsibility: pick which bgm track plays, survive autoplay block.
- **Create** `docs/arcade/shared/music.test.cjs` — headless test for the module.
- **Modify** `docs/arcade/invaders/index.html` — add the include; reimplement `playBgm` body to call `Arcade.Music`.
- **Modify** `docs/arcade/space-jumper/index.html` — add the include; route `pauseBgm`/`resumeBgm`, the splash hooks, and the per-level track switch through `Arcade.Music`.

---

### Task 1: `Arcade.Music` module + headless test

**Files:**
- Create: `docs/arcade/shared/music.test.cjs`
- Create: `docs/arcade/shared/music.js`

- [ ] **Step 1: Write the failing test**

Create `docs/arcade/shared/music.test.cjs`:

```js
// Tests for Arcade.Music — run with `node music.test.cjs`.
// Loads the real shared/music.js into a DOM stub with fake <audio> elements,
// then checks the multiplexer (play one, pause+reset others), the { gain }
// volume, stop vs pause, and the iOS autoplay-block retry via resume().

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeAudio(id) {
  return {
    id,
    paused: true,
    currentTime: 7,        // non-zero so a reset to 0 is observable
    volume: 1,
    loop: false,
    _blockPlay: false,     // true => play() rejects, simulating the iOS autoplay block
    _plays: 0,
    play() {
      this._plays++;
      if (this._blockPlay) return Promise.reject(new Error('autoplay blocked'));
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; },
  };
}

const theme = makeAudio('bgm-theme');
const level = makeAudio('bgm');
const boss  = makeAudio('bgm-boss');
const byId  = { 'bgm-theme': theme, 'bgm': level, 'bgm-boss': boss };
const allBgm = [theme, level, boss];

const sandbox = {
  console,
  document: {
    getElementById(id) { return byId[id] || null; },
    // The module's only selector is audio[id^="bgm"] — every fake track matches.
    querySelectorAll(sel) { return sel.indexOf('bgm') >= 0 ? allBgm : []; },
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'music.js'), 'utf8'), sandbox);
const M = sandbox.Arcade.Music;

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}
const tick = () => Promise.resolve();   // flush one microtask round

(async () => {
  // play(): track plays, currentTime reset, gain applied, loops, current() set
  M.play('bgm-theme', { gain: 0.4 });
  check('theme playing', theme.paused, false);
  check('theme reset to 0', theme.currentTime, 0);
  check('theme gain applied', theme.volume, 0.4);
  check('theme loops by default', theme.loop, true);
  check('current() is theme', M.current(), 'bgm-theme');

  // switch: previous track pauses + resets, new one plays
  theme.currentTime = 9;
  M.play('bgm', { gain: 0.35 });
  check('theme paused on switch', theme.paused, true);
  check('theme reset on switch', theme.currentTime, 0);
  check('level playing', level.paused, false);
  check('level gain applied', level.volume, 0.35);
  check('current() is level', M.current(), 'bgm');

  // no gain => volume untouched (invaders model: pause.js owns volume)
  boss.volume = 0.9;
  M.play('bgm-boss');
  check('no-gain leaves volume untouched', boss.volume, 0.9);
  check('level paused when boss starts', level.paused, true);

  // stop(): pause + reset current, clear current()
  boss.currentTime = 4;
  M.stop();
  check('boss paused after stop', boss.paused, true);
  check('boss reset after stop', boss.currentTime, 0);
  check('current() null after stop', M.current(), null);

  // pause(): pause current WITHOUT resetting
  M.play('bgm', { gain: 0.35 });
  level.currentTime = 12;
  M.pause();
  check('level paused after pause()', level.paused, true);
  check('pause() does not reset currentTime', level.currentTime, 12);

  // autoplay block: play() rejects, track stays paused, resume() retries
  theme._blockPlay = true;
  M.play('bgm-theme', { gain: 0.4 });
  await tick();   // let the rejected play()'s .catch run
  check('blocked play leaves track paused', theme.paused, true);
  check('current() still set after block', M.current(), 'bgm-theme');

  theme._blockPlay = false;        // gesture arrives; autoplay now allowed
  const playsBefore = theme._plays;
  M.resume();
  await tick();
  check('resume() retried the pending track', theme._plays, playsBefore + 1);
  check('resume() -> theme now playing', theme.paused, false);

  // resume() with nothing pending is a safe no-op
  const playsAfter = theme._plays;
  M.resume();
  check('resume with nothing pending does not replay', theme._plays, playsAfter);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node docs/arcade/shared/music.test.cjs`
Expected: FAIL — throws `ENOENT ... music.js` (the module doesn't exist yet).

- [ ] **Step 3: Write the module**

Create `docs/arcade/shared/music.js`:

```js
// Shared BGM control for the arcade games. One track plays at a time; play()
// pauses + resets the others. Survives the iOS autoplay block: a play() the
// browser rejects is remembered and retried by resume() (call it from the
// splash's first-gesture unlockAudio hook).
//
// Operates on the <audio id^="bgm"> elements already in each game's DOM — the
// same prefix pause.js uses for the MUSIC volume slider. No registration:
// games just call Music.play('bgm-theme'), Music.play('bgm'), etc.
//
// Volume: pass { gain } to set a track's volume on play (each game keeps its
// own tuned per-track levels). The module does NOT coordinate with pause.js's
// music slider — it replicates today's per-game behaviour (set volume on play).
//
// Usage:
//   Arcade.Music.play('bgm-theme', { gain: 0.4 });   // title theme
//   Arcade.Music.play('bgm', { gain: 0.35 });        // level music
//   Arcade.Music.pause();                            // pause current (no reset)
//   Arcade.Music.stop();                             // pause + reset current
//   Arcade.Music.resume();                           // retry pending (iOS gesture)

(function () {
  const SELECTOR = 'audio[id^="bgm"]';
  let currentId = null;   // id of the track we last asked to play
  let pendingId = null;   // a play() the browser rejected, awaiting resume()

  function bgmEls() {
    try { return Array.prototype.slice.call(document.querySelectorAll(SELECTOR)); }
    catch (_) { return []; }
  }

  // Start one element. gain null => leave volume as-is. restart false => keep
  // currentTime (used by resume()). A rejected play() (autoplay block) marks the
  // track pending for the next resume().
  function start(a, id, gain, loop, restart) {
    try {
      a.loop = loop;
      if (gain != null) a.volume = gain;
      if (restart) a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => { pendingId = id; });
    } catch (_) { pendingId = id; }
  }

  function play(id, opts) {
    opts = opts || {};
    const loop = opts.loop !== false;        // default true
    const restart = opts.restart !== false;  // default true
    const target = document.getElementById(id);
    if (!target) return;
    bgmEls().forEach(a => {
      if (a === target) return;
      try { a.pause(); if (restart) a.currentTime = 0; } catch (_) {}
    });
    currentId = id;
    pendingId = null;
    start(target, id, opts.gain, loop, restart);
  }

  function pause() {
    if (!currentId) return;
    const a = document.getElementById(currentId);
    if (a) { try { a.pause(); } catch (_) {} }
  }

  function stop() {
    if (!currentId) return;
    const a = document.getElementById(currentId);
    if (a) { try { a.pause(); a.currentTime = 0; } catch (_) {} }
    currentId = null;
    pendingId = null;
  }

  function resume() {
    if (!pendingId) return;
    const id = pendingId;
    pendingId = null;
    const a = document.getElementById(id);
    if (a) start(a, id, null, a.loop, false);   // retry: keep volume + position
  }

  function current() { return currentId; }

  window.Arcade = window.Arcade || {};
  window.Arcade.Music = { play, pause, stop, resume, current };
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node docs/arcade/shared/music.test.cjs`
Expected: PASS — final line `ALL PASS`, exit 0.

- [ ] **Step 5: Confirm the sibling shared tests still pass**

Run: `node docs/arcade/shared/touch.test.cjs && node docs/arcade/shared/splash.test.cjs`
Expected: both end `ALL PASS` (we only added a file; nothing else changed).

- [ ] **Step 6: Commit**

```bash
git add docs/arcade/shared/music.js docs/arcade/shared/music.test.cjs
git commit -m "arcade(shared): Arcade.Music — BGM multiplexer + autoplay-retry"
```

---

### Task 2: Migrate invaders to `Arcade.Music`

**Files:**
- Modify: `docs/arcade/invaders/index.html` (the `shared/*` include block; the `playBgm` definition ~line 241–254)

- [ ] **Step 1: Add the module include**

Edit `docs/arcade/invaders/index.html` — add the `music.js` include immediately before the `pause.js` include (its unique anchor):

Find:
```html
<script src="../shared/pause.js"></script>
```
Replace with:
```html
<script src="../shared/music.js"></script>
<script src="../shared/pause.js"></script>
```

- [ ] **Step 2: Reimplement `playBgm` to call the module**

Find (~line 241–254):
```js
const BGM_IDS = { main: 'bgm', title: 'bgm-title', boss: 'bgm-boss', win: 'bgm-win' };
function playBgm(which /* 'main' | 'boss' | 'win' | 'none' */) {
  for (const [k, id] of Object.entries(BGM_IDS)) {
    const a = document.getElementById(id);
    if (!a) continue;
    if (k === which) {
      try { a.currentTime = 0; a.play().catch(() => {}); } catch (_) {}
    } else {
      try { a.pause(); } catch (_) {}
    }
  }
}
function startBgm() { playBgm('main'); }
function stopBgm()  { playBgm('none'); }
```
Replace with:
```js
const BGM_IDS = { main: 'bgm', title: 'bgm-title', boss: 'bgm-boss', win: 'bgm-win' };
function playBgm(which /* 'main' | 'title' | 'boss' | 'win' | 'none' */) {
  if (which === 'none') { Arcade.Music.stop(); return; }
  const id = BGM_IDS[which];
  if (id) Arcade.Music.play(id);   // no gain — pause.js owns the music volume
}
function startBgm() { playBgm('main'); }
function stopBgm()  { playBgm('none'); }
```

(All existing `playBgm('title'|'boss'|'win'|'main')`, `startBgm()`, `stopBgm()` call sites are unchanged — only the body moved into the module.)

- [ ] **Step 3: Verify the module loads before use**

Run: `grep -n 'shared/music.js' docs/arcade/invaders/index.html`
Expected: one match, above the inline `<script>` block that defines `playBgm` (the include is in `<head>`/top; the game logic is later). Confirm no `playBgm(` for-loop body remains:
Run: `grep -n "for (const \[k, id\] of Object.entries(BGM_IDS))" docs/arcade/invaders/index.html`
Expected: no matches.

- [ ] **Step 4: Manual smoke test**

Serve and open invaders (e.g. `python3 -m http.server --directory docs`, then `/arcade/invaders/`). Verify:
- Title screen plays `bgm-title`; pressing start swaps to `bgm` (main).
- The pause overlay (P/ESC) MUSIC slider still raises/lowers the music.
- (If reachable in a quick run) boss stage swaps to `bgm-boss`, win swaps to `bgm-win`.

- [ ] **Step 5: Commit**

```bash
git add docs/arcade/invaders/index.html
git commit -m "arcade(invaders): BGM via shared Arcade.Music"
```

---

### Task 3: Migrate space-jumper to `Arcade.Music`

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` (the `shared/*` include block; `pauseBgm`/`resumeBgm` ~495–496; the `_bgm`/`_bgmTheme` getters ~628–629; the `Arcade.Splash.mount` hooks ~648–663; the per-level kick in `advanceLevel` ~835–839)

- [ ] **Step 1: Add the module include**

Edit `docs/arcade/space-jumper/index.html` — add the include before the `pause.js` include:

Find:
```html
<script src="../shared/pause.js"></script>
```
Replace with:
```html
<script src="../shared/music.js"></script>
<script src="../shared/pause.js"></script>
```

- [ ] **Step 2: Route `pauseBgm` / `resumeBgm` through the module**

Find (~495–496):
```js
function pauseBgm()  { const a = document.getElementById('bgm'); if (a) a.pause(); }
function resumeBgm() { const a = document.getElementById('bgm'); if (a) { a.currentTime = 0; a.play().catch(() => {}); } }
```
Replace with:
```js
function pauseBgm()  { Arcade.Music.pause(); }
function resumeBgm() { Arcade.Music.play('bgm', { gain: 0.35 }); }
```

- [ ] **Step 3: Route the splash hooks through the module**

Find (~648–663):
```js
  onTitle() {
    const b = _bgm();      if (b) { b.pause(); b.currentTime = 0; }
    const t = _bgmTheme(); if (t) { t.volume = 0.4; t.currentTime = 0; t.play().catch(() => {}); }
    runTitleSequence();   // start Rogers' entrance in time with the theme's intro
  },
  onPlay() {
    const t = _bgmTheme(); if (t) { t.pause(); t.currentTime = 0; }
    const b = _bgm();      if (b) b.volume = 0.35;
    Arcade.Audio.ensureCtx();
    resetRun();                              // resumeBgm() runs inside (now 'playing')
  },
  onLeaderboardShow: () => refreshLeaderboard(),
  unlockAudio() {                            // iOS: first title gesture unlocks audio
    Arcade.Audio.ensureCtx();
    const t = _bgmTheme(); if (t && t.paused) { t.volume = 0.4; t.play().catch(() => {}); runTitleSequence(); }
  },
```
Replace with:
```js
  onTitle() {
    Arcade.Music.play('bgm-theme', { gain: 0.4 });   // pauses + resets level music
    runTitleSequence();   // start Rogers' entrance in time with the theme's intro
  },
  onPlay() {
    Arcade.Music.stop();                     // stop + reset the title theme
    Arcade.Audio.ensureCtx();
    resetRun();                              // resumeBgm() -> Music.play('bgm') starts level music
  },
  onLeaderboardShow: () => refreshLeaderboard(),
  unlockAudio() {                            // iOS: first title gesture unlocks audio
    Arcade.Audio.ensureCtx();
    const t = _bgmTheme();
    if (t && t.paused) { Arcade.Music.play('bgm-theme', { gain: 0.4 }); runTitleSequence(); }
  },
```

- [ ] **Step 4: Route the per-level track switch through the module**

Find (~835–839, inside `advanceLevel`):
```js
  // If loadLevel switched the track, kick playback.
  if (level.bgm !== prevBgm) {
    const bgmEl = document.getElementById('bgm');
    if (bgmEl) bgmEl.play().catch(() => {});
  }
```
Replace with:
```js
  // If loadLevel switched the track, kick playback.
  if (level.bgm !== prevBgm) {
    Arcade.Music.play('bgm', { gain: 0.35 });
  }
```

(The `dataset.src`/`src` swap in `loadLevel` ~809–813 is unchanged — it manages the element's source; `Music.play('bgm')` then starts whatever source is loaded.)

- [ ] **Step 5: Remove the now-unused `_bgm` getter**

After Steps 2–4, `_bgm()` is no longer called (`_bgmTheme()` is still used in `unlockAudio`). Confirm, then remove the dead getter.

Run: `grep -n "_bgm(" docs/arcade/space-jumper/index.html`
Expected: matches only the definition line (~628) — no call sites. (If any call site remains, leave the getter and note it.)

Find (~628):
```js
const _bgm      = () => document.getElementById('bgm');        // level music
```
Delete that line. Keep:
```js
const _bgmTheme = () => document.getElementById('bgm-theme');  // title theme
```

- [ ] **Step 6: Manual smoke test**

Serve and open space-jumper (`/arcade/space-jumper/`). Verify:
- Title screen plays `bgm-theme` and Rogers' entrance animation runs in sync.
- Start → level music (`bgm`) plays; theme stops.
- Die / complete → returns to attract; theme plays again with the entrance re-running.
- Advancing to a level with a different track switches the music cleanly.
- On a touch device (or with autoplay blocked): first tap on the title starts the theme.
- The pause MUSIC slider still controls volume.

- [ ] **Step 7: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "arcade(space-jumper): BGM via shared Arcade.Music"
```

---

## Self-review notes

- **Spec coverage:** module API (Task 1), invaders migration (Task 2), space-jumper migration (Task 3), headless test (Task 1), behaviour-preserving per-track gain (gain args in Tasks 2–3), autoplay-retry (Task 1 test + space-jumper `unlockAudio`). rocket-ship intentionally deferred to SP-0 (spec).
- **Out of scope confirmed absent:** no `Music`↔`Pause` coordination, no crossfades, no SFX changes.
- **Type/name consistency:** `play/pause/stop/resume/current` used identically across module, test, and both migrations. `{ gain }` is the only option exercised by callers; `loop`/`restart` default true.

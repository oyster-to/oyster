# Arcade `Arcade.Music` — shared BGM control (FW-0)

**Date:** 2026-05-25
**Status:** Design / pre-plan
**Branch:** `arcade-music`
**Roadmap context:** `docs/plans/arcade-framework-roadmap.md` — sub-project **FW-0**.
(The roadmap doc lands with SP-0 on branch `rocket-ship-adopt`; this path
resolves on `main` once that merges.)

## Why

BGM control is the one piece of *systematic* duplication left across the
single-player games (per the framework audit). Three games each reinvent the
same job — "play one track, stop the others, reset, set volume, survive the iOS
autoplay block":

- **invaders** (`index.html:241–254`) — `playBgm(which)` multiplexer over a
  `BGM_IDS` map; sets **no volume** (lets `pause.js` own it). The clean model.
- **space-jumper** (`index.html:495–496, 648–663, ~809–838`) — `pauseBgm`/
  `resumeBgm`, `_bgm`/`_bgmTheme` getters, explicit per-track volumes (theme
  `0.4`, level `0.35`), an inline autoplay-retry in `unlockAudio`, and per-level
  `src` swapping.
- **rocket-ship** (`docs/rocket-ship.html:1679–1696`) — `startTitleMusic`/
  `startGameMusic` + an `awaiting` flag that retries title music on the first
  gesture; its own per-track volumes.

Extracting it removes the drift and, per the roadmap's Authoring promise, means
a new game gets BGM by calling a shared helper rather than re-deriving the
autoplay-retry dance.

## What it is

A small `window.Arcade.Music` module operating on the existing
`<audio id^="bgm">` elements already present in each game's DOM. No new audio
elements, no build step — matches the other `shared/*.js` modules.

```
Arcade.Music.play(id, { gain, loop = true, restart = true })
  - pause + (if restart) reset currentTime on every OTHER bgm track
  - play `id`; set volume = gain if gain != null; loop per arg
  - if play() rejects (iOS autoplay block) → remember `id` as pending

Arcade.Music.pause()         // pause the current track (no reset)
Arcade.Music.stop()          // pause + reset ALL bgm tracks; clear selection
Arcade.Music.retryPending()  // retry an autoplay-blocked play(); call from splash unlockAudio
Arcade.Music.current()       // id of the LAST-SELECTED track (may be pending, not audible), or null
```

"bgm track" = any `<audio>` whose `id` starts with `bgm` (same selector
`pause.js` uses). The module discovers them lazily by that prefix, so games
don't register tracks — they just call `play('bgm-theme')` etc.

**Contract.** `Arcade.Music` owns *which* bgm track is active, pausing/resetting
the others, and retrying an autoplay-blocked play after a gesture. It does **not**
own SFX (that's `Arcade.Audio`), the pause overlay UI, the global music-slider
policy, or crossfades. Two deliberate sharp edges, both documented above:
`stop()` clears **all** bgm tracks (robust against a stray track from legacy code
or a race), and `current()` reports the *selected* track, which after an autoplay
block may not yet be audible until `retryPending()` runs. `retryPending()` is
named to avoid implying "resume after pause" — it only re-attempts a blocked
play.

## Scope discipline — behaviour-preserving

This is a refactor, not a re-tune. The extracted module must make every game
**sound identical** to today.

- **Per-track volumes are preserved** by passing each game's current value as
  `gain`. (Rejected alternative: drop volumes and let `pause.js` set one uniform
  music volume — simpler code, but it re-balances every game's mix and would
  need re-tuning by ear.)
- **The pre-existing pause-vs-track-volume quirk is left exactly as-is.** Today
  a game sets `a.volume = 0.4` on play while `pause.js` may set `a.volume =
  userVolume` on a slider change; whichever ran last wins. The module replicates
  today's behaviour (set `gain` on play) and does **not** introduce
  `Music`↔`Pause` coordination. That's not a reported bug, and fixing it adds
  cross-module ordering assumptions — out of scope, flagged for a future
  deliberate pass.
- **Per-level `src` swapping stays in the game.** Space Jumper owns level
  loading; it swaps the `<audio>` element's `src`, then calls
  `Music.play('bgm', { gain })`. The module plays whatever track id it's given.

## Migration

Migrate **invaders + space-jumper** in this sub-project. Two games is enough to
prove the module and remove the systematic duplication.

**rocket-ship is deliberately migrated in SP-0, not here.** SP-0 (branch
`rocket-ship-adopt`) already edits `rocket-ship.html` for end-overlay + pause +
CSS; migrating its BGM on a *second* concurrent branch would mean two branches
editing the same file and a guaranteed merge conflict. Folding rocket-ship's
BGM into the SP-0 PR keeps all of rocket-ship's adoption (chrome **and** Music)
in one reviewable change. **Action:** when SP-0 is planned, flip its "BGM stays
inline" note to "adopt `Arcade.Music`" (replace `startTitleMusic`/
`startGameMusic` + the `awaiting` flag with `Music.play(...)` /
`Music.retryPending()`, and route the out-of-IIFE `bgm-game` pause/play in the
restart/game-over paths through `Music` too).

- **invaders** — `playBgm(which)` → keep the `BGM_IDS` map + the `playBgm`/
  `startBgm`/`stopBgm` wrappers (so all call sites are untouched); reimplement
  the `playBgm` body as `Music.play(BGM_IDS[which])`, with `'none'` →
  `Music.stop()`. No volume (unchanged — pause.js owns it).
- **space-jumper** — `pauseBgm`/`resumeBgm` bodies → `Music.pause()` /
  `Music.play('bgm', { gain: 0.35 })`; `onTitle` theme → `Music.play('bgm-theme',
  { gain: 0.4 })`; `onPlay` theme stop → `Music.stop()` (level music still
  starts via `resetRun` → `resumeBgm`); `unlockAudio` play-if-paused → route
  through `Music.play('bgm-theme', { gain: 0.4 })`; per-level track-switch kick
  → `Music.play('bgm', { gain: 0.35 })`. Per-level `src`/`dataset.src` swap
  unchanged.

Each migrated game adds `<script src="../shared/music.js"></script>` next to its
other `shared/*.js` includes.

## Testing

- **`docs/arcade/shared/music.test.cjs`** — headless DOM-stub test matching the
  existing `touch.test.cjs` / `splash.test.cjs` pattern (Node `vm` + fake
  `document`/audio elements). Assert: `play(a)` then `play(b)` pauses `a` and
  resets its `currentTime`; `gain` sets `volume`; a rejected `play()` is retried
  by `retryPending()`; `stop()` resets **all** bgm tracks; `pause()` doesn't
  reset. This de-risks the migration.
- **Manual:** for each game — title music on the title screen, game music in
  play, clean swap on start and on game-over→attract, and (iOS) music starting
  on the first tap. Confirm the pause MUSIC slider still affects all tracks as
  before.

## Out of scope

- `Music`↔`Pause` volume coordination (the latent quirk above).
- Crossfades / fades. Today's games hard-cut; keep it.
- SFX — that's `Arcade.Audio`, unchanged.
- Any non-BGM change to the three games.

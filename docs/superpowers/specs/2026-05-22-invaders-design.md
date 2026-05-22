# INVADERS — classic fixed-shooter for the Oyster Arcade

**Date:** 2026-05-22
**Status:** Design approved; ready for implementation plan.
**Affects:** new `docs/arcade/invaders/` directory, `docs/arcade/index.html` (catalogue + preview template), `infra/leaderboard-worker/src/worker.ts` (allowlist).

## Summary

Add a tenth game to the Oyster Arcade: a faithful clone of the 1978 fixed-vertical shooter, named **INVADERS** (no "Space" — short, and avoids the obvious trademark). Single-file canvas game under `docs/arcade/invaders/index.html`, built on the same shared modules as Space Jumper (pause, leaderboard, touch, audio, iframe-host), and styled in the arcade's neon palette so it sits next to its siblings without looking out of place.

## Goals

- Classic gameplay: 5×11 marching grid, accelerating tempo as the grid thins, destructible shields, bonus UFO, one player shot on-screen at a time.
- Full retro-colour palette (cyan / pink / yellow / green / purple) matching the rest of the arcade.
- Mobile playable via existing `shared/touch.js` patterns.
- Top-10 leaderboard with initials prompt, persisted server-side via the leaderboard worker.
- Pause + ESC-to-close behaviour identical to other cabinet games.
- New 10th catalogue slot, with a hand-drawn pixel-art preview SVG.

## Non-goals

- No two-player alternating mode.
- No mystery-letter UFO scoring patterns. UFO awards a random pick from `{50, 100, 150, 300}`.
- No background music beyond what fits the existing `shared/audio.js` SFX/BGM contract — start with SFX only; a short looping march tick is enough atmosphere.
- No new shared-engine modules. If a helper would be reusable, log it for a later refactor rather than landing it inside this PR.
- No level themes / palette swaps per wave. The wave just gets harder (lower start row, faster initial march, faster invader shot cadence).
- No edits to other arcade games.

## Game ID, branding, catalogue

- `id: 'invaders'` everywhere (file path, leaderboard key, worker allowlist).
- Display name: `INVADERS`.
- Catalogue entry (appended to `GAMES` in `docs/arcade/index.html`):

  ```js
  { id: 'invaders', name: 'INVADERS', url: 'invaders/', preview: 'preview-invaders' }
  ```

- Preview template `<template id="preview-invaders">`: small SVG mockup showing two rows of pixel invaders and a player ship in the cabinet's signature neon colours. Style matches `preview-space-jumper` (32×32 viewBox, hard-edged rects).

## Visual style

Single deep-space background — gradient `#04050f` → `#0a0a14`. Faint static starfield (5–8 dots, no parallax — this is a *fixed*-screen game).

Sprite palette top→bottom:

| Row | Sprite tier | Colour     | Points |
|-----|-------------|------------|--------|
| 1   | "Squid"     | `#2dd4ff`  | 30     |
| 2   | "Crab"      | `#ff3aa1`  | 20     |
| 3   | "Crab"      | `#ff3aa1`  | 20     |
| 4   | "Octopus"   | `#4ade80`  | 10     |
| 5   | "Octopus"   | `#4ade80`  | 10     |

(Three sprite shapes; rows 2/3 share the crab, rows 4/5 share the octopus — classic.)

- UFO: purple `#a855f7` body, cyan `#2dd4ff` glint.
- Shields: purple `#a855f7`, 4 bunkers, destructible per-pixel (small bitmap, not per-pixel canvas reads — see *Shields* below).
- Player ship: cyan `#2dd4ff`.
- Player + invader shots: white `#ffffff` with a 1-pixel coloured trail tinted to source.
- HUD: `Press Start 2P` via `shared/pixel-font.css`.

Two-frame animation per invader (limbs in/out), advanced once per march step — gives the iconic "shuffle".

## Gameplay rules

- 5 rows × 11 columns = 55 invaders.
- Grid starts at a Y position dependent on wave (`wave 1` starts highest; each subsequent wave starts one invader-row lower, capped at 3 rows below wave 1).
- Single horizontal step per "march tick"; direction reverses + drops one row when any column reaches the play-field edge.
- March tempo: tick interval is a function of *remaining* invaders. Roughly: `interval = baseInterval * (remaining / 55) ^ 0.7`, clamped to a minimum. Wave 2+ scales `baseInterval` down 10% per wave (cap at wave 5).
- Player shot: **one** player bullet on screen at a time. Fire is gated until the previous shot leaves the play-field or hits something. This is the iconic constraint — do not relax it.
- Invader shots: at most 2–3 on screen at once. Each tick, with low probability per column, the lowest live invader of a random eligible column fires a slow bullet (zig-zag art, straight motion). Wave scales fire rate up.
- Shields:
  - 4 bunkers between player and grid.
  - Each bunker is a small 22×16-ish pixel bitmap stored as a `Uint8Array` (1 = solid, 0 = blown). Bullets carve circular holes (radius 2–3 px) on impact and are consumed.
  - Bunkers also erode if the invader grid descends onto them.
- UFO:
  - Spawns at random intervals (every ~25–45 s of play) once the grid is partially cleared.
  - Crosses the top of the screen at constant speed, scores `50 / 100 / 150 / 300` randomly when shot.
  - Plays a low warble while on-screen (defer SFX in v1 if it gets in the way).
- Player lives: 3. Hit by invader bullet → small explosion frame → respawn at left after brief pause.
- Game over: lives = 0, **or** any invader reaches the player line (instant lose, as in the original).
- Wave clear: spawn next wave one row lower, increment wave counter. No "GAME COMPLETE" — this is endless.

## Controls

- Keyboard: `←` / `→` move, `Space` shoot, `P` pause, `Esc` pause (or close-to-cabinet when embedded — `shared/pause.js` owns ESC).
- Touch (`shared/touch.js`): three on-screen buttons — ◀ ▶ to move, FIRE to shoot. Mirrors Space Jumper's ◀ ▶ JUMP button cluster so muscle memory carries between games. (No drag/zone pattern — buttons stay consistent with the rest of the cabinet.)
- No mouse controls.

## Audio

- Reuse shared SFX where they fit:
  - `shared/sfx-explosion.mp3` — invader killed, player killed.
  - `shared/sfx-lose.mp3` — game over.
- Synthesize the classic SFX in WebAudio (no new MP3 assets — the 1978 cabinet generated these in hardware too):
  - **Shoot blip** — short descending square-wave pew (~80 ms).
  - **March heartbeat** — four descending square-wave notes cycled on each tick (E2 → D2 → C2 → B1, ~120 ms each), tempo carried by tick interval.
  - **UFO warble** — siren-style sine sweep while UFO is on-screen (optional v1; can come in step 5).
- A small local helper `synthSfx()` reads `Arcade.Audio.getVolume()` and uses its return value as a master multiplier so the cabinet's SFX slider still controls volume. The helper builds its own `AudioContext` lazily on first user gesture (same iOS-gesture rule as `shared/audio.js`).
- No BGM. The march tick *is* the soundtrack.
- All audio gated through `Arcade.Audio.getVolume()` so mute state respects the cabinet preference.

## File layout

```
docs/arcade/invaders/
  index.html        single-file game (canvas + JS + inline styles + synth SFX)
```

(No new audio assets — see Audio section. Game reuses `../shared/sfx-explosion.mp3` and `../shared/sfx-lose.mp3` via `Arcade.Audio`, and synthesizes shoot blip / march heartbeat / UFO warble inline.)

The HTML mirrors `docs/arcade/space-jumper/index.html` structure: stylesheet links to shared CSS, `<canvas>` element, script tags for shared modules in this order — `iframe-host.js`, `audio.js`, `leaderboard.js`, `touch.js`, `pause.js` — then the inline game module.

## Leaderboard

- `Arcade.Leaderboard.init({ game: 'invaders', max: 10 })` on load.
- On game-over: if `qualifies(score)`, show an initials-entry overlay (3-letter, A–Z + space, arrow-key cycling, same UX as Space Jumper if it has one — otherwise mirror Rocket Ship's pattern). Submit via `Arcade.Leaderboard.submit(score, initials)`.
- Worker allowlist: add `'invaders': { maxScore: 99999 }` to `infra/leaderboard-worker/src/worker.ts` `GAMES` map. **This is part of this PR** — without it the worker rejects submissions and the local mirror is the only persistence. `maxScore` is generous because a long endless run can stack high (≈1,650 pts per wave from invaders + UFOs).
- Worker change is one line + a `wrangler deploy`. The implementation plan should call out the deploy step explicitly.

## Pause + iframe-host

- `shared/pause.js` handles ESC → pause overlay when not embedded, and ESC → close when embedded but pause-owned. The shared module already coordinates this; INVADERS just needs to import it and pause the game loop while `Arcade.Pause.isPaused()` is true.
- Pausing freezes: march tick, bullet motion, UFO motion, animation frames. Score, lives, wave counter stay as-is.

## Touch sizing for cabinet embed

- Match the layout used by Space Jumper: full-bleed canvas in a `.tube` parent, aspect-ratio locked. Test that the touch overlay zones from `shared/touch.css` don't intercept clicks the game needs.

## What v1 does not include

- UFO scoring patterns (the original used the player's shot count modulo a table — interesting but not "classic" in the popular sense, and demands a tuning pass).
- Mystery saucer letters / animations.
- "Tilt" or shield-pierce edge cases.
- Settings persistence beyond what `shared/audio.js` already does.
- Any change to the arcade splash, cabinet shell, or other games.

## Implementation phasing (rough)

Detail belongs in the implementation plan; this is just the order things land:

1. **Scaffold + catalogue.** Empty-canvas `docs/arcade/invaders/index.html`, catalogue entry, preview SVG. Game renders a black canvas with "INVADERS" placeholder. Worker allowlist updated.
2. **Core loop.** Player ship + L/R move + single shot. Invader grid + march + reverse-at-edge + drop-and-speed. Hit detection. Score + lives + game-over.
3. **Shields + invader fire.** Bunker bitmap + pixel-carving collision. Invader bullets. Hit-the-player path.
4. **UFO + audio.** UFO spawn + scoring. Shoot SFX + march heartbeat cycling. Game-over SFX.
5. **Polish + leaderboard.** Wave progression, initials entry, qualifying-prompt path, touch tuning, mobile testing, CHANGELOG entry.

Each step is a green-on-its-own commit on the `arcade-invaders` branch; the implementation plan will firm up the boundaries.

## Touchstones / co-design note

The user's kids are touchstones for arcade design (memory: Crossy Road / Among Us / Roblox feel). After step 2 lands, leave room for a co-design pass on shield shape, UFO design, and wave-difficulty curve before tagging the PR as "ready" — those are exactly the calls that benefit from a six-year-old's eye.

## CHANGELOG

User-visible. One entry under `Added`:

> **INVADERS** — new arcade game. Classic fixed-shooter; 5 rows of marching aliens, destructible shields, bonus UFO, 3 lives, top-10 leaderboard.

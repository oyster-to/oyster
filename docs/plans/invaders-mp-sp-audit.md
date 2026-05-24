# Invaders MP — SP parity audit + phase replan

> Snapshot of where MP stands vs single-player Invaders. Source of truth for the remaining phases of the SP→MP convergence.
>
> SP is `docs/arcade/invaders/index.html` (~3000 LoC, all logic inline). MP is `docs/arcade/invaders-mp/index.html` (~1500 LoC client) + `engine.js` (~300 LoC authoritative sim, bundled into both client host-mode and server worker) + `room.ts` (Cloudflare DO transport).

## TL;DR

**Biggest gaps (priority order):**
1. **Lives** — MP currently does 1-shot-and-out. SP gives 3. Without lives MP rounds are seconds long and frustrating for kids.
2. **Per-player scoring + HUD** — MP shows one global SCORE; needs `players[i].score` on the wire + a per-ship scoreboard. User-confirmed requirement.
3. **Shields** — SP has 4 destructible shields between ships and invaders. MP has none. User-confirmed: shields are **shared across all players** in MP.

**MP-specific design calls that need a decision before Phase D code:**
1. Per-player lives vs shared pool (recommend: per-player, 3 each)
2. Per-player combo chain vs shared (recommend: per-player)
3. Playfield width (240 → wider for 11-col grid?) (recommend: stay 240 for now, accept 8-col grid as the MP variant)

**Revised phase plan:** Phase D = HUD + per-player score + lives; E = shields (shared); F = combos + supers (per-player); G = stages + UFO + popups; H = bosses + win cutscene; I = splash polish + pause overlay; J = leaderboard + deprecate `/invaders/`.

---

## Audit by area

### HUD

The single biggest visual gap. SP renders a tri-column header on the canvas; MP renders only SCORE.

| Element | SP (`drawHUD` ~L1799) | MP (`renderInterpolated` L1190ish) | Gap |
|--|--|--|--|
| SCORE | top-left, "SCORE" label + 4-digit value, white/yellow | "SCORE" + 4-digit value top-left during `running`/`gameover` | needs per-ship variant in seat colour, possibly per-player columns |
| STAGE | top-centre, "STAGE 1-1" / "1-BOSS" | absent | depends on Phase G (stage progression) |
| LIVES | top-right, "LIVES 2" | absent | depends on Phase D (lives system) |
| HI-SCORE | shown on splash + carries during play | absent | Phase J (leaderboard) |

SP scoring is row-tiered: `ROW_POINTS = [30, 20, 20, 10, 10]` (`invaders/index.html:568`). MP uses flat `SCORE_PER_KILL = 10` (`engine.js:58`). Worth porting the row tier — it makes top-row kills feel valuable and creates the strategic "shoot down the squids first" play.

### Background / palette

- **SP:** `bgGradient = linear-gradient(#0d1a60 → #050a30)`, drawn into the canvas via `ctx.createLinearGradient` in `resize()` (`invaders/index.html:218-220`).
- **MP:** `ctx.fillStyle = '#000'; ctx.fillRect(0, 0, PF_W, PF_H);` (`index.html:1100`) — pure black.

Fix is one line in `renderInterpolated`: build a navy gradient once and reuse. The cabinet bezel already gives the brown frame; the playfield should be the SP navy.

### Shields

- **SP:** 4 destructible bunkers between the player and the swarm.
  - Constants: `SHIELD_W=22, SHIELD_H=16, SHIELD_Y=PLAYER_Y-30, SHIELD_COUNT=4` (`invaders/index.html:~520`)
  - Shape: `SHIELD_SHAPE` is a 22×16 ASCII bitmap (`X`=solid, `.`=empty) with the classic dome + alcove silhouette.
  - Damage: bullets erode the bitmap pixel-by-pixel — SP iterates the bitmap on collision and zeros hit pixels. Both player bullets going up and invader bullets coming down chip away at the shield.
  - Per-shield gap formula: `(PF_W - SHIELD_W * SHIELD_COUNT) / (SHIELD_COUNT + 1)`. SP gap = `(260-88)/5 = 34.4`. MP at PF_W=240 would be `(240-88)/5 = 30.4` — workable.

- **MP:** absent. No shield concept in engine, snapshot, or render.

- **MP-specific call (user-confirmed):** **shields are shared across all players**. Engine owns the bitmap; the wire snapshot exposes it (compressed — see Phase E notes); every player's bullets chip the same shields.

### Combo scoring

- **SP:** kills within `COMBO_WINDOW_MS = 1500` extend a chain; multiplier ramps 1 → 2 → 3 → 4 by kill count (`comboMultiplier()` thresholds at 3, 5, 8 kills) (`invaders/index.html:~1668-1673`). Each kill adds `rowPoints × multiplier` and emits a `+30` / `×3 +60` popup.
- **MP (shipped in Phase F):** per-player chain. Engine: `ship.combo: number` (chain count) + `ship.comboDecayIn: number` (seconds left before reset). On each kill: `combo++`, `comboDecayIn = COMBO_WINDOW_SEC` (1.5). The tick handler decays `comboDecayIn` and zeroes `combo` when it hits 0. Wire exposes `players[i].combo`; renderer reads it via `comboMultiplier(combo)` and draws the `xN` HUD badge.

### Super shots (charged fire)

- **SP:** hold SPACE → after `CHARGE_THRESHOLD_MS=500ms` with `superShotAmmo > 0`, releasing fires a fat golden piercing bullet (`CHARGED_BULLET_W=4, CHARGED_BULLET_H=12, CHARGED_BULLET_SPEED=380`) that passes through shields and damages the whole column.
  - Ammo: `SUPER_SHOT_MAX = 3`, start with full clip, +1 awarded every `SUPER_SCORE_INTERVAL=1000` points, refilled to MAX on UFO kill.
  - UI: 3 gold pips above the ship, charge progress bar below the pips while holding, pulsing halo when fully charged & ready (`drawPlayer` `~L1837-1879`).
- **MP (shipped in Phase F):** per-player ammo + release-to-fire charging. Engine: `ship.superAmmo: number` (cap `SUPER_SHOT_MAX = 3`), `ship.chargeSec: number` (accumulates while FIRE held, resets on release), `ship.wasFiring: boolean` (edge tracker), `ship.nextSuperAt: number` (score threshold for next earned ammo). Wire exposes `players[i].superAmmo` + `players[i].chargeSec`. Engine exports `SUPER_SHOT_MAX`, `CHARGE_THRESHOLD_SEC`, `CHARGED_BULLET_W/H/SPEED`. Pips + charge bar + halo render above each ship in seat colour; local charge bar reads `localShip.holdSec` for zero-RTT feedback. UFO ammo refill arrives with Phase G.

### Lives + ship death + respawn

- **SP:** `lives = 3` (`invaders/index.html:382`). Ship hit → death animation → respawn at centre, `lives--`. Gameover when `lives === 0`.
- **MP:** ship hit → `alive = false` permanently. Game ends when ALL ships dead (`engine.js:259`). No respawn.

**MP design (decided):** **Shared pool of 3 respawns**, can adjust after playtesting.
- Engine: `state.lives: number` (default 3).
- On any ship death: if `lives > 0`, decrement lives and respawn that ship after 2s (1s invuln). If `lives === 0`, ship stays permanently dead.
- Gameover when zero ships alive AND no lives left.
- Total deaths before gameover with 4 players: 4 (initial fleet) + 3 (respawns) = **7 deaths** of error budget. Generous for co-op.
- HUD shows single `LIVES: N` value (not per-player columns) — kids share the pool, fewer numbers on screen.

### Stages + progression

- **SP:** `STAGES_PER_SET = 3` (`~L497`). Stages labelled 1-1 → 1-2 → 1-3 → 1-BOSS → 2-1... Each normal stage spawns a fresh grid, harder (faster march, sometimes a marked-cell side effect). Stage announce overlay fades in/out at the top of each.
- **MP:** absent. One round = one grid, then `gameover`. No stage advance, no boss trigger.
- **Design:** stages are shared (one engine state). On grid clear with `phase === 'grid'`, advance `stageNum`; if at `STAGES_PER_SET`, transition to `phase === 'boss'`.

### UFO bonus enemy

- **SP:** flies across the top occasionally. `UFO_SCORES = [50, 100, 150, 300]` (kill point varies by `progress` across the screen — classic Invaders). Spawn interval 25-45s random. UFO kill refills super ammo to MAX. Synth warble plays while on-screen.
- **MP:** absent.
- **Design:** UFO is shared (one per stage). "Who scores it" = whoever lands the killing bullet — consistent with normal kills.

### Score popups

- **SP:** `popups[]` array of `{x, y, text, colour, untilMs}` (`~L436`). Spawned on every kill, boss damage, UFO kill. Fade out 600ms. Drawn over the grid with `ctx.globalAlpha`.
- **MP:** absent.
- **Design:** purely visual. Could live on the client (don't need wire bandwidth) — derive from snapshot score delta. Simpler: spawn popup in the engine and broadcast (~3 floats per popup × ~10 active = trivial).

### Bosses + win cutscene

- **SP:** 4 boss types (`BOSS_TYPES`, `~L461`), each `BOSS_W=BOSS_H=40 PF px`, HP varies (~30+). Spawned at end of each set (`1-BOSS`, `2-BOSS`, ...). `BOSS_ADD_SCORE=50`, boss adds (smaller minions) respawn every `BOSS_ADD_RESPAWN_MS=5000`. Boss death fires the win cutscene if it was the final boss; otherwise advance to next set.
- **Win cutscene:** `phase === 'cutscene'`, `CUTSCENE_MS` for animation (~9.5s), pixel Earth + orbiting ship + flag + "EARTH IS SAFE". Player input dismisses to restart.
- **MP:** absent.
- **Design:** shared (one boss per stage). Boss death scores split among damage-dealers OR awarded to killer; recommend killer-gets-it for simplicity.

### Marked invader (side effect)

- **SP:** one random cell per grid is "marked" — killing it triggers a side effect (probably a popup or score bonus; check `markedCell` usage `~L427, L1004`).
- **MP:** absent. Lower priority.

### Easter egg — Claude invader

- **SP:** exactly one row-3 invader is replaced by a Claude creature sprite, terracotta colour `#d97757` (`~L573`). Cosmetic; scores like a normal row-3 octopus.
- **MP:** absent. Trivial port (sprite + per-grid claudeCol pick + render swap).

### Audio gaps

MP has shoot/kill/explosion/lose wired (Phase B). SP has additionally:

- **March beat synth** — four notes `[E2, D2, C2, B1]` looped on the march tick (`MARCH_NOTES`, `~L348`). Speeds up as the swarm thins. The iconic Invaders heartbeat.
- **UFO warble synth** — sine sweep up-down while UFO on-screen (`~L356`).
- **Super-shot fire** — distinct sound for charged shot release (in SP `synth.shoot(charged)` branches on the boolean).
- **BGM tracks** — 3 tracks: main gameplay, boss (Egyptian-flavoured), win cutscene (`~L240`). Loops; switches on phase change.

### Overlays / chrome

- **Splash chrome** (`splash.css` + `splash.js`): SP uses the full `.splash` shell with CRT power-on animation, marquee, hi-score row, title↔leaderboard cycling. MP's prescreen is a custom panel — not using `.splash`.
- **Pause overlay** (`pause.js`): SP has a pause menu with volume slider. MP has no pause UI; SFX volume is controlled by another arcade game's slider (shared localStorage key).
- **End overlay** (`end-overlay.js`): SP shows "GAME OVER" / score saved / new high score in a styled overlay. MP shows the gameover state via the prescreen text only.
- **Initials entry** (`initials.js`): on new high score, SP prompts for 3-letter initials. MP has nothing — would need a leaderboard server first.
- **Leaderboard** (`leaderboard.js`): SP fetches from the leaderboard worker (`infra/leaderboard-worker`). MP not wired.

### Screen effects

- **SP:** `crt-shake` keyframe in cabinet.css triggered via `.tube.is-shaking` for collisions/deaths. Screen flash on explosion. SP wires this from gameplay events.
- **MP:** none. Easy add — apply class on local explosion event.

---

## MP-specific design calls (needs decision before Phase D)

For each: SP behaviour, MP options, recommended pick.

### 1. Per-player vs shared score
**SP:** single `score` var.
**MP options:** (a) per-player, summed for team display; (b) per-player only, no team total; (c) shared pool (current MP).
**Recommend (a)** — user already said per-player. Wire change: `players[i].score: number` + optional `teamScore` derived. HUD has per-ship columns with seat-colour scores.

### 2. Lives — shared pool of 3 (decided)
Single `state.lives = 3` carried on the wire. Death decrements; respawn if > 0; permanent if 0. HUD shows one `LIVES: N` value. Generous 7-deaths-before-gameover budget for 4-player co-op.

### 3. Shields shared (user-confirmed)
**SP:** single shield grid.
**MP:** engine holds one shared shield bitmap; snapshot exposes it (e.g. RLE-compressed Uint8Array → base64, or per-shield bitmaps as compact ints). Every player's bullets chip the same shields.
**Wire size:** `4 shields × 22 × 16 = 1408 bits = 176 bytes`. Even without compression, fine. With RLE-on-changed-only, trivial.

### 4. Combo chain per-player
**Recommend:** `players[i].combo` and `players[i].lastKillAt` in engine state. Each player's combo decays on their own clock. Combo HUD shows multiplier next to that ship's score (×2 / ×3 / ×4 glow).

### 5. Super shots per-player
**Recommend:** `players[i].superAmmo: number` (capped at SUPER_SHOT_MAX=3), `players[i].chargeStartAt: number` (server clock). Charge bar + pips render above each ship in seat colour. UFO kill refills the killer's ammo only — not the team's.

### 6. UFO kill scoring
**Recommend:** killer gets the points + super ammo refill. Same model as normal kills.

### 7. Stages, bosses, marked cells — all shared
One engine state, all players see the same boss/grid/stage. Killer gets credit for individual bullets.

### 8. Respawn cadence
**Recommend:** 2-second respawn delay at fixed spawn-X (the original even-spacing position), 1-second invulnerability after respawn so they don't die instantly to the same bullet wall.

### 9. Playfield width — widen to 260, 11-col grid (decided)
Match SP. PF_W: 240 → 260. Grid: 8 cols → 11 cols (55 invaders, up from 40). Ship spawn margin recalculates from `(260 - 4*16)/5 = 39.2` per ship (slightly wider spacing than current 35.2 — better for 4 ships not crowding). Canvas bitmap `<canvas width=260>`. fitCanvas already aspect-correct.

This is a 2-line engine change but cascades through render code that assumes 240 — needs a small "preflight" pass during Phase D since lives + 11-col grid touch the same code paths.

### 10. Touch input for supers
**SP:** hold FIRE to charge → release to fire normal or super based on ammo + hold duration.
**MP:** keep the same model. No new touch button needed. The `fire` input on the wire stays a boolean; the engine tracks the hold duration server-side.

---

## Revised phase plan

Each phase = a single PR you'd actually want to review. LoC estimates honest based on the audit.

### Phase D — Playfield widen + HUD + per-player score + shared lives (~300 LoC)
The user-flagged "scores need to be individual" + lives + the playfield widening that the rest of the phases depend on.

**Engine changes:**
- `PF_W: 240 → 260` (matches SP), `INV_COLS: 8 → 11` (55-invader grid).
- `players[i].score: number` (replaces global `score`; keep `teamScore` derived for HUD).
- Row-tiered points: `ROW_POINTS = [30, 20, 20, 10, 10]` (instead of flat 10).
- `state.lives: number` (default 3, shared pool).
- Death flow: bullet hits ship → `alive = false` + `respawnAt = now + 2000ms`. Step decrements `lives` if > 0 and resets ship on respawnAt; otherwise stays dead.
- 1s invulnerability after respawn (`ship.invulnUntil = now + 1000`).
- Gameover when no ships alive AND `lives === 0`.

**Wire:**
- `players[i].score` added, top-level `score` dropped (or kept as `teamScore` if useful).
- Top-level `lives` added.
- `players[i].respawnAt` (for client respawn-timer rendering) and `players[i].invulnUntil` (for blink effect).

**Renderer:**
- HUD across top: `SCORE` per-player columns in seat colour | `STAGE 1-1` (placeholder until Phase G) | `LIVES N` (single shared value, white).
- Respawn blink during invuln (toggle ship visibility every 100ms).
- Possibly draw per-player score above each ship in seat colour (visually associated, kid-friendly).

**Files:** `engine.js`, `engine.d.ts`, `index.html` (canvas width + renderer), `room.ts` (carry new fields, no logic change).

**Wire-version bump:** netcode v21 — but additive fields with default fallbacks so mixed-version clients degrade rather than break.

### Phase E — Shields, shared (~250 LoC)
- Engine: `shields: Uint8Array(SHIELD_COUNT * SHIELD_W * SHIELD_H)` + `SHIELD_SHAPE` constant. Bullet vs shield collision iterates the bitmap, zeros hit pixels.
- Wire: snapshot's `shields` as RLE-compressed (changed-cells delta if bandwidth is a concern; full bitmap otherwise — 176B/tick is fine).
- Renderer: draw shields from the bitmap.
- Position constants: `SHIELD_Y = SHIP_Y - 30`, `SHIELD_COUNT = 4`, gap formula per PF_W.
- Files: `engine.js`, `engine.d.ts`, `sprites.js` (or new `shields.js` for the shape), `index.html` (renderer).

### Phase F — Combos + supers, per-player (~300 LoC)
- Engine: `players[i].combo`, `players[i].lastKillAt`, `players[i].superAmmo`, `players[i].chargeStartAt`. `comboMultiplier(count)` 1/2/3/4. Charged-bullet physics (`CHARGED_BULLET_W/H/SPEED`, passes through shields).
- Wire: add the 4 new player fields.
- Renderer: per-ship combo multiplier glow, super ammo pips + charge bar + halo (port from SP `drawPlayer`).
- Audio: separate `sfx-shoot-charged` SFX (could reuse, or vendor a new one).
- Files: same as D plus a new SFX file.

### Phase G — Stages + UFO + popups (~300 LoC)
- Engine: `phase: 'grid'|'boss'|'cutscene'`, `stageSet`, `stageNum`, stage transition on grid clear, UFO spawn timer + state, `popups[]` array.
- Wire: `phase`, `stageSet`, `stageNum`, `ufo: {x,dir}|null`, `popups: [{x,y,text,colour,untilMs}]`.
- Renderer: stage announce overlay, UFO sprite + warble synth wiring, popup floats.
- Audio: UFO warble synth (port from SP synth, no MP3 needed).
- Files: same as F.

### Phase H — Bosses + win cutscene (~400 LoC)
- Engine: 4 boss types (`BOSS_TYPES`), boss spawn at end of set, boss adds, boss → cutscene transition.
- Renderer: boss sprite + adds + damage popups + the win cutscene (pixel Earth animation + EARTH IS SAFE pose).
- Audio: boss BGM + win BGM (these are the biggest deltas — would need to either vendor MP3s or commit to ditching BGM in MP).
- Files: same as G.

### Phase I — Splash polish + pause overlay (~150 LoC)
- Adopt `shared/splash.css` + `splash.js` for CRT power-on and title-cycle.
- Adopt `shared/pause.js` for the volume slider (pause-the-game semantics need MP-specific design — probably "pause = mute, game keeps running" since you can't pause MP).
- Files: `index.html`, possibly small `shared/*` tweaks.

### Phase J — Leaderboard + deprecate `/invaders/` (~100 LoC)
- Wire MP to `infra/leaderboard-worker` (shared with SP).
- Initials entry on new high score (`shared/initials.js`).
- Redirect `/invaders/*` → `/invaders-mp/` once MP has full parity + lives + supers + bosses.
- Files: `index.html`, `infra/oyster-arcade-site/src/worker.ts` (redirect rule).

---

## Files this affects, at a glance

| Phase | engine.js / .d.ts | sprites.js | index.html | room.ts | shared/* |
|--|--|--|--|--|--|
| D — HUD + score + lives | heavy | — | medium (renderer) | — | — |
| E — Shields | heavy (new state + collisions) | small (shield shape) | medium | — | — |
| F — Combos + supers | heavy | — | medium | — | possibly new sfx |
| G — Stages + UFO + popups | heavy | small (UFO sprite) | medium | — | — |
| H — Bosses + cutscene | heavy | medium (boss sprites) | heavy | — | possibly BGM |
| I — Splash + pause | — | — | medium | — | small splash.js tweaks |
| J — Leaderboard + dep | — | — | medium | — | wire initials.js, leaderboard.js |

## Open questions (still to decide)

1. ~~Lives model~~ — **decided: shared pool of 3.**
2. **Boss / cutscene BGM** (Phase H) — port the MP3s from SP, or skip BGM in MP entirely (lighter bundle, kid-friendlier on iPad with a parent nearby)?
3. ~~Playfield width~~ — **decided: widen to 260, 11-col grid.**
4. **Marked invader side effects** — port now (Phase G) or defer indefinitely?
5. ~~Phase order~~ — **decided: D=HUD+score+lives → E=shields → F=combos+supers → G=stages+UFO+popups → H=bosses+cutscene → I=splash+pause → J=leaderboard.**

## Netcode backlog (post-game-feature)

Defer until the game features land (Phase G+). User priorities, in order:

1. **Solo player skips the DO entirely.** ~95% of sessions are 1-player or 1+kid-joining-mid-round. The current path always opens a WebSocket to the Cloudflare DO, which adds 150–365 ms RTT round-trip from UAE depending on which colo CF picked that day. For solo, run host-mode locally from the start (engine ticks in the same JS context, no wire) — instant. Connect to the DO only when a 2nd player joins via the room code.

2. **Same-LAN MP prefers WebRTC P2P even more aggressively.** Currently signalling goes through the DO and gameplay starts on cloud relay until WebRTC's handshake completes (a few seconds). Defer DO contact further and use a simpler in-LAN discovery (BroadcastChannel? WebRTC over local IP?) when possible. Cloud relay stays as the fallback for cross-network play.

3. **Pin `locationHint: 'weur'` on `idFromName`.** Cuts the CDG-vs-SIN day-to-day variance Henry reported (365 ms on a SIN day vs 150 ms on a CDG day). Worst case stays ~150 ms; no more 2× spikes.

4. **Investigate why P2P doesn't always engage in same-LAN sessions** (Henry's "felt laggy" rounds where the transport badge presumably said RELAY). Possible: router AP isolation, cellular vs Wi-Fi mismatch, signalling stall.

The user's framing: "if I am single player it should be smooth / we prefer LAN/P2P, netcode can stay as a fallback but 95% of cases will be me or my son doing single player and then us joining sitting next to each other."

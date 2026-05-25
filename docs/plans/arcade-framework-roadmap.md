# Arcade Framework — Roadmap & Architecture (north star)

**Date:** 2026-05-25
**Status:** Living reference (not an implementation spec)

> The canonical reference for where the arcade framework is going and why.
> Individual sub-projects get their own design spec + plan. This doc pins the
> shape so they stay coherent.

## The goal

**Someone asks for a new arcade game and the building blocks are already in
place — including for an AI agent spinning one up.** No re-implementing CRT
chrome, audio unlock, touch controls, splash/attract, leaderboard, or
networking. You bring the game; the cabinet is there.

**Games should be authored against a multiplayer-capable substrate from day
one.** This does *not* mean every game must expose multiplayer immediately — a
game can ship solo-only. It means the sim/session *shape* must never block
multiplayer being added later. Kids expect it: a co-op obby (Roblox) or co-op
run (Cuphead) *is* a platformer with multiple players. So single-player is the
degenerate N=1 case of the same substrate, not a separate codebase.

## Authoring promise

A new game should require **game-specific code only**:

- `engine.js` — authoritative state and rules
- `render.js` — drawing that state
- `config` — seats, controls, screens, assets, scoring
- optional level / data files

It should **not** require re-implementing cabinet chrome, touch/audio unlock,
leaderboard, lobby/session, transport, initials, or end overlays.

This is the operational test for every framework sub-project below: does it move
us toward an author (human or agent) only ever writing those four things?

## Why MP-as-default is viable (not aspirational)

`invaders-mp` already proves it. It is **host-authoritative**: `engine.js`
(~1086 LoC, ES module, typed via `engine.d.ts`) is the sim, and the *same code*
runs in the client's host-mode and in the Cloudflare DO worker. As of **#589**
(`solo p1 skips the DO`), a solo player runs that sim **purely locally at 0 RTT**
— the DO only engages when a second player joins.

That is the whole thesis in one data point: **a single-player game is a
host-authoritative multiplayer game with one seat and no transport.**

## The three-tier model

Every game decomposes into three separable tiers:

```
┌─ SIM ───────────────── authoritative, pure, no DOM.
│  (engine.js)            init(seed, seats) → state;  step(state, inputs[], dt) → state.
│                         Runs locally (solo, 0 RTT) OR on the DO (relay fallback).
├─ TRANSPORT / SESSION ── solo: run sim locally · multi: host runs sim + relays via
│  (room.ts + glue)        WebRTC; DO for signaling / lobby / seats. Cloud relay fallback.
└─ CLIENT / CHROME ────── render(state, seat) + input + the cabinet:
   (shared/ + render)     splash/lobby, pause, leaderboard, initials, end-overlay,
                          touch, audio, cabinet CSS.
```

SP and MP do **not** compete over the sim or the chrome. They differ only in the
**session tier** and in **splash-vs-lobby** as the front screen.

## Building-block inventory

| Block | Where | Status |
|---|---|---|
| Cabinet chrome — splash/attract, initials, leaderboard, pause, end-overlay, touch, audio, iframe-host, cabinet/overlays/pixel-font/touch/splash CSS | `docs/arcade/shared/` | ✅ Shared, good APIs, headless tests for touch + splash |
| Authoritative sim pattern (`engine.js` + `.d.ts`) | `docs/arcade/invaders-mp/` | 🟡 Exists for one game; not generalized/documented as a contract |
| Pixel-render primitives (`sprites.js`) | `docs/arcade/invaders-mp/` | 🟡 invaders-only |
| **Session / transport** — DO + WebRTC + lobby + seats + host harness + solo-skips-DO | inline in `invaders-mp/index.html` + `infra/oyster-arcade-mp/` | 🔴 Works, but **locked inline** — not a reusable block |
| **Cabinet bootstrap / new-game scaffold** (`Arcade.Game.boot(config)`) | — | 🔴 Doesn't exist; every game hand-wires DOM + `mount()` calls |
| `Arcade.Music` (BGM control) | — | 🔴 Doesn't exist; 3 games each reinvent it inline |

## Sub-projects

Each is its own spec → plan → implementation. Ordered by recommended sequence,
not strict dependency.

- **`SP-0` — Rocket Ship full adoption.** Adopt `end-overlay`, `pause`, and the
  shared CSS. Small, independent, proves the chrome layer is complete. The
  framework's oldest game becoming its first full customer.
  → spec: `docs/superpowers/specs/2026-05-25-rocket-ship-framework-adoption-design.md`
- **`FW-0` — `Arcade.Music`.** Extract BGM control (play/stop-others/crossfade +
  autoplay-retry) into a shared module. The only *systematic* duplication left
  across the SP games. Model it on invaders' `playBgm(which)` multiplexer.
  Small, standalone. Unblocks Rocket Ship's last non-adopted bit.
- **`MP-1` — invaders-mp → SP parity.** The existing phased plan
  (`docs/plans/invaders-mp-sp-audit.md`, Phases D–J): lives, per-player score,
  shields, combos, supers, stages, bosses, then adopt chrome + leaderboard and
  deprecate `/invaders/`. The proving ground that hardens `engine.js` / `room.ts`.
- **`FW-1` — Extract the session/transport block** (`Arcade.Session` /
  `Arcade.Net`) from invaders-mp into `shared/`. The keystone for "spin up a new
  MP game." **Sequenced after `MP-1`** so it's extracted from stable, proven code
  (the 2026-05-18 spec's "extract once the duplication is stable" rule — which
  was right).
- **`FW-2a` — Documented sim contract.** The conceptual, low-risk half: pin down
  the `engine.js` interface (`init`/`step`, input shape, state shape, determinism
  expectations) as a written contract + `.d.ts`, derived from invaders-mp's
  proven engine. No DOM, no lifecycle — just the shape an author targets.
- **`FW-2b` — Cabinet bootstrap** (`Arcade.Game.boot(config)`). The larger half:
  a bootstrap that injects the standard DOM and wires chrome + session + sim +
  render from a config object. Touches DOM, chrome, session, render, lifecycle,
  and config — kept separate from `FW-2a` precisely because it's bigger and
  riskier. The actual "AI fills in `engine.js` + `render.js` + config" entry
  point. Sits on chrome + session + the `FW-2a` contract.
- **`PROOF` — A second MP game** (co-op platformer / obby). Built *only* on the
  building blocks, and where "what does a multiplayer platformer look like"
  (shared scrolling world, multiple characters, revive vs race) gets answered.
  It is **done** only when it demonstrably:
  - reuses the transport with **no copy-pasted networking code**;
  - reuses the cabinet with **no custom chrome/input/audio-unlock wiring**;
  - runs its sim **locally for solo** (0 RTT) and the **same sim
    host-authoritatively** for multiplayer;
  - has working touch controls, leaderboard, and end/initials flow out of the
    box;
  - is authored as `engine.js` + `render.js` + config + assets (the Authoring
    promise), such that an AI agent can read the scaffold and extend it without
    a guided tour.

## Sequencing rationale

```
SP-0 ─┐
FW-0 ─┤ (independent, low-risk, do anytime — quick wins + de-duplication)
      │
MP-1 ─┴─▶ FW-1 ─▶ FW-2a ──▶ FW-2b ─▶ PROOF
      (parity)  (extract) (contract) (bootstrap) (validate)
```

`SP-0` and `FW-0` are independent and safe now. The MP substrate work
(`FW-1` → `FW-2b`) deliberately waits for `MP-1` so we generalize from code that
has stopped moving. `FW-2a` (the written sim contract) is the low-risk conceptual
step; `FW-2b` (the bootstrap) is the larger one that earns its own spec. `PROOF`
is the acceptance test for the whole vision.

## Supersedes

This consciously moves past **`docs/superpowers/specs/2026-05-18-arcade-shared-engine-design.md`**,
which (correctly, at one game) declared "utilities only — no engine, no
lifecycle contract, no `window.Game`," and deferred Rocket Ship migration
indefinitely. At N=4 games, with a working authoritative sim and an MP-default
decision, the engine + contract that spec deferred is now the point. The
utilities-first instinct still holds for *extraction timing* (`FW-1` waits for
`MP-1`) — we're changing the destination, not the discipline.

## Non-goals (for now)

- A user-facing arcade picker redesign (`arcade.oyster.to` already exists).
- A build step / bundler — the "open the HTML and it works" property stays.
- A level editor, save states, achievements.
- Forcing existing SP games onto the sim/session substrate before `PROOF`
  validates it. Migration, if ever, follows proof — not precedes it.

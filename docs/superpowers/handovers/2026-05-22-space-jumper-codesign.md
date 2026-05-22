# Space Jumper — Co-design session with the kids

**For:** the next session, when Matthew sits down with his sons to design the next chunk of the game together.

**Tone:** this is a *fun* session, not an engineering review. The agent should treat the kids as the senior designers in the room. Their picks > the agent's recommendations.

---

## What's live right now

**Play it at <https://arcade.oyster.to/space-jumper/>** — keyboard or touch both work. Mobile / iPad fine.

**Controls**

- ← / → or A / D — run
- Space / W / ↑ — jump (hold for higher jump; tap for short hop)
- Space again in mid-air, after grabbing a jetpack — burn fuel to thrust upward
- **J — cheat code: toggles a jetpack with full fuel** (great for testing tricky platforms with the kids)
- H — debug hitboxes (probably skip this one with the kids; it just shows red boxes)

**What's in the world** (so the kids know what they're looking at)

- Rogers — the cyan-legged, pink-shirted, purple-cap character
- Walker aliens — squat green Goomba-style mooks; jump on their heads to stomp
- Jetpack pickup — looks like a small white cylinder; once grabbed, hold jump in mid-air for thrust
- Goal flag — yellow triangle at the end of `1-1`
- Background fauna: 3 deer in the treeline, 3 tall **Skystrider** mechs (with pulsing amber eyes — possible future boss), an owl, a bird flock, fireflies, a UFO that crosses every 14 s, a shooting star every 7 s, soft moon halo
- Foreground props: bushes, mushrooms, flowers, rocks, tall grass, signposts, **rabbits that hop**, **butterflies near the flowers**, **frog near the pit**
- Hanging vines drape off the bottom of every platform — Rogers walks behind tall grass

---

## What's coming next (the roadmap)

The full design lives at [`docs/superpowers/specs/2026-05-21-space-jumper-worlds-design.md`](../specs/2026-05-21-space-jumper-worlds-design.md). Short version:

| PR  | Status | What ships |
|-----|--------|-----------|
| **1** | ✅ shipped (#549) | Earth biome + redesigned `1-1` + level progression + viewport-stable physics |
| **2** | next — design with the kids | Spike tile, **flyer enemy** (hover-y alien), levels `1-2` and `1-3` |
| 3   | after that | Static **boss** + arena `1-4` (mechanic TBD) |
| 4   | last in the Earth-and-Moon arc | Whole moon world: low gravity, dark levels with a torch, levels `2-1` → `2-4` |

**Level identities (one gimmick per level — keep it readable):**

| Level | Identity |
|-------|----------|
| 1-1 ✅ | basic jumps |
| 1-2 | spikes & pits |
| 1-3 | flyers |
| 1-4 | boss |
| 2-1 | moon gravity |
| 2-2 | moon long-jumps |
| 2-3 | darkness / torch |
| 2-4 | moon boss |

---

## Stuff for the kids to decide

These are the genuine open questions. The agent should ASK these out loud as multiple-choice and let the kids pick. Don't recommend an answer — recommend two or three and let them choose.

### 1. What should the **flyer enemy** look like and do?

It's a NEW alien that introduces aerial threat in level 1-3. Spec says it hovers on a sine wave, doesn't walk, stompable like the walker. Wide-open question on personality:

- **Bat-style** — wings flapping, swoops in an arc
- **UFO mini** — tiny pink saucer with a tractor beam, drifts smoothly
- **Spore puff** — a floating green blob with bobbing spikes that pulse
- **Bee-bot** — yellow + black robotic insect with humming wings
- *Their own idea* — draw it on paper and the agent translates to pixel art

### 2. What's the **boss** (PRs 3 & 4)?

Three plausible mechanics from the spec:

- **Stomp-N-times** — boss sits on a platform; jump on its head 3 times. Same as walkers but bigger.
- **Dodge-and-stomp** — boss launches slow blobs / shockwaves you jump over while you close in
- **Switch-the-room** — boss is invulnerable; you reach a switch behind/above it through hazards, then it falls

What does the boss LOOK LIKE? Touchstones:

- Promoted Skystrider (the tall mech in the treeline already — make it walk into the arena)
- Crossy-Road-style chunky animal
- Among-Us-style sus imposter
- Their own creature design

### 3. Level themes for 1-2 and 1-3

Right now both are "Earth biome" — same grass tiles, same dusk sky. We can vary the FEEL per level:

- **1-2** could be "sunset" (warmer sky, longer shadows) — or "stormy" (rain particles, lightning) — or "windy" (more sway on the foliage)
- **1-3** could be "hilltop" (clouds drift past at the player's level) — or "forest depths" (denser pines, mossier vines) — or "rocky outcrop" (more stone tiles than soil)

Pick a theme per level; the agent will translate to palette + decoration tweaks.

### 4. The Skystrider's role

The big mech in the background — currently just pacing the treeline. Options:

- Stay decorative (current state) — sets the world
- Wake up in `1-4` and become the Earth boss
- Wake up only on the moon (`2-4` boss)
- Become a friendly creature you can ride (much bigger feature — would push to a later PR)

---

## Wild-idea bucket

The kids are likely to come up with stuff that's NOT on this list. Capture EVERYTHING, then triage. Some seeds in case the well runs dry:

- Power-ups beyond the jetpack — double-jump boots, slow-fall umbrella, anti-gravity bubble
- A second character you can swap to (Rogers' sister? Robot friend? Pet?)
- Coin-multiplier zones — find a hidden room and every coin is worth 3×
- Day/night cycle within a level — the sky shifts colour as you progress
- Secret level — fall through a specific pit on purpose and land in a bonus stage
- Local-multiplayer mode — split-screen co-op with the second player joining via touch
- A "photo mode" — pause the game, move Rogers into a pose, screenshot

The framework ambition (per Matthew's memory) is that `docs/arcade/shared/` becomes a thing other people / AI agents can target to build their own arcade games. Keep an ear open for ideas that would generalise (e.g. "I want lava" → tile-class system already supports it cheaply).

---

## How the session should run

1. **Open the game on a big screen.** Let the kids play 1-1 first, no narration. Watch where they laugh / die / get confused.
2. **Ask: "what should we add next?"** before showing them the roadmap. Listen.
3. **Then** show them the PR-2 plan: spikes + flyer + two new levels. Ask the questions in §3 above one at a time.
4. **Sketch on paper.** Pixel art works great from doodles. If a kid draws a creature, photograph it; the agent can translate to a pixel sprite in the same chunky style as the walker / Rogers.
5. **End with one concrete commit.** A new prop sprite, a new enemy palette, a fresh level coordinate — something they can play on `arcade.oyster.to` within ~15 min via the deploy command below.

**Deploy command** (run from repo root, in the main checkout — no worktree needed for small content tweaks):

```bash
npm --prefix infra/oyster-arcade-site run deploy
```

---

## Useful pointers for the agent

- The game is a **single HTML file**: `docs/arcade/space-jumper/index.html`. No build step. Edit, refresh, done.
- Level data lives in the `LEVELS` array near the top of that file. Each level is a self-describing object — tile strings, coin positions, enemy list, props list.
- **Tile strings must be exactly `level.width` chars per row** — the file has a Node sanity check used in the original PR; re-use it after any tile edit:

  ```bash
  node -e "/* see PR #549 plan, 'Sanity-check tile-string widths' step */"
  ```

- **Physics constants are tile-fractions** (`MOVE_ACCEL_FRAC`, `GRAVITY_FRAC`, `JUMP_VEL_FRAC`, etc.). Peak jump is locked at **2.72 tiles** at any viewport. If the kids design a platform >2.72 tiles up from the previous one, it's unreachable without the jetpack — flag this early.
- **Sprite design unit `SPRITE_U`** (floored at 2). Background fauna and decorative sprites multiply hardcoded coords by `SPRITE_U` so they stay legible on big monitors.
- **Prop animation phase** is seeded from `p.col` (world-stable), not screen `x` — don't accidentally seed from `x` again or props will look like they're animating because of camera motion.
- **Biome gates exist** on `drawForegroundGrass` and `drawPlatformDrapes` — both early-return on non-earth biomes so moon levels won't inherit Earth vegetation.

---

## Don't

- Don't suggest installing the game as a PWA (Matthew was burned on that path with another project — see his memory)
- Don't add CHANGELOG entries for arcade work — it's out of consumer-changelog scope
- Don't reference Horizon Zero Dawn (or any IP) in code/comments — the existing "Skystrider" name is the generic substitute
- Don't override a kid's design choice with "well actually." If they want a pink mountain with eyes, build the pink mountain with eyes.

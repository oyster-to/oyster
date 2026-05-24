// Authoritative Invaders simulation shared by the server (bundled
// into the MP worker by wrangler) and the host-mode client (loaded
// as a <script type="module">). Pure functions only — no I/O, no
// globals. The caller drives time and supplies input bags.
//
// Logical units: 260 wide × 280 tall (the client scales the canvas).
// Origin is top-left. Down = +y.
//
// Types live in engine.d.ts as an ambient sibling declaration so
// room.ts gets full TypeScript type-checking against this file
// without an allowJs build flag.

// === Playfield ===
// Widened from 240 in Phase D to match SP and host the 11-column
// invader grid. With 4 ships at SHIP_W=16, the spawn margin is now
// (260 - 64) / 5 = 39.2 per ship (vs 35.2 at PF_W=240) so the ships
// also sit slightly less crowded.
export const PF_W = 260;
export const PF_H = 280;

// === Seats / players ===
// Up to MAX_SEATS players per room (couch co-op with 4 devices on
// the same Wi-Fi). The wire snapshot's `players` array is always
// MAX_SEATS long; absent players show as alive=false (the room masks
// unoccupied seats before broadcasting).
export const SEATS = Object.freeze(['p1', 'p2', 'p3', 'p4']);
export const MAX_SEATS = SEATS.length;

// === Ships ===
export const SHIP_W = 16;
export const SHIP_H = 8;
export const SHIP_Y = PF_H - 20;
export const SHIP_SPEED = 90;        // logical units / second
export const FIRE_COOLDOWN = 0.45;   // seconds between shots per ship

// === Bullets ===
export const BULLET_W = 2;
export const BULLET_H = 6;
export const BULLET_SPEED = 220;
const INV_BULLET_SPEED = 120;

// === Invaders ===
const INV_ROWS = 5;
// SP parity: 11 cols, 18×12 cells, sprites rendered at 1.5× so an
// 8×8 source paints 12×12, with 3 PF padding inside the 18-wide cell.
// INV_GAP_X = 18 → cells touch edge-to-edge. INV_GAP_Y = 15 → 3 PF
// row gap (sprite 12 tall + 3 = 15). Grid spans 11*18 = 198 PF in
// PF=260 → 31 PF margin each side. Fractional sprite scale is fine
// here because cellX/cellY are Math.round'd in the renderer, so the
// within-sprite fractional offsets are constant per-frame (anti-
// aliased edges stay still — no flicker; only positions changing
// per-frame caused the old shimmer).
export const INV_COLS = 11;
export const INV_W = 18;
export const INV_H = 12;
const INV_GAP_X = 18;
const INV_GAP_Y = 15;
const INV_ORIGIN_X = 31;
const INV_ORIGIN_Y = 24;
const INV_DROP = 8;
// Per-row point value, top→bottom. Matches SP — top row (squid) is
// worth most, bottom rows (octopus) least, so going for the top row
// first is the strategic play.
export const ROW_POINTS = [30, 20, 20, 10, 10];
// Continuous-march speed (u/s) shrinks as the swarm thins so the last
// few invaders sprint. The discrete-shuffle version of this used a
// step every ~0.55 s with a 2-unit jump (≈3.6 u/s).
const INV_SPEED_FULL = 3.6;
const INV_SPEED_MIN  = 20;
// Wall-bounce drop speed. 8 units at 64 u/s = 125 ms — a hop, not a
// teleport at the current tick rate.
const INV_DROP_SPEED = 64;
const INV_FIRE_INTERVAL = 1.4;

// === Shields ===
// 4 destructible bunkers between the swarm and the ship row, ported
// from SP. Shared across all players in MP: the whole team shoots
// through the same bunkers and both player + invader bullets chip
// the same bitmap. State lives in state.shields as a flat Uint8Array
// of length SHIELD_COUNT * SHIELD_W * SHIELD_H (each cell 0 or 1).
export const SHIELD_W = 22;
export const SHIELD_H = 16;
export const SHIELD_COUNT = 4;
export const SHIELD_Y = SHIP_Y - 30;            // sits just above the ship row
// Pre-computed left-x of each shield — integer PF coords so fillRect
// stays on whole device pixels (fractional positions would anti-alias
// edges and make collision math vary with sub-pixel offsets). With
// PF_W=260, 4×22 wide + 5 gaps = 172 PF for 5 gaps → 34 base each +
// 2 remainder. Spread the remainder symmetrically into the outermost
// (left + right) margins so shields stay centred.
const SHIELD_BASE_GAP = Math.floor((PF_W - SHIELD_W * SHIELD_COUNT) / (SHIELD_COUNT + 1));
const SHIELD_REM      = PF_W - SHIELD_W * SHIELD_COUNT - SHIELD_BASE_GAP * (SHIELD_COUNT + 1);
const SHIELD_LEFT_PAD = SHIELD_BASE_GAP + Math.ceil(SHIELD_REM / 2);
const SHIELD_X = [];
for (let s = 0; s < SHIELD_COUNT; s++) {
  SHIELD_X.push(SHIELD_LEFT_PAD + s * (SHIELD_W + SHIELD_BASE_GAP));
}

// Classic Invaders bunker silhouette: dome top + flat sides + a small
// arched alcove at the bottom centre so the ship can crouch under it.
// Each row is SHIELD_W chars; 'X' = solid, anything else = empty.
const SHIELD_SHAPE = [
  '.....XXXXXXXXXXXX.....',
  '...XXXXXXXXXXXXXXXX...',
  '..XXXXXXXXXXXXXXXXXX..',
  '.XXXXXXXXXXXXXXXXXXXX.',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXXXXXXXXXXXXXXXX',
  'XXXXXXXX......XXXXXXXX',
  'XXXXXXX........XXXXXXX',
  'XXXXXXX........XXXXXXX',
  'XXXXXXX........XXXXXXX',
];
function makeShields() {
  const buf = new Uint8Array(SHIELD_COUNT * SHIELD_W * SHIELD_H);
  for (let s = 0; s < SHIELD_COUNT; s++) {
    const base = s * SHIELD_W * SHIELD_H;
    for (let y = 0; y < SHIELD_H; y++) {
      const row = SHIELD_SHAPE[y];
      for (let x = 0; x < SHIELD_W; x++) {
        buf[base + y * SHIELD_W + x] = row[x] === 'X' ? 1 : 0;
      }
    }
  }
  return buf;
}

// === Stages ===
// Stages are labelled "set-num" (1-1, 1-2, 1-3, 2-1, ...). Endless
// for now — the boss interrupt every set lands in Phase H. On grid
// clear we advance the counter, rebuild the swarm, and trigger a
// 2 s "STAGE n-m" announce overlay. Player state (score, ammo,
// combo) persists across stages.
const STAGES_PER_SET = 3;
const STAGE_ANNOUNCE_SEC = 2;

// === UFO ===
// Bonus enemy that flies across the top of the playfield occasionally.
// Spawns from a random edge moving inward, despawns when it exits the
// opposite edge or gets shot. Score depends on where you hit it
// (UFO_SCORES sampled by progress across the screen — classic). A
// kill refills the shooter's super-shot ammo to MAX, which is the
// strategic reason to interrupt your aim and chase the UFO.
const UFO_W = 16;
const UFO_H = 7;
const UFO_Y = 12;                        // sits above the invader grid (INV_ORIGIN_Y=24)
const UFO_SPEED = 50;                    // PF/sec
const UFO_MIN_INTERVAL = 25;             // seconds — earliest possible respawn
const UFO_MAX_INTERVAL = 45;             // seconds — latest
const UFO_SCORES = [50, 100, 150, 300];
export const UFO_W_EXPORT = UFO_W;        // for renderer + collision
export const UFO_H_EXPORT = UFO_H;
export const UFO_Y_EXPORT = UFO_Y;

// === Score popups ===
// Floating "+30" / "x3 +60" text spawned on each kill, fades over
// POPUP_LIFE_SEC. Lives only on the wire when active. Server pushes
// new ones into state.popups; tick decrements life + floats up; the
// snapshot dump filters out expired entries before broadcast.
const POPUP_LIFE_SEC = 0.6;
const POPUP_FLOAT_SPEED = 18;             // PF/sec, upward drift

// === Lives + respawn ===
// Shared pool of respawn tokens. 3 means up to 3 ship deaths get
// brought back; the 4th (and beyond) is permanent. With 4 ships +
// 3 respawns = 7 total deaths before gameover — generous error
// budget for kid co-op.
export const STARTING_LIVES = 3;
const RESPAWN_SEC = 2;
const INVULN_SEC = 1;

// === Combos ===
// Kills within COMBO_WINDOW_SEC of the previous extend the chain.
// Multiplier ramps at SP's thresholds: 1× → 2× (3 kills) → 3× (5) →
// 4× (8). Each kill awards ROW_POINTS[row] × multiplier to the owner.
// Per-player state — each ship maintains its own chain so kills by
// one player don't boost a teammate's multiplier.
const COMBO_WINDOW_SEC = 1.5;
export function comboMultiplier(count) {
  if (count >= 8) return 4;
  if (count >= 5) return 3;
  if (count >= 3) return 2;
  return 1;
}

// === Super shots (charged fire) ===
// Hold FIRE for ≥ CHARGE_THRESHOLD_SEC with superAmmo > 0 and the
// next bullet spawned is a fat golden piercer: passes through
// shields (carves but isn't consumed) and through invaders (kills
// every one in its path, not just the first). Earned +1 ammo every
// SUPER_SCORE_INTERVAL points; UFO refill to max in Phase G.
export const SUPER_SHOT_MAX = 3;
export const CHARGE_THRESHOLD_SEC = 0.5;
const SUPER_SCORE_INTERVAL = 1000;
export const CHARGED_BULLET_W = 4;
export const CHARGED_BULLET_H = 12;
export const CHARGED_BULLET_SPEED = 380;

export function zeroInput() {
  return { left: false, right: false, fire: false };
}

// === Init / reset ===

// Even spacing of MAX_SEATS ships across the playfield: (N+1) equal
// margins surrounding N ships. With N=4, PF_W=240, SHIP_W=16 the
// margin is 35.2 → spawn x's [35.2, 86.4, 137.6, 188.8].
const SHIP_MARGIN = (PF_W - MAX_SEATS * SHIP_W) / (MAX_SEATS + 1);
function spawnX(seatIndex) {
  return SHIP_MARGIN + seatIndex * (SHIP_W + SHIP_MARGIN);
}

function freshShips() {
  const ships = {};
  for (let i = 0; i < MAX_SEATS; i++) {
    ships[SEATS[i]] = {
      x: spawnX(i),
      alive: true,
      cooldown: 0,
      // Per-player score — replaces the old top-level state.score.
      // Each kill awards ROW_POINTS[invader-row] × combo multiplier.
      score: 0,
      // Seconds until respawn (0 = not respawning). Set when a death
      // consumes a shared life token; ticked down each step; on hit-0
      // the ship blinks back at spawnX with invulnFor set.
      respawnIn: 0,
      // Seconds of post-respawn invulnerability remaining. Engine-
      // internal — resolveCollisions skips damage while > 0.
      invulnFor: 0,
      // Combo chain — how many consecutive kills within the decay
      // window. comboDecayIn ticks down each step; when it hits 0,
      // combo resets to 0. comboMultiplier(combo) gives the score
      // bonus 1×/2×/3×/4×.
      combo: 0,
      comboDecayIn: 0,
      // Super-shot ammo + charge accumulator. chargeSec ticks up
      // while FIRE is held. SP-style release-to-fire: a shot spawns
      // on the input.fire true→false transition — if chargeSec was
      // ≥ CHARGE_THRESHOLD_SEC AND superAmmo > 0 it's a charged
      // bullet, otherwise a normal one. wasFiring tracks the previous
      // tick's input so we can detect the edge.
      superAmmo: SUPER_SHOT_MAX,
      chargeSec: 0,
      wasFiring: false,
      nextSuperAt: SUPER_SCORE_INTERVAL,
    };
  }
  return ships;
}

export function initState() {
  return {
    status: 'waiting',
    won: false,
    // Shared pool of respawn tokens (see STARTING_LIVES).
    lives: STARTING_LIVES,
    ships: freshShips(),
    bullets: [],
    invaderBullets: [],
    invaders: buildGrid(),
    // Shared destructible shields — flat Uint8Array of all
    // SHIELD_COUNT bunkers. Bullets chip cells to 0; renderer reads
    // the bitmap directly.
    shields: makeShields(),
    // Stage progression (Phase G). stageSet 1..∞, stageNum 1..3,
    // labelled "1-1" / "1-2" / ... by the renderer. announceIn counts
    // down a brief "STAGE n-m" overlay fade after each wave clear.
    stageSet: 1,
    stageNum: 1,
    stageAnnounceIn: 0,
    // UFO bonus enemy. ufo is null when off-screen; ufoNextSec ticks
    // down the time until the next spawn (randomised on each despawn).
    ufo: null,
    ufoNextSec: UFO_MIN_INTERVAL + Math.random() * (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL),
    // Floating "+30" / "x3 +60" score popups. Each entry {x, y, text,
    // col, life} where life is seconds remaining; tick decays + drifts
    // y upward; expired entries filtered out before broadcast.
    popups: [],
    invaderDir: 1,
    invaderDropRemaining: 0,
    invaderFireAccum: 0,
    // 2-frame "shuffle" animation. Advances by horizontal distance
    // travelled, mirroring SP's discrete-step flip (~2 units per
    // beat) — so the animation cadence is tied to march speed and
    // accelerates naturally as the swarm thins.
    invaderFrame: 0,
    invaderFrameAccum: 0,
    // Per-seat display name, broadcast in snapshots so every viewer
    // sees the same labels. Set via the `name` wire message. Empty
    // string = no label rendered.
    names: SEATS.reduce((acc, s) => (acc[s] = '', acc), /** @type {Record<string,string>} */({})),
    // Server clock (ms) at which the countdown overlay should end and
    // the game transitions from 'countdown' → 'running'. Only meaningful
    // while status === 'countdown'.
    countdownEndMs: 0,
  };
}

function buildGrid() {
  const out = [];
  for (let row = 0; row < INV_ROWS; row++) {
    for (let col = 0; col < INV_COLS; col++) {
      out.push({
        x: INV_ORIGIN_X + col * INV_GAP_X,
        y: INV_ORIGIN_Y + row * INV_GAP_Y,
        alive: true,
      });
    }
  }
  return out;
}

// === Step ===

const ALL_OCCUPIED = Object.freeze(
  Object.fromEntries(SEATS.map((s) => [s, true])),
);

export function step(state, inputs, dt, occupied = ALL_OCCUPIED) {
  if (state.status !== 'running') return;
  tickRespawnAndInvuln(state, dt);
  tickStageAnnounce(state, dt);
  stepShips(state, inputs, dt, occupied);
  stepBullets(state, dt);
  stepInvaders(state, dt);
  stepInvaderFire(state, dt);
  stepUfo(state, dt);
  stepPopups(state, dt);
  resolveCollisions(state, occupied);
  checkStageClear(state);
  checkEnd(state, occupied);
}

function tickStageAnnounce(state, dt) {
  if (state.stageAnnounceIn > 0) {
    state.stageAnnounceIn = Math.max(0, state.stageAnnounceIn - dt);
  }
}

function stepUfo(state, dt) {
  if (state.ufo) {
    state.ufo.x += UFO_SPEED * state.ufo.dir * dt;
    // Despawn once fully past the opposite edge.
    if ((state.ufo.dir > 0 && state.ufo.x > PF_W) ||
        (state.ufo.dir < 0 && state.ufo.x + UFO_W < 0)) {
      state.ufo = null;
      state.ufoNextSec = UFO_MIN_INTERVAL + Math.random() * (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL);
    }
    return;
  }
  state.ufoNextSec -= dt;
  if (state.ufoNextSec <= 0) {
    const fromLeft = Math.random() < 0.5;
    state.ufo = { x: fromLeft ? -UFO_W : PF_W, dir: fromLeft ? 1 : -1 };
  }
}

function stepPopups(state, dt) {
  if (state.popups.length === 0) return;
  for (const p of state.popups) {
    p.life -= dt;
    p.y -= POPUP_FLOAT_SPEED * dt;
  }
  state.popups = state.popups.filter(p => p.life > 0);
}

// Called after resolveCollisions. If every invader is dead the wave
// is over — bump the stage counter, rebuild the grid, fire the
// announce overlay. Player state (score, ammo, combo, lives) carries
// forward. Bullets persist (they'll fly through to no-op) and
// invaderBullets are cleared so a leftover doesn't reach the ship
// during the announce. UFO + popups stay too.
function checkStageClear(state) {
  if (state.invaders.some(i => i.alive)) return;
  state.stageNum += 1;
  if (state.stageNum > STAGES_PER_SET) {
    state.stageNum = 1;
    state.stageSet += 1;
  }
  state.invaders = buildGrid();
  state.invaderDir = 1;
  state.invaderDropRemaining = 0;
  state.invaderFireAccum = 0;
  state.invaderBullets = [];
  state.stageAnnounceIn = STAGE_ANNOUNCE_SEC;
}

function tickRespawnAndInvuln(state, dt) {
  // Count down respawn + invuln + combo-decay timers each tick. On
  // respawn complete (respawnIn hits 0 from > 0), reset that ship
  // alive at its spawnX with the grace window armed. Permanent-dead
  // ships (lives==0 when they died) have respawnIn = 0 and stay dead
  // — that branch is skipped because the > 0 check fails.
  for (let i = 0; i < MAX_SEATS; i++) {
    const ship = state.ships[SEATS[i]];
    if (ship.invulnFor > 0) {
      ship.invulnFor = Math.max(0, ship.invulnFor - dt);
    }
    if (ship.comboDecayIn > 0) {
      ship.comboDecayIn = Math.max(0, ship.comboDecayIn - dt);
      if (ship.comboDecayIn === 0) ship.combo = 0;
    }
    if (ship.respawnIn > 0) {
      ship.respawnIn = Math.max(0, ship.respawnIn - dt);
      if (ship.respawnIn === 0) {
        ship.x = spawnX(i);
        ship.alive = true;
        ship.cooldown = 0;
        ship.invulnFor = INVULN_SEC;
        // Fresh start on respawn — drop any in-flight combo or
        // mid-hold charge AND clear the wasFiring edge tracker, so
        // a player who died holding FIRE doesn't get an unintended
        // release-edge spawn on the first post-respawn tick.
        // superAmmo + nextSuperAt persist (long-term resource, not
        // per-life).
        ship.combo = 0;
        ship.comboDecayIn = 0;
        ship.chargeSec = 0;
        ship.wasFiring = false;
      }
    }
  }
}

function stepShips(state, inputs, dt, occupied) {
  // Ship horizontal position is client-authoritative: the caller
  // streams `pos` updates and writes them straight into ship.x. This
  // function handles fire + super-shot charging via SP-style release
  // semantics: shots spawn on the input.fire true→false edge. Holding
  // accumulates charge; on release the spawn is charged if held ≥
  // CHARGE_THRESHOLD_SEC AND superAmmo > 0, else normal. Auto-fire on
  // hold is gone (it conflicted with charging — FIRE_COOLDOWN 0.45s
  // < CHARGE_THRESHOLD_SEC 0.5s would have rapid-fired before the
  // charge ever completed). Players tap-tap-tap for rapid normal
  // fire, hold-and-release for charged.
  for (const seat of SEATS) {
    const ship = state.ships[seat];
    if (!ship.alive || !occupied[seat]) continue;
    const input = inputs[seat];
    // Missing input → treat as neutral (released, no charge). Clear
    // chargeSec too so a dropped input tick during a hold can't bank
    // stale charge that fires a charged shot on the next release.
    if (!input) {
      ship.wasFiring = false;
      ship.chargeSec = 0;
      continue;
    }
    ship.cooldown = Math.max(0, ship.cooldown - dt);
    const firing = !!input.fire;
    if (firing) {
      ship.chargeSec += dt;
    } else if (ship.wasFiring) {
      // Release edge: spawn a shot if cooldown is clear. Otherwise
      // the input was just spam — drop the charge silently.
      if (ship.cooldown <= 0) {
        const charged = ship.chargeSec >= CHARGE_THRESHOLD_SEC && ship.superAmmo > 0;
        const bw = charged ? CHARGED_BULLET_W : BULLET_W;
        const bh = charged ? CHARGED_BULLET_H : BULLET_H;
        state.bullets.push({
          x: ship.x + SHIP_W / 2 - bw / 2,
          y: SHIP_Y - bh,
          owner: seat,
          charged: charged,
        });
        ship.cooldown = FIRE_COOLDOWN;
        if (charged) ship.superAmmo--;
      }
      ship.chargeSec = 0;
    }
    ship.wasFiring = firing;
  }
}

function stepBullets(state, dt) {
  // Charged bullets travel faster than the standard variant — matches
  // SP and makes the super read as a punchy salvo, not just a fat
  // ordinary shot.
  for (const b of state.bullets)        b.y -= (b.charged ? CHARGED_BULLET_SPEED : BULLET_SPEED) * dt;
  for (const b of state.invaderBullets) b.y += INV_BULLET_SPEED * dt;
  state.bullets        = state.bullets.filter(b => b.y + (b.charged ? CHARGED_BULLET_H : BULLET_H) > 0);
  state.invaderBullets = state.invaderBullets.filter(b => b.y < PF_H);
}

function stepInvaders(state, dt) {
  const alive = state.invaders.filter(i => i.alive).length;
  if (alive === 0) return;
  const total = INV_ROWS * INV_COLS;
  const t = (total - alive) / Math.max(1, total - 1);
  const speed = INV_SPEED_FULL + (INV_SPEED_MIN - INV_SPEED_FULL) * t;

  // Wall-bounce drop animates over INV_DROP_SPEED u/s. Horizontal
  // motion pauses during the drop, then resumes reversed.
  if (state.invaderDropRemaining > 0) {
    const dy = Math.min(INV_DROP_SPEED * dt, state.invaderDropRemaining);
    for (const inv of state.invaders) if (inv.alive) inv.y += dy;
    state.invaderDropRemaining -= dy;
    return;
  }

  const dx = speed * state.invaderDir * dt;
  let willHitWall = false;
  for (const inv of state.invaders) {
    if (!inv.alive) continue;
    const next = inv.x + dx;
    if (next < 0 || next + INV_W > PF_W) { willHitWall = true; break; }
  }
  if (willHitWall) {
    state.invaderDir = state.invaderDir === 1 ? -1 : 1;
    state.invaderDropRemaining = INV_DROP;
  } else {
    for (const inv of state.invaders) if (inv.alive) inv.x += dx;
    // Distance-based frame flip — matches SP's "every step = pose
    // change" feel. STRIDE chosen so initial 3.6 u/s march flips at
    // ~550 ms (SP's starting cadence); end-game 20 u/s flips at ~100 ms.
    state.invaderFrameAccum += Math.abs(dx);
    if (state.invaderFrameAccum >= 2) {
      const flips = Math.floor(state.invaderFrameAccum / 2);
      state.invaderFrame = (state.invaderFrame + flips) & 1;
      state.invaderFrameAccum -= flips * 2;
    }
  }
}

function stepInvaderFire(state, dt) {
  state.invaderFireAccum += dt;
  if (state.invaderFireAccum < INV_FIRE_INTERVAL) return;
  state.invaderFireAccum = 0;

  // Pick a random column with at least one live invader, then fire
  // from its lowest survivor.
  const cols = [];
  for (let col = 0; col < INV_COLS; col++) {
    if (state.invaders.some((inv, i) => inv.alive && i % INV_COLS === col)) cols.push(col);
  }
  if (cols.length === 0) return;
  const col = cols[Math.floor(Math.random() * cols.length)];
  let shooter = null;
  for (let row = INV_ROWS - 1; row >= 0; row--) {
    const inv = state.invaders[row * INV_COLS + col];
    if (inv.alive) { shooter = inv; break; }
  }
  if (!shooter) return;
  state.invaderBullets.push({
    x: shooter.x + INV_W / 2 - BULLET_W / 2,
    y: shooter.y + INV_H,
    owner: null,
  });
}

// Chip the shared shield bitmap where a bullet AABB overlaps.
// Returns true if at least one solid cell was destroyed (caller kills
// the bullet on hit). Walks only the overlap region — typically a
// 2×6 (player bullet) or 2×6 (invader bullet) cell window, so this
// stays cheap even with many bullets.
function damageShields(state, bx, by, bw, bh) {
  for (let s = 0; s < SHIELD_COUNT; s++) {
    const sx = SHIELD_X[s];
    if (bx + bw <= sx || bx >= sx + SHIELD_W) continue;
    if (by + bh <= SHIELD_Y || by >= SHIELD_Y + SHIELD_H) continue;
    const base = s * SHIELD_W * SHIELD_H;
    const xLo = Math.max(0, Math.floor(bx - sx));
    const xHi = Math.min(SHIELD_W, Math.ceil(bx + bw - sx));
    const yLo = Math.max(0, Math.floor(by - SHIELD_Y));
    const yHi = Math.min(SHIELD_H, Math.ceil(by + bh - SHIELD_Y));
    let hit = false;
    for (let y = yLo; y < yHi; y++) {
      const row = base + y * SHIELD_W;
      for (let x = xLo; x < xHi; x++) {
        if (state.shields[row + x]) {
          state.shields[row + x] = 0;
          hit = true;
        }
      }
    }
    if (hit) return true;       // a bullet only hits one shield at a time
  }
  return false;
}

function resolveCollisions(state, occupied) {
  // Player bullets vs shields. Charged bullets carve cells but
  // aren't consumed — they tunnel through. Normal bullets are
  // killed by the first contact. Marker (-999) is swept by the
  // .filter at the bottom of this function (same tick).
  for (const b of state.bullets) {
    const bw = b.charged ? CHARGED_BULLET_W : BULLET_W;
    const bh = b.charged ? CHARGED_BULLET_H : BULLET_H;
    // Off-screen guard uses the bullet's own height — charged bullets
    // are taller (12 vs 6), so -BULLET_H would skip collisions for
    // charged bullets that are still partially on-screen.
    if (b.y < -bh) continue;
    if (damageShields(state, b.x, b.y, bw, bh) && !b.charged) {
      b.y = -999;
    }
  }

  // Player bullets vs invaders. Score = ROW_POINTS[row] × combo
  // multiplier; the kill extends the owner's combo chain. Normal
  // bullets stop at the first hit; charged bullets pierce every
  // overlap (typically a 1-cell column on its way up, but if the
  // swarm sloped at a wall-bounce more can stack). Earned ammo:
  // crossing nextSuperAt threshold yields +1 (capped at MAX).
  for (const b of state.bullets) {
    const bw = b.charged ? CHARGED_BULLET_W : BULLET_W;
    const bh = b.charged ? CHARGED_BULLET_H : BULLET_H;
    if (b.y < -bh) continue;
    for (let i = 0; i < state.invaders.length; i++) {
      const inv = state.invaders[i];
      if (!inv.alive) continue;
      if (!overlap(b.x, b.y, bw, bh, inv.x, inv.y, INV_W, INV_H)) continue;
      inv.alive = false;
      const owner = b.owner && state.ships[b.owner];
      if (owner) {
        owner.combo += 1;
        owner.comboDecayIn = COMBO_WINDOW_SEC;
        const basePts = ROW_POINTS[Math.floor(i / INV_COLS)] || 0;
        const mult = comboMultiplier(owner.combo);
        const pts = basePts * mult;
        owner.score += pts;
        // Floating score popup: "+30" for a vanilla kill, "x3 +60"
        // when a multiplier's active. Drawn at the killed invader's
        // position, drifts up and fades.
        const text = mult > 1 ? `x${mult} +${pts}` : `+${pts}`;
        state.popups.push({
          x: inv.x + INV_W / 2,
          y: inv.y,
          text: text,
          col: '#ffffff',
          life: POPUP_LIFE_SEC,
        });
        // Earned-ammo threshold crossings — bump the threshold even
        // when at max so a long high-score run isn't "wasted".
        while (owner.score >= owner.nextSuperAt) {
          if (owner.superAmmo < SUPER_SHOT_MAX) owner.superAmmo++;
          owner.nextSuperAt += SUPER_SCORE_INTERVAL;
        }
      }
      if (!b.charged) { b.y = -999; break; }
      // charged: keep checking other invaders this tick
    }
  }

  // Player bullets vs UFO. Charged bullets one-shot a UFO too. Score
  // is sampled from UFO_SCORES by where the UFO is across the screen
  // — closer to the centre/far edge = higher payout. Kill refills
  // the shooter's super ammo to MAX (the strategic carrot).
  if (state.ufo) {
    for (const b of state.bullets) {
      const bw = b.charged ? CHARGED_BULLET_W : BULLET_W;
      const bh = b.charged ? CHARGED_BULLET_H : BULLET_H;
      if (b.y < -bh) continue;
      if (overlap(b.x, b.y, bw, bh, state.ufo.x, UFO_Y, UFO_W, UFO_H)) {
        const progress = (state.ufo.x + UFO_W) / (PF_W + UFO_W * 2);
        const idx = Math.min(UFO_SCORES.length - 1, Math.max(0, Math.floor(progress * UFO_SCORES.length)));
        const pts = UFO_SCORES[idx];
        const owner = b.owner && state.ships[b.owner];
        if (owner) {
          owner.score += pts;
          owner.superAmmo = SUPER_SHOT_MAX;
          state.popups.push({
            x: state.ufo.x + UFO_W / 2,
            y: UFO_Y,
            text: `+${pts}`,
            col: '#ffd84a',          // gold to celebrate the bonus
            life: POPUP_LIFE_SEC,
          });
        }
        state.ufo = null;
        state.ufoNextSec = UFO_MIN_INTERVAL + Math.random() * (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL);
        if (!b.charged) b.y = -999;
        break;                       // one bullet hits at most one UFO
      }
    }
  }
  state.bullets = state.bullets.filter(b => b.y > -BULLET_H);

  // Invader bullets vs shields, FIRST — chip the bunkers, kill the
  // bullet, before any per-ship check. A bullet that hit a shield
  // never reaches the ship below it.
  for (const b of state.invaderBullets) {
    if (b.y > PF_H) continue;
    if (damageShields(state, b.x, b.y, BULLET_W, BULLET_H)) {
      b.y = PF_H + 999;
    }
  }

  // Invader bullets vs ships. Skip unoccupied seats AND ships that
  // are in their post-respawn invulnerability window. On hit: if the
  // shared lives pool has tokens, consume one and queue a respawn;
  // otherwise the ship stays dead permanently.
  for (const b of state.invaderBullets) {
    for (const seat of SEATS) {
      const ship = state.ships[seat];
      if (!ship.alive || !occupied[seat] || ship.invulnFor > 0) continue;
      if (overlap(b.x, b.y, BULLET_W, BULLET_H, ship.x, SHIP_Y, SHIP_W, SHIP_H)) {
        ship.alive = false;
        if (state.lives > 0) {
          state.lives--;
          ship.respawnIn = RESPAWN_SEC;
        }
        b.y = PF_H + 999;
      }
    }
  }
  state.invaderBullets = state.invaderBullets.filter(b => b.y < PF_H);
}

function checkEnd(state, occupied) {
  // Loss conditions:
  //  - any invader has reached the ship row (instant gameover, no
  //    respawn can save you from a swarm breach), OR
  //  - every playable seat is dead AND nobody has a pending respawn
  //    AND the shared lives pool is empty (i.e. no one's coming back).
  const breach = state.invaders.some(i => i.alive && i.y + INV_H >= SHIP_Y);
  if (breach) { state.status = 'gameover'; state.won = false; return; }

  const noOneAlive  = SEATS.every((s) => !(state.ships[s].alive && occupied[s]));
  // A "coming back" seat must be both occupied AND mid-respawn — a
  // disconnected seat's leftover respawnIn shouldn't keep the match
  // running when no one's actually there to come back to.
  const noOneComing = SEATS.every((s) => !(occupied[s] && state.ships[s].respawnIn > 0));
  if (noOneAlive && noOneComing) {
    state.status = 'gameover';
    state.won = false;
    return;
  }

  // No more "every invader dead = win" — stages are endless until
  // a boss interrupts (Phase H) or you lose to breach/wipe.
  // checkStageClear (called before this in step()) handles the
  // grid-clear case by rebuilding the next stage.
}

function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// === Snapshot for the wire ===

function round(n) { return Math.round(n * 10) / 10; }

// Pack the SHIELD_COUNT * SHIELD_W * SHIELD_H bit array into a
// base64 string for the wire. 1408 bits / 8 = 176 bytes → ~236
// chars of base64. Renders the whole bitmap, no diff/RLE — easy to
// reason about, trivial bandwidth. btoa is supported in both
// browsers and Cloudflare Workers.
export function encodeShields(bits) {
  const packed = new Uint8Array((bits.length + 7) >> 3);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) packed[i >> 3] |= 1 << (7 - (i & 7));
  }
  // Single-call fromCharCode via spread — avoids the repeated string
  // allocation + GC churn of `bin += ...` in a loop. The packed
  // bitmap is 176 bytes, well under JS engines' call-arg limits.
  return btoa(String.fromCharCode.apply(null, packed));
}

// Inverse of encodeShields — client-side, takes the base64 string
// from the wire and returns the bits Uint8Array suitable for direct
// rendering.
export function decodeShields(b64) {
  const bin = atob(b64);
  const bits = new Uint8Array(SHIELD_COUNT * SHIELD_W * SHIELD_H);
  for (let i = 0; i < bits.length; i++) {
    if (bin.charCodeAt(i >> 3) & (1 << (7 - (i & 7)))) bits[i] = 1;
  }
  return bits;
}

// Public accessor for the per-shield left-x positions — the renderer
// uses these to translate the bitmap into world coordinates.
export function shieldOffsets() {
  return SHIELD_X.slice();
}

export function snapshotForClient(state) {
  let teamScore = 0;
  for (const s of SEATS) teamScore += state.ships[s].score | 0;
  return {
    status: state.status,
    won: state.won,
    // Team score = sum of per-player scores. Kept on the wire because
    // the gameover/lobby copy ("Earth is safe! Score: 250") reads
    // cleanly as one team number, and external bits (sfx-kill diff)
    // can just watch this for "any kill happened".
    score: teamScore,
    // Shared respawn-pool counter. Decremented each time a ship dies
    // (down to 0). Renderer shows it as the LIVES HUD value.
    lives: state.lives,
    // Server clock the countdown should end at (only meaningful while
    // status === 'countdown'). Client computes seconds-remaining from
    // (countdownEndMs - serverNow) and renders the big overlay.
    countdownEndMs: state.countdownEndMs,
    // `players` is always MAX_SEATS long, indexed by seat position
    // (p1 → 0, p2 → 1, …). The room masks unoccupied seats as
    // alive:false before sending so the client can use this array
    // directly to decide which ships to draw. `name` is the per-seat
    // display name (empty = no label).
    players: SEATS.map((s) => {
      const ship = state.ships[s];
      return {
        x: round(ship.x),
        alive: ship.alive,
        name: state.names?.[s] ?? '',
        // Per-player score (replaces the old top-level state.score).
        score: ship.score,
        // Phase F per-player additions — combo chain length, current
        // super-shot ammo, and the live charge accumulator (so the
        // client can draw a charge progress bar above the ship).
        combo: ship.combo,
        superAmmo: ship.superAmmo,
        chargeSec: round(ship.chargeSec),
      };
    }),
    // `o` (owner) is the firing seat — lets the client filter "my
    // bullets" if it ever wants per-bullet prediction. `c` marks
    // a charged bullet (renderer draws it bigger + gold; collision
    // already handled server-side as pierce + shield pass-through).
    bullets:        state.bullets.map(b => ({ x: round(b.x), y: round(b.y), o: b.owner, c: !!b.charged })),
    invaderBullets: state.invaderBullets.map(b => ({ x: round(b.x), y: round(b.y) })),
    invaders:       state.invaders.map(i => ({ x: round(i.x), y: round(i.y), a: i.alive })),
    // Current swarm animation frame (0 or 1). Authoritative — every
    // client renders the same pose at the same tick instead of each
    // running its own time-based ticker.
    iFrame:         state.invaderFrame,
    // Packed shield bitmap (~236 chars). Every snapshot includes
    // the full bitmap — small enough that diffing or change-tracking
    // would be premature optimisation. Client decodes once per
    // snapshot and renders straight from the resulting Uint8Array.
    shieldsBits:    encodeShields(state.shields),
    // Phase G: stage + UFO + popups. stageSet/stageNum render as
    // "n-m" in the HUD; stageAnnounceIn drives the centred overlay
    // between waves. ufo is null when off-screen. popups is the
    // floating-text list (already filtered to live entries).
    stageSet:       state.stageSet,
    stageNum:       state.stageNum,
    stageAnnounceIn: round(state.stageAnnounceIn),
    ufo:            state.ufo ? { x: round(state.ufo.x), d: state.ufo.dir } : null,
    popups:         state.popups.map(p => ({
      x: round(p.x), y: round(p.y), t: p.text, c: p.col, l: round(p.life),
    })),
  };
}

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
// 11 columns to match SP. With INV_GAP_X=18 and INV_W=12, the grid
// spans (11-1)*18 + 12 = 192 PF units wide; centred in the PF=260
// playfield leaves a (260-192)/2 = 34 PF left/right margin.
export const INV_COLS = 11;
export const INV_W = 12;
export const INV_H = 8;
const INV_GAP_X = 18;
const INV_GAP_Y = 14;
const INV_ORIGIN_X = 34;
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

// === Lives + respawn ===
// Shared pool of respawn tokens. 3 means up to 3 ship deaths get
// brought back; the 4th (and beyond) is permanent. With 4 ships +
// 3 respawns = 7 total deaths before gameover — generous error
// budget for kid co-op.
export const STARTING_LIVES = 3;
const RESPAWN_SEC = 2;
const INVULN_SEC = 1;

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
  /** @type {Record<string, {x:number,alive:boolean,cooldown:number,score:number,respawnIn:number,invulnFor:number}>} */
  const ships = {};
  for (let i = 0; i < MAX_SEATS; i++) {
    ships[SEATS[i]] = {
      x: spawnX(i),
      alive: true,
      cooldown: 0,
      // Per-player score — replaces the old top-level state.score.
      // Each kill awards ROW_POINTS[invader-row] to the bullet owner.
      score: 0,
      // Seconds until respawn (0 = not respawning). Set when a death
      // consumes a shared life token; ticked down each step; on hit-0
      // the ship blinks back at spawnX with invulnFor set.
      respawnIn: 0,
      // Seconds of post-respawn invulnerability remaining. Renderer
      // blinks the ship while > 0 so the player can see the grace
      // window. Also makes resolveCollisions skip damage.
      invulnFor: 0,
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
  stepShips(state, inputs, dt, occupied);
  stepBullets(state, dt);
  stepInvaders(state, dt);
  stepInvaderFire(state, dt);
  resolveCollisions(state, occupied);
  checkEnd(state, occupied);
}

function tickRespawnAndInvuln(state, dt) {
  // Count down respawn + invuln timers each tick. On respawn complete
  // (timer hits 0 from > 0), reset that ship to alive at its spawnX
  // with the grace window armed. Permanent-dead ships (lives==0 when
  // they died) have respawnIn = 0 and stay dead — this branch is
  // skipped for them because the > 0 check fails.
  for (let i = 0; i < MAX_SEATS; i++) {
    const ship = state.ships[SEATS[i]];
    if (ship.invulnFor > 0) {
      ship.invulnFor = Math.max(0, ship.invulnFor - dt);
    }
    if (ship.respawnIn > 0) {
      ship.respawnIn = Math.max(0, ship.respawnIn - dt);
      if (ship.respawnIn === 0) {
        ship.x = spawnX(i);
        ship.alive = true;
        ship.cooldown = 0;
        ship.invulnFor = INVULN_SEC;
      }
    }
  }
}

function stepShips(state, inputs, dt, occupied) {
  // Ship horizontal position is client-authoritative: the caller
  // streams `pos` updates and writes them straight into ship.x. This
  // function only handles fire (so the cooldown + bullet spawn are
  // host-controlled, keeping per-player fire rate fair).
  for (const seat of SEATS) {
    const ship = state.ships[seat];
    if (!ship.alive || !occupied[seat]) continue;
    const input = inputs[seat];
    if (!input) continue;
    ship.cooldown = Math.max(0, ship.cooldown - dt);
    if (input.fire && ship.cooldown <= 0) {
      state.bullets.push({
        x: ship.x + SHIP_W / 2 - BULLET_W / 2,
        y: SHIP_Y - BULLET_H,
        owner: seat,
      });
      ship.cooldown = FIRE_COOLDOWN;
    }
  }
}

function stepBullets(state, dt) {
  for (const b of state.bullets)        b.y -= BULLET_SPEED * dt;
  for (const b of state.invaderBullets) b.y += INV_BULLET_SPEED * dt;
  state.bullets        = state.bullets.filter(b => b.y + BULLET_H > 0);
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

function resolveCollisions(state, occupied) {
  // Player bullets vs invaders. Out-of-array marker (b.y = -999) gets
  // swept by the next stepBullets — cheaper than splicing inside
  // a nested loop. Points are credited to the bullet's owner using
  // the row of the killed invader (top row = squid = 30, bottom row
  // = octopus = 10).
  for (const b of state.bullets) {
    if (b.y < -BULLET_H) continue;
    for (let i = 0; i < state.invaders.length; i++) {
      const inv = state.invaders[i];
      if (!inv.alive) continue;
      if (overlap(b.x, b.y, BULLET_W, BULLET_H, inv.x, inv.y, INV_W, INV_H)) {
        inv.alive = false;
        b.y = -999;
        const owner = b.owner && state.ships[b.owner];
        if (owner) owner.score += ROW_POINTS[Math.floor(i / INV_COLS)] || 0;
        break;
      }
    }
  }
  state.bullets = state.bullets.filter(b => b.y > -BULLET_H);

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
  const noOneComing = SEATS.every((s) => state.ships[s].respawnIn === 0);
  if (noOneAlive && noOneComing) {
    state.status = 'gameover';
    state.won = false;
    return;
  }

  // Win: every invader dead.
  if (!state.invaders.some(i => i.alive)) { state.status = 'gameover'; state.won = true; }
}

function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// === Snapshot for the wire ===

function round(n) { return Math.round(n * 10) / 10; }

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
    players: SEATS.map((s) => ({
      x: round(state.ships[s].x),
      alive: state.ships[s].alive,
      name: state.names?.[s] ?? '',
      // Per-player score (replaces the old top-level state.score).
      score: state.ships[s].score,
    })),
    // `o` (owner) is the firing seat — lets the client filter "my
    // bullets" if it ever wants per-bullet prediction. Invader
    // bullets have no owner.
    bullets:        state.bullets.map(b => ({ x: round(b.x), y: round(b.y), o: b.owner })),
    invaderBullets: state.invaderBullets.map(b => ({ x: round(b.x), y: round(b.y) })),
    invaders:       state.invaders.map(i => ({ x: round(i.x), y: round(i.y), a: i.alive })),
    // Current swarm animation frame (0 or 1). Authoritative — every
    // client renders the same pose at the same tick instead of each
    // running its own time-based ticker.
    iFrame:         state.invaderFrame,
  };
}

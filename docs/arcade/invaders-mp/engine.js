// Authoritative Invaders simulation shared by the server (bundled
// into the MP worker by wrangler) and the host-mode client (loaded
// as a <script type="module">). Pure functions only — no I/O, no
// globals. The caller drives time and supplies input bags.
//
// Logical units: 240 wide × 280 tall (the client scales the canvas).
// Origin is top-left. Down = +y.
//
// Types live in engine.d.ts as an ambient sibling declaration so
// room.ts gets full TypeScript type-checking against this file
// without an allowJs build flag.

// === Playfield ===
export const PF_W = 240;
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
const INV_COLS = 8;
export const INV_W = 12;
export const INV_H = 8;
const INV_GAP_X = 18;
const INV_GAP_Y = 14;
const INV_ORIGIN_X = 18;
const INV_ORIGIN_Y = 24;
const INV_DROP = 8;
// Continuous-march speed (u/s) shrinks as the swarm thins so the last
// few invaders sprint. The discrete-shuffle version of this used a
// step every ~0.55 s with a 2-unit jump (≈3.6 u/s).
const INV_SPEED_FULL = 3.6;
const INV_SPEED_MIN  = 20;
// Wall-bounce drop speed. 8 units at 64 u/s = 125 ms — a hop, not a
// teleport at the current tick rate.
const INV_DROP_SPEED = 64;
const INV_FIRE_INTERVAL = 1.4;

const SCORE_PER_KILL = 10;

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
  /** @type {Record<string, {x:number,alive:boolean,cooldown:number}>} */
  const ships = {};
  for (let i = 0; i < MAX_SEATS; i++) {
    ships[SEATS[i]] = { x: spawnX(i), alive: true, cooldown: 0 };
  }
  return ships;
}

export function initState() {
  return {
    status: 'waiting',
    won: false,
    score: 0,
    ships: freshShips(),
    bullets: [],
    invaderBullets: [],
    invaders: buildGrid(),
    invaderDir: 1,
    invaderDropRemaining: 0,
    invaderFireAccum: 0,
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
  stepShips(state, inputs, dt, occupied);
  stepBullets(state, dt);
  stepInvaders(state, dt);
  stepInvaderFire(state, dt);
  resolveCollisions(state, occupied);
  checkEnd(state, occupied);
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
  // a nested loop.
  for (const b of state.bullets) {
    if (b.y < -BULLET_H) continue;
    for (const inv of state.invaders) {
      if (!inv.alive) continue;
      if (overlap(b.x, b.y, BULLET_W, BULLET_H, inv.x, inv.y, INV_W, INV_H)) {
        inv.alive = false;
        b.y = -999;
        state.score += SCORE_PER_KILL;
        break;
      }
    }
  }
  state.bullets = state.bullets.filter(b => b.y > -BULLET_H);

  // Invader bullets vs ships. Unoccupied seats can't take damage.
  for (const b of state.invaderBullets) {
    for (const seat of SEATS) {
      const ship = state.ships[seat];
      if (!ship.alive || !occupied[seat]) continue;
      if (overlap(b.x, b.y, BULLET_W, BULLET_H, ship.x, SHIP_Y, SHIP_W, SHIP_H)) {
        ship.alive = false;
        b.y = PF_H + 999;
      }
    }
  }
  state.invaderBullets = state.invaderBullets.filter(b => b.y < PF_H);
}

function checkEnd(state, occupied) {
  // Loss: any invader at the ship row, or no playable ship remains.
  // "Playable" = alive AND occupied — so a solo death ends the game
  // even if other seats are empty-but-technically-alive.
  const breach = state.invaders.some(i => i.alive && i.y + INV_H >= SHIP_Y);
  const wipe = SEATS.every((s) => !(state.ships[s].alive && occupied[s]));
  if (breach || wipe) { state.status = 'gameover'; state.won = false; return; }

  // Win: every invader dead.
  if (!state.invaders.some(i => i.alive)) { state.status = 'gameover'; state.won = true; }
}

function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// === Snapshot for the wire ===

function round(n) { return Math.round(n * 10) / 10; }

export function snapshotForClient(state) {
  return {
    status: state.status,
    won: state.won,
    score: state.score,
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
    })),
    // `o` (owner) is the firing seat — lets the client filter "my
    // bullets" if it ever wants per-bullet prediction. Invader
    // bullets have no owner.
    bullets:        state.bullets.map(b => ({ x: round(b.x), y: round(b.y), o: b.owner })),
    invaderBullets: state.invaderBullets.map(b => ({ x: round(b.x), y: round(b.y) })),
    invaders:       state.invaders.map(i => ({ x: round(i.x), y: round(i.y), a: i.alive })),
  };
}

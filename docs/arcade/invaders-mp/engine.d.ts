// Types for engine.js, the single source of truth for game logic.
// TypeScript discovers this .d.ts automatically because it sits
// alongside engine.js. Keep these signatures in sync with the JS.

export type Seat = 'p1' | 'p2' | 'p3' | 'p4';
export type Status = 'waiting' | 'ready' | 'countdown' | 'running' | 'gameover';

export interface Input {
  left: boolean;
  right: boolean;
  fire: boolean;
}

export interface Ship {
  x: number;
  alive: boolean;
  cooldown: number;
  /** Per-player score (kills × ROW_POINTS[row] × combo multiplier). */
  score: number;
  /** Seconds until respawn; 0 = not respawning (either alive or permanent-dead). */
  respawnIn: number;
  /** Seconds of post-respawn invulnerability remaining; 0 = vulnerable. */
  invulnFor: number;
  /** Consecutive kills within the combo decay window. */
  combo: number;
  /** Seconds left before combo decays back to 0. */
  comboDecayIn: number;
  /** Charged-fire ammo remaining (0..SUPER_SHOT_MAX). */
  superAmmo: number;
  /** Accumulated FIRE-hold time in seconds; resets on release. */
  chargeSec: number;
  /** Previous tick's fire input — drives release-to-fire edge detection. */
  wasFiring: boolean;
  /** Score threshold for the next earned ammo refill. */
  nextSuperAt: number;
}

export interface Bullet {
  x: number;
  y: number;
  owner: Seat | null;
  /** True for super-shot bullets — pierces invaders, tunnels through shields. */
  charged?: boolean;
}

export interface Invader {
  x: number;
  y: number;
  alive: boolean;
}

export interface Popup {
  x: number;
  y: number;
  text: string;
  col: string;
  /** Seconds of life remaining; renderer fades by life/POPUP_LIFE_SEC. */
  life: number;
}

export interface Ufo {
  x: number;
  dir: 1 | -1;
}

export interface MarkedInvader {
  /** Index into state.invaders — the one currently swooping. */
  idx: number;
  /** Seconds remaining before snap-back to the grid slot. */
  untilSec: number;
  /** Live swoop offsets added to inv.x / inv.y (NOT absolute). */
  swoopDX: number;
  swoopDY: number;
}

export interface BossAdd {
  /** Resting position the minion swoops away from + returns to. */
  baseX: number;
  baseY: number;
  /** Live position. Computed each tick from baseX/baseY + phase. */
  x: number;
  y: number;
  alive: boolean;
  /** 0..1 swoop cycle position; advances by dt * phaseSpeed each tick. */
  phase: number;
  /** 1 / swoop-period (seconds). Randomised per minion at spawn. */
  phaseSpeed: number;
  /** Seconds until the minion respawns at base; 0 while alive. */
  respawnIn: number;
}

export interface Boss {
  /** Index into sprites.js BOSS_TYPES (0..BOSS_TYPE_COUNT-1). */
  type: number;
  x: number;
  /** Vertical position — descends slowly during the fight. */
  y: number;
  hp: number;
  hpMax: number;
  dir: 1 | -1;
  speed: number;
  /** PF/sec downward creep rate. Scales with set number. */
  descent: number;
  fireAccum: number;
  fireInterval: number;
  /** Swooping minion adds — 2 + (setNum-1) per boss. */
  adds: BossAdd[];
}

export interface GameState {
  status: Status;
  won: boolean;
  /** Shared respawn-pool counter (starts at STARTING_LIVES, decrements per death). */
  lives: number;
  ships: Record<Seat, Ship>;
  bullets: Bullet[];
  invaderBullets: Bullet[];
  invaders: Invader[];
  /** Flat shared shield bitmap; 1 = solid, 0 = chipped. Length = SHIELD_COUNT * SHIELD_W * SHIELD_H. */
  shields: Uint8Array;
  /** Stage label set (1, 2, 3, …). */
  stageSet: number;
  /** Stage label number within the set (1..STAGES_PER_SET; sentinel value above means boss wave). */
  stageNum: number;
  /** Seconds remaining of the "STAGE n-m" / "STAGE n-BOSS" overlay between waves. */
  stageAnnounceIn: number;
  /**
   * 'grid' during normal waves, 'boss' during a boss interrupt,
   * 'cutscene' between the final boss death and the gameover lobby.
   */
  phase: 'grid' | 'boss' | 'cutscene';
  /** Active boss entity while phase === 'boss'; null otherwise. */
  boss: Boss | null;
  /** Seconds left on the win cutscene; 0 outside phase === 'cutscene'. */
  cutsceneIn: number;
  /** Bonus UFO when on-screen; null when between spawns. */
  ufo: Ufo | null;
  /** Seconds until the next UFO spawns. */
  ufoNextSec: number;
  /** Live floating score popups; filtered to life > 0. */
  popups: Popup[];
  invaderDir: 1 | -1;
  invaderDropRemaining: number;
  invaderFireAccum: number;
  /** Current 0/1 sprite frame; advanced by horizontal distance travelled. */
  invaderFrame: 0 | 1;
  invaderFrameAccum: number;
  /** Per-seat display name; empty string = no label. */
  names: Record<Seat, string>;
  /** Server-clock ms; only meaningful while status === 'countdown'. */
  countdownEndMs: number;
  /** True after any B-press this match — disqualifies all per-player scores from the leaderboard. */
  cheated: boolean;
  /** Currently-swooping marked invader, or null. Reset between stages. */
  marked: MarkedInvader | null;
  /** Seconds until the next mark-spawn attempt while none is active. */
  markedSpawnIn: number;
}

export interface WireSnapshot {
  status: Status;
  won: boolean;
  /** Shared respawn pool. */
  lives: number;
  countdownEndMs: number;
  /** Always MAX_SEATS entries, indexed by seat position (p1 → 0, …). */
  players: Array<{
    x: number;
    alive: boolean;
    name: string;
    score: number;
    combo: number;
    superAmmo: number;
    chargeSec: number;
  }>;
  bullets: Array<{ x: number; y: number; o: Seat | null; c: boolean }>;
  invaderBullets: Array<{ x: number; y: number }>;
  invaders: Array<{ x: number; y: number; a: boolean }>;
  /** Authoritative swarm animation frame (0 or 1). */
  iFrame: 0 | 1;
  /** Packed shield bitmap (base64 of SHIELD_COUNT * SHIELD_W * SHIELD_H bits). */
  shieldsBits: string;
  /** Stage label set (1, 2, 3, …). */
  stageSet: number;
  /** Stage label number within the set (1..STAGES_PER_SET). */
  stageNum: number;
  /** Seconds remaining of the centred "STAGE n-m" announce overlay. */
  stageAnnounceIn: number;
  /** Bonus UFO when on-screen (x = left edge, d = travel direction); null between spawns. */
  ufo: { x: number; d: 1 | -1 } | null;
  /** Floating score popups; client renders + fades by `l` / POPUP_LIFE_SEC. */
  popups: Array<{ x: number; y: number; t: string; c: string; l: number }>;
  /**
   * 'grid' during normal waves, 'boss' during a boss interrupt,
   * 'cutscene' for the win celebration before status → 'gameover'.
   */
  phase: 'grid' | 'boss' | 'cutscene';
  /** Active boss for the renderer; null between bosses. `type` indexes sprites.js BOSS_TYPES, `adds` is the live minion positions, `y` descends during the fight. */
  boss: {
    x: number;
    y: number;
    hp: number;
    hpMax: number;
    type: number;
    adds: Array<{ x: number; y: number; a: boolean }>;
  } | null;
  /** Seconds left on the win cutscene; 0 outside phase === 'cutscene'. */
  cutsceneIn: number;
  /** True after any B-press this match — clients gate leaderboard submission on this. */
  cheated: boolean;
  /** Currently-swooping marked invader, or null. `i` indexes the invaders array; dx/dy are swoop offsets added to the invader's grid position. */
  marked: { i: number; dx: number; dy: number } | null;
  /**
   * Per-seat occupancy. Set by the transport layer (room.ts on the
   * server, hostTick on the client) after snapshotForClient returns,
   * NOT by the engine itself. Optional because mid-deploy a client
   * may briefly receive a pre-Phase-D snapshot without it — fall back
   * to `players[i].alive` in that case.
   */
  seats?: Record<Seat, boolean>;
}

export const PF_W: number;
export const PF_H: number;
export const SHIP_W: number;
export const SHIP_H: number;
export const SHIP_Y: number;
export const SHIP_SPEED: number;
export const FIRE_COOLDOWN: number;
export const BULLET_W: number;
export const BULLET_H: number;
export const BULLET_SPEED: number;
export const INV_W: number;
export const INV_H: number;
export const INV_COLS: number;
export const ROW_POINTS: readonly number[];
export const STARTING_LIVES: number;
export const SHIELD_W: number;
export const SHIELD_H: number;
export const SHIELD_COUNT: number;
export const SHIELD_Y: number;
export const SUPER_SHOT_MAX: number;
export const CHARGE_THRESHOLD_SEC: number;
export const CHARGED_BULLET_W: number;
export const CHARGED_BULLET_H: number;
export const CHARGED_BULLET_SPEED: number;
export const UFO_W_EXPORT: number;
export const UFO_H_EXPORT: number;
export const UFO_Y_EXPORT: number;
export const BOSS_W: number;
export const BOSS_H: number;
export const BOSS_Y: number;
export const BOSS_ADD_W: number;
export const BOSS_ADD_H: number;
export const BOSS_TYPE_COUNT: number;
export const CUTSCENE_SEC: number;
export function comboMultiplier(count: number): number;

export const SEATS: readonly Seat[];
export const MAX_SEATS: number;

export function zeroInput(): Input;
export function initState(): GameState;
export function step(
  state: GameState,
  inputs: Partial<Record<Seat, Input>>,
  dt: number,
  occupied?: Record<Seat, boolean>,
): void;
export function snapshotForClient(state: GameState): WireSnapshot;
export function encodeShields(bits: Uint8Array): string;
export function decodeShields(b64: string): Uint8Array;
export function shieldOffsets(): number[];
/** Debug skip — kill current grid (→ boss) or current boss (→ next set / cutscene). No-op outside 'running'. */
export function cheatSkip(state: GameState): void;

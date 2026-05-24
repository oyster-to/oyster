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
}

export interface WireSnapshot {
  status: Status;
  won: boolean;
  /** Sum of all per-player scores; convenience for HUD/team copy. */
  score: number;
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

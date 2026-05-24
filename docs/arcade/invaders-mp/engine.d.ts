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
  /** Per-player score (kills × ROW_POINTS[row]). */
  score: number;
  /** Seconds until respawn; 0 = not respawning (either alive or permanent-dead). */
  respawnIn: number;
  /** Seconds of post-respawn invulnerability remaining; 0 = vulnerable. */
  invulnFor: number;
}

export interface Bullet {
  x: number;
  y: number;
  owner: Seat | null;
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
  players: Array<{ x: number; alive: boolean; name: string; score: number }>;
  bullets: Array<{ x: number; y: number; o: Seat | null }>;
  invaderBullets: Array<{ x: number; y: number }>;
  invaders: Array<{ x: number; y: number; a: boolean }>;
  /** Authoritative swarm animation frame (0 or 1). */
  iFrame: 0 | 1;
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

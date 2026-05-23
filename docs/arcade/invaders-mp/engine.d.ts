// Types for engine.js, the single source of truth for game logic.
// TypeScript discovers this .d.ts automatically because it sits
// alongside engine.js. Keep these signatures in sync with the JS.

export type Seat = 'p1' | 'p2' | 'p3' | 'p4';
export type Status = 'waiting' | 'ready' | 'running' | 'gameover';

export interface Input {
  left: boolean;
  right: boolean;
  fire: boolean;
}

export interface Ship {
  x: number;
  alive: boolean;
  cooldown: number;
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
  score: number;
  ships: Record<Seat, Ship>;
  bullets: Bullet[];
  invaderBullets: Bullet[];
  invaders: Invader[];
  invaderDir: 1 | -1;
  invaderDropRemaining: number;
  invaderFireAccum: number;
}

export interface WireSnapshot {
  status: Status;
  won: boolean;
  score: number;
  /** Always MAX_SEATS entries, indexed by seat position (p1 → 0, …). */
  players: Array<{ x: number; alive: boolean }>;
  bullets: Array<{ x: number; y: number; o: Seat | null }>;
  invaderBullets: Array<{ x: number; y: number }>;
  invaders: Array<{ x: number; y: number; a: boolean }>;
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

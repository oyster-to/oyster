// InvadersRoom — a Durable Object that owns one Invaders match for
// one room code (e.g. /invaders-2p/FROG). First socket gets seat p1,
// second gets p2, third receives `room_full` and is closed.
//
// When at least one socket is present and someone sends `start`, an
// in-memory setInterval drives the simulation at TICK_HZ until
// gameover or every socket has closed. Plain server.accept() (not the
// Hibernation API): the loop + open sockets keep the isolate warm.
//
// In v17+ the DO also relays opaque WebRTC signalling between seats
// and acts as a cloud-relay fallback when host-mode P2P can't
// establish (e.g. captive-portal Wi-Fi, late joiner before retry).
// The game engine itself lives in docs/arcade/invaders-2p/engine.js
// and is shared verbatim with the host-mode client.

import { DurableObject } from 'cloudflare:workers';
import {
  initState,
  snapshotForClient,
  step,
  zeroInput,
} from '../../../docs/arcade/invaders-2p/engine.js';
import type {
  GameState,
  Input,
  Seat,
} from '../../../docs/arcade/invaders-2p/engine.js';
import type { Env } from './worker';

const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;

// Bumped on any wire/protocol or netcode-behaviour change. The client
// reads the welcome message's `netcode` field and flags a mismatch if
// its hard-coded constant differs — fastest way to confirm which build
// is live after a deploy.
//
//   v1   initial spike (no timestamps, no interp, no prediction)
//   v2   + serverTime + client interpolation buffer
//   v3   + solo start, mid-game P2 join, local-ship prediction, ghosts
//   v4   + 30 Hz tick + continuous invader march (no shuffle JOLT)
//   v5   + smooth local-ship reconciliation (no snap on direction change)
//   v6   + ping/pong RTT measurement
//   v7   + client-authoritative own-ship position (server stops integrating)
//   v8   removed predicted ghost bullets; pure server-snapshot bullets
//   v9   bullet predict + smooth + grace-fade (snapshot bullets carry `o`)
//   v10  dropped bullet smoothing; bumped MATCH_RADIUS 25 → 60
//   v11  reverted bullet prediction; back to v8 behaviour (steady delay)
//   v12  restored v7-style ghost bullets; 30 → 60 Hz tick
//   v13  welcome carries workerColo + doColo (probed via cdn-cgi/trace)
//   v14  tried locationHint 'apac' (→ SIN) — added second hop, reverted
//   v15  reverted to original singleton → MRS/CDG, BGP-bounded floor
//   v16  per-pair rooms via ?code=FROG; DO relays opaque signal messages
//   v17  WebRTC handshake via simple-peer using v16's signal relay;
//        URL path scheme moved to /invaders-2p/FROG; Press Start 2P font
//   v18  Host-mode gameplay over DataChannel: P1 runs the engine
//        locally, broadcasts snapshots via DC, P2 sends inputs over
//        DC. DO stays as signalling broker + cloud-relay fallback.
const NETCODE_VERSION = 18;

type ClientMessage =
  | { type: 'ping';   t: number }
  | { type: 'input';  left?: boolean; right?: boolean; fire?: boolean }
  | { type: 'pos';    x: number }
  | { type: 'start' }
  | { type: 'signal'; to: Seat; payload: unknown };

type Occupancy = Record<Seat, boolean>;

export class InvadersRoom extends DurableObject<Env> {
  private sockets = new Map<Seat, WebSocket>();
  private inputs: Record<Seat, Input> = { p1: zeroInput(), p2: zeroInput() };
  private game: GameState = initState();
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  // Cached probe of the DO's own colo — fetched from cdn-cgi/trace
  // once per isolate lifetime, then shipped in every welcome so the
  // client badge can show `worker → DO` routing.
  private doColo: string | null = null;

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    const seat = this.assignSeat();
    if (!seat) {
      server.accept();
      server.send(JSON.stringify({ type: 'room_full' }));
      server.close(1000, 'room_full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const doColo = await this.getDoColo();
    const workerColo = (req.cf as { colo?: string } | undefined)?.colo ?? '?';
    this.handleSession(server, seat, workerColo, doColo);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async getDoColo(): Promise<string> {
    if (this.doColo !== null) return this.doColo;
    // cdn-cgi/trace returns key=value text from the colo that
    // terminated the request — for a subrequest issued from inside a
    // DO that's the DO's own colo. Universally reachable inside CF.
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 1500);
      const r = await fetch('https://speed.cloudflare.com/cdn-cgi/trace', { signal: ac.signal });
      clearTimeout(to);
      if (!r.ok) { this.doColo = 'http' + r.status; return this.doColo; }
      const m = (await r.text()).match(/^colo=([A-Z]+)/m);
      this.doColo = m?.[1] ?? '?';
    } catch (e) {
      console.log('getDoColo error:', (e as Error).message);
      this.doColo = '?';
    }
    return this.doColo;
  }

  // --------------------------------------------------------------------
  // Seats / sessions

  private assignSeat(): Seat | null {
    if (!this.sockets.has('p1')) return 'p1';
    if (!this.sockets.has('p2')) return 'p2';
    return null;
  }

  private handleSession(ws: WebSocket, seat: Seat, workerColo: string, doColo: string): void {
    ws.accept();
    this.sockets.set(seat, ws);
    this.inputs[seat] = zeroInput();

    ws.send(JSON.stringify({
      type: 'welcome',
      seat,
      netcode: NETCODE_VERSION,
      workerColo,
      doColo,
    }));
    this.refreshLobbyStatus();
    this.broadcastSnapshot();

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      this.onMessage(seat, event.data);
    });
    ws.addEventListener('close', () => this.onClose(seat));
    ws.addEventListener('error', () => this.onClose(seat));
  }

  private onClose(seat: Seat): void {
    this.sockets.delete(seat);
    this.inputs[seat] = zeroInput();

    if (this.sockets.size === 0) {
      this.stopLoop();
      this.game = initState();
      return;
    }

    // Someone is still here. Don't end the game on disconnect — the
    // remaining player demotes to solo and the departed seat is
    // masked out (no damage, no wipe contribution) until refilled.
    this.refreshLobbyStatus();
    this.broadcastSnapshot();
  }

  // --------------------------------------------------------------------
  // Messages

  private onMessage(seat: Seat, raw: string): void {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; }
    catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'ping':
        this.handlePing(seat, msg);
        return;
      case 'input':
        this.inputs[seat] = {
          left:  !!msg.left,
          right: !!msg.right,
          fire:  !!msg.fire,
        };
        return;
      case 'pos':
        this.handlePos(seat, msg);
        return;
      case 'signal':
        this.relaySignal(seat, msg);
        return;
      case 'start':
        this.handleStart();
        return;
    }
  }

  private handlePing(seat: Seat, msg: { t: number }): void {
    if (typeof msg.t !== 'number') return;
    const sock = this.sockets.get(seat);
    if (!sock) return;
    try { sock.send(JSON.stringify({ type: 'pong', t: msg.t })); }
    catch { /* socket dying, will be cleaned up */ }
  }

  private handlePos(seat: Seat, msg: { x: number }): void {
    // Client-authoritative ship position — co-op spike, cheating is
    // not a concern. We trust whatever the browser reports (clamped
    // to playfield bounds). v7 stopped integrating movement from
    // input.left/right; this stream is the only thing moving the
    // ship server-side.
    if (typeof msg.x !== 'number' || !Number.isFinite(msg.x)) return;
    const ship = this.game.ships[seat];
    if (!ship.alive) return;
    const max = 240 - 16; // PF_W - SHIP_W (avoids a tiny engine import)
    ship.x = Math.max(0, Math.min(max, msg.x));
  }

  private relaySignal(sender: Seat, msg: { to: Seat; payload: unknown }): void {
    // Opaque relay for WebRTC handshake (SDP offer/answer, ICE
    // candidates). DO doesn't interpret the payload — it just
    // forwards from one seat to the other so neither client needs
    // a direct route until the DataChannel is up.
    if (msg.to !== 'p1' && msg.to !== 'p2') return;
    if (msg.to === sender) return; // no self-signalling
    const targetWs = this.sockets.get(msg.to);
    if (!targetWs) return;
    try {
      targetWs.send(JSON.stringify({
        type: 'signal',
        from: sender,
        payload: msg.payload,
      }));
    } catch { /* target socket dying, will be cleaned up */ }
  }

  private handleStart(): void {
    // Solo start allowed: any pre-game state with at least one player.
    // The other seat can join mid-game; its ship is masked as
    // not-alive on the wire and doesn't take damage until occupied.
    const s = this.game.status;
    if (s !== 'ready' && s !== 'waiting' && s !== 'gameover') return;
    if (this.sockets.size < 1) return;
    this.game = initState();
    this.game.status = 'running';
    this.startLoop();
    this.broadcastSnapshot();
  }

  // --------------------------------------------------------------------
  // Lobby status

  private refreshLobbyStatus(): void {
    // Only touch pre-game / post-game state. Don't yank a running
    // match into 'waiting' just because we re-evaluated.
    if (this.game.status === 'running') return;
    // 'ready' = at least one player present, can press START. The
    // client decides whether to label it solo ("P2 can join later")
    // or duo ("Both players in").
    this.game.status = this.sockets.size >= 1 ? 'ready' : 'waiting';
  }

  // --------------------------------------------------------------------
  // Loop

  private startLoop(): void {
    if (this.loop) return;
    this.lastTickMs = Date.now();
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private tick(): void {
    const now = Date.now();
    // Real-time delta so a slow scheduler doesn't fast-forward the
    // simulation when the next tick fires late. Cap at 100 ms to keep
    // collisions sane after a long stall.
    const dt = Math.min(0.1, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;

    step(this.game, this.inputs, dt, this.occupancy());
    this.broadcastSnapshot();
    if (this.game.status === 'gameover') this.stopLoop();
  }

  private occupancy(): Occupancy {
    return { p1: this.sockets.has('p1'), p2: this.sockets.has('p2') };
  }

  // --------------------------------------------------------------------
  // Broadcast

  private broadcastSnapshot(): void {
    // `t` is the server wall clock at broadcast time. The client
    // tracks it as the snapshot's timestamp and renders ~100 ms behind
    // the latest one, lerping entity positions between bracketing
    // snapshots (the Valve "interp" buffer — absorbs tick cadence
    // and network jitter without protocol or tick-rate changes).
    const snap = snapshotForClient(this.game);
    // Mask unoccupied seats as not-alive on the wire so the client
    // doesn't paint a sitting-duck ghost while waiting for the other
    // player. The server-side ship stays alive in the simulation; it
    // just can't take damage or contribute to the wipe check.
    if (!this.sockets.has('p1')) snap.players[0].alive = false;
    if (!this.sockets.has('p2')) snap.players[1].alive = false;
    const msg = JSON.stringify({ type: 'state', t: Date.now(), ...snap });
    for (const ws of this.sockets.values()) {
      try { ws.send(msg); }
      catch { /* socket dying; close handler will clean up */ }
    }
  }
}

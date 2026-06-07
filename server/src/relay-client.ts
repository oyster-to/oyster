// relay-client.ts — the device half of the device relay (spec
// docs/superpowers/specs/2026-06-07-device-relay-design.md).
//
// When the cloud-sync gate passes (Pro + profile binding), this client
// dials an OUTBOUND WebSocket to the cloud worker's per-user RelayDO
// (infra/oyster-cloud/src/relay-do.ts) and serves allowlisted read-only
// requests from the cloud remote view by loopback-fetching its own HTTP
// server. NAT traversal comes free from the dial-out direction.
//
// This table is the AUTHORITATIVE allowlist — the worker and DO enforce a
// copy of it cloud-side (infra/oyster-cloud/src/relay-allowlist.ts), but a
// compromised or buggy worker must not be able to turn this socket into a
// generic proxy: nothing leaves this machine unless the (method, path)
// matches here. Keep the two tables in sync deliberately; drift fails
// closed (whichever side is narrower wins).

import WebSocket from "ws";
import type Database from "better-sqlite3";
import { createOfflineLogger } from "./sync-log.js";

/** Wire protocol version — must match RELAY_PROTO in the cloud worker. */
export const RELAY_PROTO = 1;

/** v1: read-only. GET only, no request bodies. Mirrors (and is mirrored
 *  by) infra/oyster-cloud/src/relay-allowlist.ts. */
export const RELAY_ROUTES: ReadonlyArray<string> = [
  "/api/sessions",
  "/api/sessions/search",
  "/api/sessions/:id",
  // The registry mirror deliberately does NOT sync artefact file URLs —
  // the cloud client asks the live device for them before opening
  // anything via /artifacts/*. The one list-shaped route, for that reason.
  "/api/artifacts",
  "/artifacts/*",
];

const MAX_PATH_CHARS = 2048;
/** ≤256 KB raw per res_chunk (~342 KB base64) — well under the Workers
 *  runtime's 1 MiB WebSocket message cap. */
const CHUNK_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// Close codes from the RelayDO — see infra/oyster-cloud/src/relay-do.ts.
const CLOSE_SUPERSEDED = 4000;
const CLOSE_SESSION_REVOKED = 4401;
const CLOSE_RELAY_DISABLED = 4403;
const CLOSE_BAD_PROTO = 1002;

interface SyncUser { id: string; email: string; tier: string }

export interface RelayClientDeps {
  db: Database.Database;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  /** The cloud-sync gate (canRunCloudSync in index.ts): Pro tier + profile
   *  binding. The relay never connects when this fails. */
  canRun: () => boolean;
  /** e.g. https://cloud.oyster.to — rewritten to wss:// for the dial. */
  workerBase: string;
  /** The local HTTP server's bound port. Returns null until listen() —
   *  refresh() stays disconnected until it's known. */
  localPort: () => number | null;
  /** Loopback fetch — injectable so tests can fake the local server. */
  fetch: typeof fetch;
  /** Timing knobs (test seams; production uses the defaults). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
}

export interface RelayClient {
  /** Re-evaluate the gate and connect/disconnect to match. Call on auth
   *  change, startup, and once the HTTP port is bound. */
  refresh(): void;
  /** Disconnect and stop reconnecting (shutdown/tests). */
  stop(): void;
  status(): { connected: boolean };
}

/** Match a relayed path against RELAY_ROUTES. Same semantics as the
 *  cloud-side matcher: percent-decode repeatedly until stable (catches
 *  double-encoding), reject dot/empty segments + backslashes + NULs at
 *  every stage, match on pathname only, query rides through untouched.
 *  Exported for tests. */
export function matchRelayPath(method: string, pathWithQuery: string): string | null {
  if (method !== "GET") return null;
  if (typeof pathWithQuery !== "string" || pathWithQuery.length === 0) return null;
  if (pathWithQuery.length > MAX_PATH_CHARS) return null;

  const qIdx = pathWithQuery.indexOf("?");
  let decoded = qIdx === -1 ? pathWithQuery : pathWithQuery.slice(0, qIdx);
  if (!decoded.startsWith("/")) return null;

  for (let i = 0; i < 3; i++) {
    if (!segmentsSane(decoded)) return null;
    let next: string;
    try { next = decodeURIComponent(decoded); }
    catch { return null; }
    if (next === decoded) break;
    decoded = next;
    if (i === 2) {
      // Still decodable after three rounds — suspiciously deep nesting.
      try { if (decodeURIComponent(decoded) !== decoded) return null; }
      catch { return null; }
    }
  }
  if (!segmentsSane(decoded)) return null;

  const segs = decoded.split("/").slice(1);
  for (const pattern of RELAY_ROUTES) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (decoded.startsWith(prefix) && decoded.length > prefix.length) return pattern;
      continue;
    }
    const pSegs = pattern.split("/").slice(1);
    if (pSegs.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      const p = pSegs[i];
      const s = segs[i];
      if (p === undefined || s === undefined) { ok = false; break; }
      if (p.startsWith(":")) { if (s.length === 0) { ok = false; break; } }
      else if (p !== s) { ok = false; break; }
    }
    if (ok) return pattern;
  }
  return null;
}

function segmentsSane(path: string): boolean {
  if (path.includes("\0") || path.includes("\\")) return false;
  const segs = path.split("/");
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (s === "" || s === "." || s === "..") return false;
  }
  return true;
}

export function createRelayClient(deps: RelayClientDeps): RelayClient {
  const backoffBaseMs = deps.backoffBaseMs ?? 1_000;
  const backoffMaxMs = deps.backoffMaxMs ?? 60_000;
  const pingIntervalMs = deps.pingIntervalMs ?? 30_000;
  const logger = createOfflineLogger("[relay] connect");

  let ws: WebSocket | null = null;
  let stopped = false;
  /** Set on close codes that mean "don't reconnect until something
   *  changes" (revoked / superseded / proto mismatch). Cleared by
   *  refresh(), which fires on every auth change. */
  let parked = false;
  let attempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let lastPongAt = 0;

  function deviceIdentity(): { deviceId: string; label: string } | null {
    try {
      const row = deps.db.prepare(
        `SELECT device_id, label FROM device_identity WHERE id = 1`,
      ).get() as { device_id: string; label: string } | undefined;
      return row ? { deviceId: row.device_id, label: row.label } : null;
    } catch {
      return null;
    }
  }

  function gatePasses(): boolean {
    if (stopped || parked) return false;
    if ((process.env.OYSTER_RELAY ?? "").toLowerCase() === "off") return false;
    if (deps.localPort() === null) return false;
    if (!deps.sessionToken()) return false;
    return deps.canRun();
  }

  function clearTimers(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function disconnect(): void {
    clearTimers();
    if (ws) {
      try { ws.terminate(); } catch { /* already dead */ }
      ws = null;
    }
  }

  function scheduleReconnect(delayMs?: number): void {
    if (stopped || parked || reconnectTimer) return;
    attempts++;
    const backoff = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(attempts, 6));
    const jittered = delayMs ?? backoff * (0.7 + Math.random() * 0.6);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (gatePasses()) connect();
    }, jittered);
    reconnectTimer.unref?.();
  }

  function connect(): void {
    if (ws || stopped) return;
    const token = deps.sessionToken();
    const identity = deviceIdentity();
    if (!token || !identity) return;

    const wsBase = deps.workerBase.replace(/^http/, "ws");
    const url = `${wsBase}/api/relay/connect` +
      `?device_id=${encodeURIComponent(identity.deviceId)}` +
      `&device_label=${encodeURIComponent(identity.label)}`;
    const socket = new WebSocket(url, {
      headers: { Cookie: `oyster_session=${token}` },
    });
    ws = socket;

    socket.on("open", () => {
      attempts = 0;
      lastPongAt = Date.now();
      logger.success();
      console.log("[relay] connected — live remote view available for this device");
      socket.send(JSON.stringify({
        type: "hello",
        proto: RELAY_PROTO,
        device_id: identity.deviceId,
        device_label: identity.label,
        routes: RELAY_ROUTES,
      }));
      pingTimer = setInterval(() => {
        // Text-frame ping: answered by the DO's auto-response without
        // waking it. A protocol-level ws.ping() can't promise that.
        if (Date.now() - lastPongAt > pingIntervalMs * 2.5) {
          console.warn("[relay] keepalive lapsed — reconnecting");
          try { socket.terminate(); } catch { /* dying */ }
          return;
        }
        try { socket.send('{"type":"ping"}'); } catch { /* dying */ }
      }, pingIntervalMs);
      pingTimer.unref?.();
    });

    socket.on("message", (data) => {
      void handleFrame(socket, data.toString());
    });

    socket.on("close", (code) => {
      if (ws === socket) { ws = null; }
      clearTimers();
      if (stopped) return;
      if (code === CLOSE_SESSION_REVOKED) {
        console.warn("[relay] device session revoked — relay parked until next sign-in");
        parked = true;
        return;
      }
      if (code === CLOSE_SUPERSEDED) {
        // Another connection claimed this device_id. The lockfile makes a
        // second server on this machine impossible, so this is either our
        // own stale socket being replaced (harmless — the new one is us)
        // or something genuinely odd. Park and let refresh() re-evaluate.
        console.warn("[relay] connection superseded — parked pending refresh");
        parked = true;
        return;
      }
      if (code === CLOSE_BAD_PROTO) {
        console.warn("[relay] protocol version rejected by cloud — update Oyster to re-enable the relay");
        parked = true;
        return;
      }
      if (code === CLOSE_RELAY_DISABLED) {
        // Disabled from the cloud UI. Retry slowly so a re-enable is
        // picked up within ~10 min without hammering the worker.
        scheduleReconnect(10 * 60_000);
        return;
      }
      scheduleReconnect();
    });

    socket.on("unexpected-response", (_req, res) => {
      // Non-101 handshake: 403 relay_disabled / pro lapse, 404 old worker,
      // 5xx. All retried slowly; refresh() short-circuits on auth change.
      console.warn(`[relay] connect rejected (${res.statusCode ?? "?"}) — retrying later`);
      if (ws === socket) ws = null;
      try { socket.terminate(); } catch { /* dying */ }
      scheduleReconnect(10 * 60_000);
    });

    socket.on("error", (err) => {
      logger.failure(err);
      // "close" follows and schedules the reconnect.
    });
  }

  async function handleFrame(socket: WebSocket, raw: string): Promise<void> {
    let frame: { type?: string; id?: string; method?: string; path?: string };
    try { frame = JSON.parse(raw) as typeof frame; }
    catch { return; }
    if (frame.type === "pong") { lastPongAt = Date.now(); return; }
    if (frame.type !== "req") return;
    const { id, method, path } = frame;
    if (typeof id !== "string" || typeof method !== "string" || typeof path !== "string") return;

    const send = (obj: Record<string, unknown>): void => {
      try { socket.send(JSON.stringify(obj)); } catch { /* socket dying */ }
    };

    // THE authoritative check. The cloud already vetted this path twice;
    // if it still doesn't match here, the tables drifted or the worker is
    // compromised — refuse and say so loudly.
    if (matchRelayPath(method, path) === null) {
      console.warn(`[relay] refused non-allowlisted request: ${method} ${path}`);
      send({ type: "res_err", id, code: "not_allowed" });
      return;
    }

    const port = deps.localPort();
    if (port === null) {
      send({ type: "res_err", id, code: "fetch_failed" });
      return;
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await deps.fetch(`http://127.0.0.1:${port}${path}`, { method: "GET" });
    } catch (err) {
      console.warn(`[relay] loopback fetch failed for ${path}:`, err);
      send({ type: "res_err", id, code: "fetch_failed" });
      return;
    }

    send({
      type: "res_start",
      id,
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
    });

    let sentBytes = 0;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        let buffer = Buffer.alloc(0);
        const flush = (final: boolean): boolean => {
          while (buffer.byteLength >= CHUNK_BYTES || (final && buffer.byteLength > 0)) {
            const slice = buffer.subarray(0, CHUNK_BYTES);
            buffer = buffer.subarray(slice.byteLength);
            sentBytes += slice.byteLength;
            if (sentBytes > MAX_RESPONSE_BYTES) return false;
            send({ type: "res_chunk", id, body_b64: Buffer.from(slice).toString("base64") });
          }
          return true;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          if (sentBytes + buffer.byteLength > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => { /* best effort */ });
            send({ type: "res_err", id, code: "too_large" });
            console.warn(`[relay] GET ${path} exceeded ${MAX_RESPONSE_BYTES} bytes — aborted`);
            return;
          }
          if (!flush(false)) break;
        }
        flush(true);
      }
    } catch (err) {
      console.warn(`[relay] response stream failed for ${path}:`, err);
      send({ type: "res_err", id, code: "fetch_failed" });
      return;
    }

    send({ type: "res_end", id });
    console.log(`[relay] GET ${path} ${res.status} ${sentBytes}b ${Date.now() - startedAt}ms`);
  }

  return {
    refresh(): void {
      parked = false;
      if (gatePasses()) {
        if (!ws) { attempts = 0; connect(); }
      } else {
        disconnect();
      }
    },
    stop(): void {
      stopped = true;
      disconnect();
    },
    status(): { connected: boolean } {
      return { connected: ws !== null && ws.readyState === WebSocket.OPEN };
    },
  };
}

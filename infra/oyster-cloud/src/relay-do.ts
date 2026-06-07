// RelayDO — per-user rendezvous for the device relay (spec
// 2026-06-07-device-relay-design). One instance per user via
// idFromName(userId), so cross-user access is structurally impossible:
// a browser request can only ever reach the DO selected by its own
// resolved session.
//
// Each signed-in device holds one outbound WebSocket here, accepted via
// the Hibernation API (sockets survive isolate eviction; idle cost ~zero;
// device pings are answered by setWebSocketAutoResponse without a wake).
// Browser-side requests arrive over stub.fetch from the worker — never
// directly from the internet — and are framed onto the owning device's
// socket as `{type:"req", id, method, path}`; the device streams back
// res_start / res_chunk (base64) / res_end, which this class re-assembles
// into a streaming Response.
//
// In-memory state (pending requests, rate counters) is lost on
// hibernation/eviction. That's fine: an active forward keeps the isolate
// awake for its lifetime, and a counter reset under-counts in the
// device's favour, never the attacker's... strictly it resets the limit,
// which is acceptable for a per-user-own-device surface.

import type { Env } from "./session.js";
import { jsonOk, jsonError } from "./json.js";
import { matchRelayPath, RELAY_PROTO } from "./relay-allowlist.js";

const REVALIDATE_AFTER_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT_PER_DEVICE = 20;
const RATE_LIMIT_PER_MIN = 100;
// Chunks are ≤256 KB raw (~342 KB base64) per the protocol; cap frames
// well above that but far below Workers' 1 MiB WS message limit.
const MAX_WS_MESSAGE_CHARS = 600_000;
const DEVICE_LABEL_MAX = 64;
const MAX_ADVERTISED_ROUTES = 32;

// Close codes (4xxx = application-defined). The relay client switches on
// these to decide whether to reconnect.
const CLOSE_SUPERSEDED = 4000;      // newer connect from the same device_id
const CLOSE_SESSION_REVOKED = 4401; // device session no longer valid — re-sign-in
const CLOSE_RELAY_DISABLED = 4403;  // user disabled relay for this device

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Attachment = {
  deviceId: string;
  deviceLabel: string | null;
  sessionToken: string;
  connectedAt: number;
  validatedAt: number;
  /** null until the hello frame lands; no requests are forwarded before it. */
  proto: number | null;
  routes: string[] | null;
};

type DisabledRecord = { deviceLabel: string | null; disabledAt: number };

type PendingRequest = {
  deviceId: string;
  timeout: ReturnType<typeof setTimeout>;
  bytesReceived: number;
  /** True once res_start resolved the fetch with a streaming Response. */
  started: boolean;
  resolve: (res: Response) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
};

export class RelayDO {
  private pending = new Map<string, PendingRequest>();
  private rate = new Map<string, { windowStart: number; count: number }>();

  constructor(private state: DurableObjectState, private env: Env) {
    // Device keepalives answered without waking a hibernated isolate.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  // Test seam: production never sets this binding, so the default stands.
  private requestTimeoutMs(): number {
    const raw = (this.env as unknown as Record<string, unknown>).RELAY_REQUEST_TIMEOUT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 30_000;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/connect") return this.handleConnect(req, url);
    if (url.pathname === "/status" && req.method === "GET") return this.handleStatus();
    if (url.pathname === "/forward" && req.method === "GET") return this.handleForward(req);
    if (url.pathname === "/disable" && req.method === "POST") return this.handleDisable(req);
    if (url.pathname === "/enable" && req.method === "POST") return this.handleEnable(req);
    return jsonError(404, "not_found");
  }

  // ── Connect ──────────────────────────────────────────────────────────

  private async handleConnect(req: Request, url: URL): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return jsonError(426, "expected_websocket");
    }
    const deviceId = url.searchParams.get("device_id") ?? "";
    if (!UUID_RE.test(deviceId)) return jsonError(400, "invalid_device_id");
    let deviceLabel: string | null = url.searchParams.get("device_label");
    if (deviceLabel !== null && deviceLabel.length > DEVICE_LABEL_MAX) deviceLabel = null;
    // Set by the worker after resolveSession — requests can't reach this
    // DO except through the worker stub, so the header is trustworthy.
    const sessionToken = req.headers.get("x-relay-session-token");
    if (!sessionToken) return jsonError(401, "sign_in_required");

    const disabled = await this.state.storage.get<DisabledRecord>(`disabled:${deviceId}`);
    if (disabled) return jsonError(403, "relay_disabled");

    // Newest wins — matches the single-instance lockfile reality (one
    // server per machine); a superseded socket is a stale reconnect.
    for (const old of this.state.getWebSockets(deviceId)) {
      try { old.close(CLOSE_SUPERSEDED, "superseded"); } catch { /* already dying */ }
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server, [deviceId]);
    const att: Attachment = {
      deviceId,
      deviceLabel,
      sessionToken,
      connectedAt: Date.now(),
      validatedAt: Date.now(),
      proto: null,
      routes: null,
    };
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ── Status / disable / enable ────────────────────────────────────────

  private async handleStatus(): Promise<Response> {
    const online = this.state.getWebSockets()
      .filter((ws) => ws.readyState === 1) // skip sockets mid-close
      .map((ws) => {
        const att = ws.deserializeAttachment() as Attachment;
        return {
          device_id: att.deviceId,
          device_label: att.deviceLabel,
          connected_at: att.connectedAt,
          // Pre-hello sockets are visible but not yet forwardable.
          ready: att.routes !== null,
        };
      });
    const disabledMap = await this.state.storage.list<DisabledRecord>({ prefix: "disabled:" });
    const disabled = [...disabledMap.entries()].map(([key, rec]) => ({
      device_id: key.slice("disabled:".length),
      device_label: rec.deviceLabel,
      disabled_at: rec.disabledAt,
    }));
    return jsonOk({ online, disabled }, 200, { "cache-control": "private, no-store" });
  }

  private async handleDisable(req: Request): Promise<Response> {
    const deviceId = req.headers.get("x-relay-device-id") ?? "";
    if (!UUID_RE.test(deviceId)) return jsonError(400, "invalid_device_id");
    let deviceLabel: string | null = null;
    for (const ws of this.state.getWebSockets(deviceId)) {
      const att = ws.deserializeAttachment() as Attachment;
      deviceLabel = att.deviceLabel;
      try { ws.close(CLOSE_RELAY_DISABLED, "relay_disabled"); } catch { /* dying */ }
    }
    await this.state.storage.put<DisabledRecord>(`disabled:${deviceId}`, {
      deviceLabel,
      disabledAt: Date.now(),
    });
    return jsonOk({ ok: true, device_id: deviceId });
  }

  private async handleEnable(req: Request): Promise<Response> {
    const deviceId = req.headers.get("x-relay-device-id") ?? "";
    if (!UUID_RE.test(deviceId)) return jsonError(400, "invalid_device_id");
    await this.state.storage.delete(`disabled:${deviceId}`);
    return jsonOk({ ok: true, device_id: deviceId });
  }

  // ── Forward ──────────────────────────────────────────────────────────

  private async handleForward(req: Request): Promise<Response> {
    const deviceId = req.headers.get("x-relay-device-id") ?? "";
    const path = req.headers.get("x-relay-path") ?? "";
    if (!UUID_RE.test(deviceId)) return jsonError(400, "invalid_device_id");

    // Second enforcement of the allowlist (worker already checked) —
    // belt-and-braces is the point: a worker dispatch bug must not turn
    // this into a generic proxy.
    const pattern = matchRelayPath("GET", path);
    if (pattern === null) return jsonError(403, "path_not_allowed");

    // Pick the newest OPEN socket for this device. A superseded or
    // just-disabled socket can linger in getWebSockets() until its close
    // handshake completes — readyState 1 (OPEN) filters it out.
    let ws: WebSocket | null = null;
    let att: Attachment | null = null;
    for (const cand of this.state.getWebSockets(deviceId)) {
      if (cand.readyState !== 1) continue;
      const candAtt = cand.deserializeAttachment() as Attachment;
      if (!att || candAtt.connectedAt > att.connectedAt) { ws = cand; att = candAtt; }
    }
    if (!ws || !att) return jsonError(502, "relay_device_offline");
    if (att.routes === null) return jsonError(502, "relay_device_offline"); // no hello yet
    if (!att.routes.includes(pattern)) return jsonError(502, "relay_route_unsupported");

    // Revalidate the device's session at most every 5 minutes — this is
    // where revocation bites a long-lived socket. No alarms: an idle
    // revoked socket dies on the next request aimed at it, which is the
    // only moment it matters.
    if (Date.now() - att.validatedAt > REVALIDATE_AFTER_MS) {
      const alive = await this.sessionStillValid(att.sessionToken);
      if (!alive) {
        try { ws.close(CLOSE_SESSION_REVOKED, "session_revoked"); } catch { /* dying */ }
        return jsonError(502, "relay_device_offline");
      }
      att.validatedAt = Date.now();
      ws.serializeAttachment(att);
    }

    // Per-device limits. Concurrency from the live pending map; the
    // per-minute window from an in-memory counter.
    let inFlight = 0;
    for (const p of this.pending.values()) if (p.deviceId === deviceId) inFlight++;
    if (inFlight >= MAX_CONCURRENT_PER_DEVICE) return jsonError(429, "relay_busy");
    const now = Date.now();
    const window = this.rate.get(deviceId);
    if (!window || now - window.windowStart > 60_000) {
      this.rate.set(deviceId, { windowStart: now, count: 1 });
    } else if (window.count >= RATE_LIMIT_PER_MIN) {
      return jsonError(429, "relay_rate_limited");
    } else {
      window.count++;
    }

    const id = crypto.randomUUID();
    return await new Promise<Response>((resolve) => {
      const entry: PendingRequest = {
        deviceId,
        bytesReceived: 0,
        started: false,
        resolve,
        controller: null,
        timeout: setTimeout(() => this.failPending(id, 504, "relay_timeout"), this.requestTimeoutMs()),
      };
      this.pending.set(id, entry);
      try {
        ws.send(JSON.stringify({ type: "req", id, method: "GET", path }));
      } catch {
        this.failPending(id, 502, "relay_device_offline");
      }
    });
  }

  private failPending(id: string, status: number, code: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timeout);
    if (!entry.started) {
      entry.resolve(jsonError(status, code));
    } else if (entry.controller) {
      // Headers are gone; the best we can do is kill the stream so the
      // browser sees a network error rather than a silently-truncated body.
      try { entry.controller.error(new Error(code)); } catch { /* closed */ }
    }
  }

  private async sessionStillValid(token: string): Promise<boolean> {
    try {
      const row = await this.env.DB.prepare(
        `SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
      ).bind(token, Date.now()).first();
      return row !== null;
    } catch (err) {
      // D1 hiccup: fail OPEN for an already-authenticated socket — the
      // worker re-auths the browser side per request regardless, and
      // failing closed would turn a transient DB error into a device
      // disconnect storm.
      console.warn("[relay] session revalidation db error:", err);
      return true;
    }
  }

  // ── Device frames (Hibernation API handlers) ─────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      try { ws.close(1003, "unsupported data"); } catch { /* dying */ }
      return;
    }
    if (message.length > MAX_WS_MESSAGE_CHARS) {
      try { ws.close(1009, "message too big"); } catch { /* dying */ }
      return;
    }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(message) as Record<string, unknown>; }
    catch { return; }
    if (!frame || typeof frame !== "object") return;

    if (frame.type === "hello") {
      this.handleHello(ws, frame);
      return;
    }

    if (
      frame.type === "res_start" || frame.type === "res_chunk" ||
      frame.type === "res_end" || frame.type === "res_err"
    ) {
      const id = frame.id;
      if (typeof id !== "string") return;
      const entry = this.pending.get(id);
      if (!entry) return; // timed out / cancelled — late frames are dropped
      // A device may only answer its own requests. The id is an
      // unguessable UUID, but check anyway: frames from socket A must
      // never complete a request framed onto socket B.
      const att = ws.deserializeAttachment() as Attachment;
      if (att.deviceId !== entry.deviceId) return;

      if (frame.type === "res_start") this.handleResStart(id, entry, frame);
      else if (frame.type === "res_chunk") this.handleResChunk(id, entry, frame);
      else if (frame.type === "res_end") this.handleResEnd(id, entry);
      else this.handleResErr(id, entry, frame);
    }
  }

  private handleHello(ws: WebSocket, frame: Record<string, unknown>): void {
    if (frame.proto !== RELAY_PROTO) {
      try { ws.close(1002, "unsupported proto"); } catch { /* dying */ }
      return;
    }
    const rawRoutes = frame.routes;
    if (!Array.isArray(rawRoutes) || rawRoutes.length > MAX_ADVERTISED_ROUTES) return;
    const routes: string[] = [];
    for (const r of rawRoutes) {
      if (typeof r !== "string" || r.length === 0 || r.length > 128) return;
      routes.push(r);
    }
    const att = ws.deserializeAttachment() as Attachment;
    att.proto = RELAY_PROTO;
    att.routes = routes;
    ws.serializeAttachment(att);
  }

  private handleResStart(id: string, entry: PendingRequest, frame: Record<string, unknown>): void {
    if (entry.started) return; // duplicate res_start — ignore
    const status = frame.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      this.failPending(id, 502, "relay_bad_frame");
      return;
    }
    entry.started = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => { entry.controller = controller; },
      cancel: () => {
        // Browser went away mid-stream. Drop the pending entry; further
        // device frames for this id are ignored. (No cancel frame to the
        // device in proto 1 — it finishes the read into the void.)
        const e = this.pending.get(id);
        if (e) { clearTimeout(e.timeout); this.pending.delete(id); }
      },
    });
    entry.resolve(new Response(stream, {
      status,
      headers: filterRelayedHeaders(frame.headers),
    }));
  }

  private handleResChunk(id: string, entry: PendingRequest, frame: Record<string, unknown>): void {
    if (!entry.started || !entry.controller) {
      this.failPending(id, 502, "relay_bad_frame"); // chunk before start
      return;
    }
    const b64 = frame.body_b64;
    if (typeof b64 !== "string") return;
    const bytes = b64ToBytes(b64);
    if (bytes === null) { this.failPending(id, 502, "relay_bad_frame"); return; }
    entry.bytesReceived += bytes.byteLength;
    if (entry.bytesReceived > MAX_RESPONSE_BYTES) {
      this.failPending(id, 413, "relay_too_large");
      return;
    }
    try { entry.controller.enqueue(bytes); }
    catch { this.failPending(id, 502, "relay_bad_frame"); }
  }

  private handleResEnd(id: string, entry: PendingRequest): void {
    this.pending.delete(id);
    clearTimeout(entry.timeout);
    if (entry.started && entry.controller) {
      try { entry.controller.close(); } catch { /* already closed */ }
    } else {
      // res_end without res_start — treat as an empty error.
      entry.resolve(jsonError(502, "relay_bad_frame"));
    }
  }

  private handleResErr(id: string, entry: PendingRequest, frame: Record<string, unknown>): void {
    const code = typeof frame.code === "string" ? frame.code : "relay_device_error";
    // not_allowed from the device means the two allowlist tables drifted
    // (device narrower — by design it wins); surface as 502, not 403, so
    // the UI treats it like any other "can't reach it live" case.
    const status = code === "too_large" ? 413 : 502;
    this.failPending(id, status, code === "not_allowed" ? "relay_route_mismatch" : code);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.deviceId === att.deviceId) this.failPending(id, 502, "relay_device_offline");
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

// Response headers are device-controlled input. Pass through only what the
// viewer needs; everything else is dropped. The CSP sandbox is the
// important one: relayed artefact HTML rendered under app.oyster.to must
// NOT run with that origin's authority (the auth cookie lives there) —
// sandbox forces an opaque origin, so scripts/fetch can't reach /api/*
// as the user. share.oyster.to solves the same problem with a separate
// hostname; the relay solves it with a header.
function filterRelayedHeaders(raw: unknown): Headers {
  const out = new Headers();
  if (raw && typeof raw === "object") {
    // Case-insensitive lookup — the device serialises whatever casing its
    // local HTTP stack produced ("Content-Type" is as likely as not).
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key.toLowerCase() !== "content-type") continue;
      if (typeof value === "string" && value.length <= 256) out.set("content-type", value);
      break;
    }
  }
  out.set("cache-control", "private, no-store");
  out.set("x-content-type-options", "nosniff");
  out.set("content-security-policy", "sandbox");
  return out;
}

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// relay-client tests (spec 2026-06-07-device-relay-design). The mock ws
// server plays the cloud RelayDO; the injected fetch plays the local HTTP
// server. The two assertions that matter most:
//   1. the device-side allowlist is AUTHORITATIVE — a frame for a
//      non-allowlisted path never reaches fetch, even though "the cloud"
//      (our mock) happily sent it;
//   2. close-code discipline — 4401 parks, network errors reconnect.

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { createRelayClient, matchRelayPath, RELAY_ROUTES, type RelayClient } from "../src/relay-client.js";

const DEVICE_ID = "0f0e0d0c-0b0a-4998-8776-655443322110";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE device_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL,
    label TEXT NOT NULL
  );`);
  db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, ?, ?)`)
    .run(DEVICE_ID, "Test-Mac");
  return db;
}

type Harness = {
  client: RelayClient;
  wss: WebSocketServer;
  /** Resolves with each successive device connection. */
  nextConnection: () => Promise<{ socket: ServerSocket; url: string; cookie: string | undefined }>;
  fetchCalls: string[];
  close: () => Promise<void>;
};

function startHarness(opts: {
  canRun?: () => boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string>;
} = {}): Promise<Harness> {
  return new Promise((resolveHarness) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const pendingConns: Array<(c: { socket: ServerSocket; url: string; cookie: string | undefined }) => void> = [];
    const queuedConns: Array<{ socket: ServerSocket; url: string; cookie: string | undefined }> = [];
    wss.on("connection", (socket, req) => {
      const conn = { socket, url: req.url ?? "", cookie: req.headers.cookie };
      const waiter = pendingConns.shift();
      if (waiter) waiter(conn);
      else queuedConns.push(conn);
    });

    wss.on("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      const fetchCalls: string[] = [];
      const baseFetch: typeof fetch = opts.fetchImpl ?? (async () =>
        new Response("# hello", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }));
      const wrappedFetch: typeof fetch = async (input, init) => {
        fetchCalls.push(String(input));
        return baseFetch(input, init);
      };

      const client = createRelayClient({
        db: makeDb(),
        currentUser: () => ({ id: "u1", email: "u@example.com", tier: "pro" }),
        sessionToken: () => "tok-relay-test",
        canRun: opts.canRun ?? (() => true),
        workerBase: `http://127.0.0.1:${port}`,
        localPort: () => 7777,
        fetch: wrappedFetch,
        backoffBaseMs: 30,
        backoffMaxMs: 120,
        pingIntervalMs: 60_000, // keepalive out of the way for these tests
      });

      resolveHarness({
        client,
        wss,
        fetchCalls,
        nextConnection: () => new Promise((res) => {
          const queued = queuedConns.shift();
          if (queued) res(queued);
          else pendingConns.push(res);
        }),
        close: () => new Promise((res) => { client.stop(); wss.close(() => res()); }),
      });
    });
  });
}

function onceMessage(socket: ServerSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

/** Collect frames for one relayed request until res_end / res_err. */
function collectResponse(socket: ServerSocket): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const frames: Array<Record<string, unknown>> = [];
    const onMsg = (data: Buffer): void => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "res_end" || frame.type === "res_err") {
        socket.off("message", onMsg);
        resolve(frames);
      }
    };
    socket.on("message", onMsg);
  });
}

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) { await harness.close(); harness = null; }
  delete process.env.OYSTER_RELAY;
});

describe("matchRelayPath (authoritative allowlist)", () => {
  it("matches the v1 routes and carries the query through", () => {
    expect(matchRelayPath("GET", "/api/sessions")).toBe("/api/sessions");
    expect(matchRelayPath("GET", "/api/artifacts")).toBe("/api/artifacts");
    expect(matchRelayPath("GET", "/api/sessions/search?q=x%20y")).toBe("/api/sessions/search");
    expect(matchRelayPath("GET", "/api/sessions/abc-123")).toBe("/api/sessions/:id");
    expect(matchRelayPath("GET", "/artifacts/space/notes.md")).toBe("/artifacts/*");
  });

  it("rejects everything else", () => {
    expect(matchRelayPath("POST", "/api/sessions")).toBeNull();
    expect(matchRelayPath("GET", "/api/memories")).toBeNull();
    expect(matchRelayPath("GET", "/api/chat/session")).toBeNull();
    expect(matchRelayPath("GET", "/artifacts/../etc/passwd")).toBeNull();
    expect(matchRelayPath("GET", "/artifacts/%2e%2e/x")).toBeNull();
    expect(matchRelayPath("GET", "/artifacts/%252e%252e/x")).toBeNull();
    expect(matchRelayPath("GET", "/artifacts//gap")).toBeNull();
    expect(matchRelayPath("GET", "/artifacts/a%5Cb")).toBeNull();
    expect(matchRelayPath("GET", "/api/sessions/")).toBeNull();
  });
});

describe("createRelayClient", () => {
  it("dials with device identity + cookie and sends a hello advertising the routes", async () => {
    harness = await startHarness();
    harness.client.refresh();
    const conn = await harness.nextConnection();

    expect(conn.url).toContain(`device_id=${DEVICE_ID}`);
    expect(conn.url).toContain("device_label=Test-Mac");
    expect(conn.cookie).toBe("oyster_session=tok-relay-test");

    const hello = await onceMessage(conn.socket);
    expect(hello).toMatchObject({ type: "hello", proto: 1, device_id: DEVICE_ID });
    expect(hello.routes).toEqual([...RELAY_ROUTES]);
  });

  it("does not connect when the gate fails or OYSTER_RELAY=off", async () => {
    harness = await startHarness({ canRun: () => false });
    harness.client.refresh();
    await new Promise((r) => setTimeout(r, 100));
    expect(harness.client.status().connected).toBe(false);

    process.env.OYSTER_RELAY = "off";
    harness = (await harness.close(), harness = null, await startHarness());
    harness.client.refresh();
    await new Promise((r) => setTimeout(r, 100));
    expect(harness.client.status().connected).toBe(false);
  });

  it("serves an allowlisted req via loopback fetch as res_start/chunk/end", async () => {
    harness = await startHarness();
    harness.client.refresh();
    const conn = await harness.nextConnection();
    await onceMessage(conn.socket); // hello

    const framesP = collectResponse(conn.socket);
    conn.socket.send(JSON.stringify({ type: "req", id: "r1", method: "GET", path: "/artifacts/space/notes.md?x=1" }));
    const frames = await framesP;

    expect(harness.fetchCalls).toEqual(["http://127.0.0.1:7777/artifacts/space/notes.md?x=1"]);
    expect(frames[0]).toMatchObject({
      type: "res_start", id: "r1", status: 200,
      headers: { "content-type": "text/markdown" },
    });
    const body = frames
      .filter((f) => f.type === "res_chunk")
      .map((f) => Buffer.from(f.body_b64 as string, "base64").toString())
      .join("");
    expect(body).toBe("# hello");
    expect(frames.at(-1)).toMatchObject({ type: "res_end", id: "r1" });
  });

  it("splits large bodies into ≤256KB chunks", async () => {
    const big = "x".repeat(600 * 1024);
    harness = await startHarness({
      fetchImpl: async () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    harness.client.refresh();
    const conn = await harness.nextConnection();
    await onceMessage(conn.socket);

    const framesP = collectResponse(conn.socket);
    conn.socket.send(JSON.stringify({ type: "req", id: "r1", method: "GET", path: "/artifacts/big.txt" }));
    const frames = await framesP;

    const chunks = frames.filter((f) => f.type === "res_chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(Buffer.from(c.body_b64 as string, "base64").byteLength).toBeLessThanOrEqual(256 * 1024);
    }
    const total = chunks
      .map((f) => Buffer.from(f.body_b64 as string, "base64").byteLength)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(big.length);
  });

  it("AUTHORITATIVE: refuses non-allowlisted frames without touching fetch", async () => {
    harness = await startHarness();
    harness.client.refresh();
    const conn = await harness.nextConnection();
    await onceMessage(conn.socket);

    for (const path of ["/api/memories", "/artifacts/../etc/passwd", "/api/chat/session"]) {
      const framesP = collectResponse(conn.socket);
      conn.socket.send(JSON.stringify({ type: "req", id: `r-${path}`, method: "GET", path }));
      const frames = await framesP;
      expect(frames).toEqual([{ type: "res_err", id: `r-${path}`, code: "not_allowed" }]);
    }
    expect(harness.fetchCalls).toEqual([]);
  });

  it("maps loopback fetch failure to res_err fetch_failed", async () => {
    harness = await startHarness({
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    harness.client.refresh();
    const conn = await harness.nextConnection();
    await onceMessage(conn.socket);

    const framesP = collectResponse(conn.socket);
    conn.socket.send(JSON.stringify({ type: "req", id: "r1", method: "GET", path: "/api/sessions" }));
    const frames = await framesP;
    expect(frames).toEqual([{ type: "res_err", id: "r1", code: "fetch_failed" }]);
  });

  it("aborts oversized responses with res_err too_large", async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 120); // > 10MB cap
    harness = await startHarness({
      fetchImpl: async () => new Response(oversized, { status: 200 }),
    });
    harness.client.refresh();
    const conn = await harness.nextConnection();
    await onceMessage(conn.socket);

    const framesP = collectResponse(conn.socket);
    conn.socket.send(JSON.stringify({ type: "req", id: "r1", method: "GET", path: "/artifacts/huge.bin" }));
    const frames = await framesP;
    expect(frames.at(-1)).toMatchObject({ type: "res_err", id: "r1", code: "too_large" });
  }, 15_000);

  it("reconnects with backoff after a network-style close", async () => {
    harness = await startHarness();
    harness.client.refresh();
    const first = await harness.nextConnection();
    await onceMessage(first.socket);
    first.socket.terminate(); // abnormal close → client sees 1006

    const second = await harness.nextConnection(); // would hang if it never reconnected
    expect(second.url).toContain(`device_id=${DEVICE_ID}`);
  });

  it("parks (no reconnect) on close 4401 session_revoked, until refresh()", async () => {
    harness = await startHarness();
    harness.client.refresh();
    const first = await harness.nextConnection();
    await onceMessage(first.socket);
    first.socket.close(4401, "session_revoked");

    // Generous window: several backoff periods at base 30ms.
    let reconnected = false;
    const racer = harness.nextConnection().then(() => { reconnected = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(reconnected).toBe(false);

    // Auth change → refresh() clears the parked state and redials.
    harness.client.refresh();
    await racer;
    expect(reconnected).toBe(true);
  });
});

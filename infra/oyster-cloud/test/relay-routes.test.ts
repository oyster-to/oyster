// Device relay tests (spec 2026-06-07-device-relay-design). The test
// harness plays the DEVICE end of the socket: it dials /api/relay/connect
// exactly like server/src/relay-client.ts will, answers req frames with
// res_start/res_chunk/res_end, and asserts what the browser-side forward
// route returns.
//
// Each test mints its own user → its own RelayDO (idFromName), so
// disabled flags / rate state never bleed between tests.

import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";
import { RELAY_ALLOWLIST } from "../src/relay-allowlist.js";

async function makeSession(tier: "pro" | "free", suffix = crypto.randomUUID()):
  Promise<{ token: string; userId: string }> {
  const userId = `u-${tier}-${suffix}`;
  const token  = `tok-${tier}-${suffix}`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, ?, ?)`)
    .bind(userId, `${tier}-${suffix}@example.com`, tier, Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, userId };
}

function signedFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `oyster_session=${token}`);
  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

type DeviceResponse =
  | { status: number; headers?: Record<string, string>; chunks: string[] }
  | { err: string };

type ConnectOpts = {
  label?: string;
  routes?: string[];
  proto?: number;
  hello?: boolean;
  respond?: (path: string) => DeviceResponse | null; // null = stay silent
};

/** Dial /api/relay/connect as a device and (optionally) start answering
 *  req frames. Returns the device-side socket plus the paths it saw. */
async function connectDevice(token: string, deviceId: string, opts: ConnectOpts = {}):
  Promise<{ ws: WebSocket; seenPaths: string[]; closed: Promise<number> }> {
  const res = await SELF.fetch(
    `https://example.com/api/relay/connect?device_id=${deviceId}` +
    `&device_label=${encodeURIComponent(opts.label ?? "Test-Mac")}`,
    { headers: { Upgrade: "websocket", Cookie: `oyster_session=${token}` } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on 101 response");
  ws.accept();

  const seenPaths: string[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let frame: { type?: string; id?: string; path?: string };
    try { frame = JSON.parse(ev.data) as typeof frame; } catch { return; }
    if (frame.type !== "req" || !frame.id || !frame.path) return;
    seenPaths.push(frame.path);
    const r = opts.respond?.(frame.path) ?? null;
    if (r === null) return; // silent device — used by timeout tests
    if ("err" in r) {
      ws.send(JSON.stringify({ type: "res_err", id: frame.id, code: r.err }));
      return;
    }
    ws.send(JSON.stringify({ type: "res_start", id: frame.id, status: r.status, headers: r.headers ?? {} }));
    for (const chunk of r.chunks) {
      ws.send(JSON.stringify({ type: "res_chunk", id: frame.id, body_b64: btoa(chunk) }));
    }
    ws.send(JSON.stringify({ type: "res_end", id: frame.id }));
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (ev) => resolve(ev.code));
  });

  if (opts.hello !== false) {
    ws.send(JSON.stringify({
      type: "hello",
      proto: opts.proto ?? 1,
      routes: opts.routes ?? [...RELAY_ALLOWLIST],
    }));
  }
  return { ws, seenPaths, closed };
}

type StatusBody = {
  online: Array<{ device_id: string; device_label: string | null; ready: boolean }>;
  disabled: Array<{ device_id: string; device_label: string | null }>;
};

/** The hello frame is processed asynchronously by the DO — poll status
 *  until the device shows ready before forwarding. */
async function waitReady(token: string, deviceId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const res = await signedFetch("/api/relay/status", {}, token);
    const body = await res.json() as StatusBody;
    if (body.online.some((d) => d.device_id === deviceId && d.ready)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("device never became ready");
}

function forward(token: string, deviceId: string, path: string): Promise<Response> {
  return signedFetch(`/api/relay/d/${deviceId}${path}`, {}, token);
}

beforeAll(async () => { await applySchema(); });

describe("GET /api/relay/connect", () => {
  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch(
      `https://example.com/api/relay/connect?device_id=${crypto.randomUUID()}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(401);
  });

  it("rejects free-tier users with 403", async () => {
    const { token } = await makeSession("free");
    const res = await SELF.fetch(
      `https://example.com/api/relay/connect?device_id=${crypto.randomUUID()}`,
      { headers: { Upgrade: "websocket", Cookie: `oyster_session=${token}` } },
    );
    expect(res.status).toBe(403);
  });

  it("rejects non-websocket requests with 426", async () => {
    const { token } = await makeSession("pro");
    const res = await signedFetch(`/api/relay/connect?device_id=${crypto.randomUUID()}`, {}, token);
    expect(res.status).toBe(426);
  });

  it("rejects a malformed device_id with 400", async () => {
    const { token } = await makeSession("pro");
    const res = await SELF.fetch(
      "https://example.com/api/relay/connect?device_id=not-a-uuid",
      { headers: { Upgrade: "websocket", Cookie: `oyster_session=${token}` } },
    );
    expect(res.status).toBe(400);
  });

  it("closes a wrong-proto device with 1002", async () => {
    const { token } = await makeSession("pro");
    const { closed } = await connectDevice(token, crypto.randomUUID(), { proto: 99 });
    expect(await closed).toBe(1002);
  });

  it("supersedes an older socket on reconnect (4000)", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    const first = await connectDevice(token, deviceId);
    await connectDevice(token, deviceId);
    expect(await first.closed).toBe(4000);
  });
});

describe("GET /api/relay/status", () => {
  it("rejects unsigned (401) and free-tier (403)", async () => {
    expect((await SELF.fetch("https://example.com/api/relay/status")).status).toBe(401);
    const { token } = await makeSession("free");
    expect((await signedFetch("/api/relay/status", {}, token)).status).toBe(403);
  });

  it("lists a connected device as ready after hello", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, { label: "Studio-Mac" });
    await waitReady(token, deviceId);
    const body = await (await signedFetch("/api/relay/status", {}, token)).json() as StatusBody;
    const dev = body.online.find((d) => d.device_id === deviceId);
    expect(dev).toMatchObject({ device_label: "Studio-Mac", ready: true });
    expect(body.disabled).toEqual([]);
  });
});

describe("GET /api/relay/d/:deviceId/<path>", () => {
  it("round-trips an allowlisted GET with hardened headers", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, {
      respond: () => ({
        status: 200,
        // Mixed casing on purpose — the DO must match content-type
        // case-insensitively (devices serialise whatever their HTTP
        // stack produced).
        headers: { "Content-Type": "text/markdown", "X-Device-Secret": "must-not-pass" },
        chunks: ["# hello from the laptop"],
      }),
    });
    await waitReady(token, deviceId);

    const res = await forward(token, deviceId, "/artifacts/space/notes.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# hello from the laptop");
    expect(res.headers.get("content-type")).toBe("text/markdown");
    // Device-controlled headers are dropped; hardening headers are forced.
    expect(res.headers.get("x-device-secret")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reassembles multi-chunk responses in order", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, {
      respond: () => ({ status: 200, chunks: ["abc", "def", "ghi"] }),
    });
    await waitReady(token, deviceId);
    const res = await forward(token, deviceId, "/api/sessions");
    expect(await res.text()).toBe("abcdefghi");
  });

  it("passes the query string through to the device untouched", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    const { seenPaths } = await connectDevice(token, deviceId, {
      respond: () => ({ status: 200, chunks: ["[]"] }),
    });
    await waitReady(token, deviceId);
    await forward(token, deviceId, "/api/sessions/search?q=hello%20world&limit=5");
    expect(seenPaths).toEqual(["/api/sessions/search?q=hello%20world&limit=5"]);
  });

  it("rejects non-allowlisted and traversal paths before framing", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    const { seenPaths } = await connectDevice(token, deviceId, {
      respond: () => ({ status: 200, chunks: ["leak"] }),
    });
    await waitReady(token, deviceId);

    for (const bad of [
      "/api/memories",                  // not on the allowlist
      "/api/chat/session",              // later slice, opt-in
      "/artifacts/%2e%2e/secrets",      // encoded traversal
      "/artifacts/%252e%252e/secrets",  // double-encoded traversal
      "/artifacts//gap",                // empty segment
      "/artifacts/a%5Cb",               // encoded backslash
    ]) {
      const res = await forward(token, deviceId, bad);
      expect(res.status, bad).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error, bad).toBe("path_not_allowed");
    }

    // RAW dot segments never even reach the matcher: new URL() collapses
    // them during dispatch (browsers do the same before sending), so this
    // one mangles the device id and 400s. Either way: not relayed.
    const raw = await forward(token, deviceId, "/artifacts/../../etc/passwd");
    expect(raw.status).toBe(400);

    expect(seenPaths).toEqual([]); // nothing ever reached the device
  });

  it("returns 502 relay_device_offline for a device with no socket", async () => {
    const { token } = await makeSession("pro");
    const res = await forward(token, crypto.randomUUID(), "/api/sessions");
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe("relay_device_offline");
  });

  it("isolates users: B cannot reach A's device through B's own DO", async () => {
    const a = await makeSession("pro");
    const b = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    const { seenPaths } = await connectDevice(a.token, deviceId, {
      respond: () => ({ status: 200, chunks: ["a-private"] }),
    });
    await waitReady(a.token, deviceId);

    const res = await forward(b.token, deviceId, "/api/sessions");
    expect(res.status).toBe(502); // B's DO has no such socket
    expect(seenPaths).toEqual([]);
  });

  it("rejects routes the device did not advertise (version skew)", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, {
      routes: ["/api/sessions"], // an older server without the file route
      respond: () => ({ status: 200, chunks: ["ok"] }),
    });
    await waitReady(token, deviceId);
    const res = await forward(token, deviceId, "/artifacts/space/notes.md");
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe("relay_route_unsupported");
  });

  it("does not forward to a device that never sent hello", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, { hello: false });
    // Can't waitReady (it never becomes ready) — give the connect a beat.
    await new Promise((r) => setTimeout(r, 50));
    const res = await forward(token, deviceId, "/api/sessions");
    expect(res.status).toBe(502);
  });

  it("maps device res_err codes onto sane statuses", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    const errByPath: Record<string, string> = {
      "/api/sessions": "fetch_failed",
      "/api/sessions/search": "not_allowed",
      "/artifacts/big.bin": "too_large",
    };
    await connectDevice(token, deviceId, {
      respond: (path) => ({ err: errByPath[path.split("?")[0]!] ?? "fetch_failed" }),
    });
    await waitReady(token, deviceId);

    const failed = await forward(token, deviceId, "/api/sessions");
    expect(failed.status).toBe(502);
    expect((await failed.json() as { error: string }).error).toBe("fetch_failed");

    // Device-side allowlist narrower than cloud's → route mismatch, 502.
    const mismatch = await forward(token, deviceId, "/api/sessions/search");
    expect(mismatch.status).toBe(502);
    expect((await mismatch.json() as { error: string }).error).toBe("relay_route_mismatch");

    const tooLarge = await forward(token, deviceId, "/artifacts/big.bin");
    expect(tooLarge.status).toBe(413);
  });

  it("times out a wedged device with 504", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, { respond: () => null }); // silent
    await waitReady(token, deviceId);
    const res = await forward(token, deviceId, "/api/sessions");
    expect(res.status).toBe(504);
    expect((await res.json() as { error: string }).error).toBe("relay_timeout");
  }, 10_000);

  it("caps concurrent in-flight requests per device with 429", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    await connectDevice(token, deviceId, { respond: () => null }); // silent
    await waitReady(token, deviceId);

    const hanging = Array.from({ length: 20 }, () => forward(token, deviceId, "/api/sessions"));
    await new Promise((r) => setTimeout(r, 100)); // let all 20 land as pending
    const overflow = await forward(token, deviceId, "/api/sessions");
    expect(overflow.status).toBe(429);
    expect((await overflow.json() as { error: string }).error).toBe("relay_busy");

    const settled = await Promise.all(hanging);
    for (const res of settled) expect(res.status).toBe(504);
  }, 15_000);
});

describe("POST /api/relay/devices/:deviceId/{disable,enable}", () => {
  it("rejects unsigned (401), free-tier (403), and bad browser origins (403)", async () => {
    const deviceId = crypto.randomUUID();
    expect((await SELF.fetch(
      `https://example.com/api/relay/devices/${deviceId}/disable`, { method: "POST" },
    )).status).toBe(401);

    const free = await makeSession("free");
    expect((await signedFetch(`/api/relay/devices/${deviceId}/disable`, { method: "POST" }, free.token)).status).toBe(403);

    const pro = await makeSession("pro");
    const res = await signedFetch(
      `/api/relay/devices/${deviceId}/disable`,
      { method: "POST", headers: { origin: "https://evil.example" } },
      pro.token,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("bad_origin");
  });

  it("disable severs the socket (4403), blocks reconnect, and enable restores it", async () => {
    const { token } = await makeSession("pro");
    const deviceId = crypto.randomUUID();
    const dev = await connectDevice(token, deviceId, {
      label: "Studio-Mac",
      respond: () => ({ status: 200, chunks: ["ok"] }),
    });
    await waitReady(token, deviceId);

    const disable = await signedFetch(`/api/relay/devices/${deviceId}/disable`, { method: "POST" }, token);
    expect(disable.status).toBe(200);
    expect(await dev.closed).toBe(4403);

    // Forwarding now fails — the socket is gone.
    expect((await forward(token, deviceId, "/api/sessions")).status).toBe(502);

    // Status remembers the disabled device (with its label) for the UI.
    const status = await (await signedFetch("/api/relay/status", {}, token)).json() as StatusBody;
    expect(status.disabled).toMatchObject([{ device_id: deviceId, device_label: "Studio-Mac" }]);

    // Reconnect attempts are rejected until re-enabled — the device
    // cannot un-disable itself.
    const blocked = await SELF.fetch(
      `https://example.com/api/relay/connect?device_id=${deviceId}`,
      { headers: { Upgrade: "websocket", Cookie: `oyster_session=${token}` } },
    );
    expect(blocked.status).toBe(403);
    expect((await blocked.json() as { error: string }).error).toBe("relay_disabled");

    const enable = await signedFetch(`/api/relay/devices/${deviceId}/enable`, { method: "POST" }, token);
    expect(enable.status).toBe(200);
    await connectDevice(token, deviceId, { respond: () => ({ status: 200, chunks: ["back"] }) });
    await waitReady(token, deviceId);
    const res = await forward(token, deviceId, "/api/sessions");
    expect(await res.text()).toBe("back");
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

// ── Helpers (file-local copies from sessions-routes.test.ts) ───────────────

async function makeProSession(suffix = crypto.randomUUID()): Promise<{ token: string; userId: string }> {
  const userId = `u-pro-${suffix}`;
  const token  = `tok-pro-${suffix}`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'pro', ?)`)
    .bind(userId, `pro-${suffix}@example.com`, Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, userId };
}

async function makeFreeSession(suffix = crypto.randomUUID()): Promise<{ token: string; userId: string }> {
  const userId = `u-free-${suffix}`;
  const token  = `tok-free-${suffix}`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'free', ?)`)
    .bind(userId, `free-${suffix}@example.com`, Date.now()).run();
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

function sampleSession(id: string, syncDirtyAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    device_id: "dev-mac-01",
    agent: "claude-code",
    title: "Test session",
    state: "done",
    cwd: "/Users/test/proj",
    model: "claude-sonnet-4-6",
    started_at: "2026-05-10T10:00:00Z",
    ended_at: "2026-05-10T10:30:00Z",
    last_event_at: "2026-05-10T10:30:00Z",
    sync_dirty_at: syncDirtyAt,
    ...overrides,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}

async function putChunk(
  token: string,
  sessionId: string,
  chunkNumber: number,
  bytes: Uint8Array,
  startOffset: number,
  generation: number,
  deviceId?: string,
): Promise<{ res: Response; sha: string }> {
  const sha = await sha256Hex(bytes);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-chunk-start-offset": String(startOffset),
    "x-chunk-end-offset": String(startOffset + bytes.byteLength),
    "x-plaintext-sha256": sha,
    "x-bytes-generation": String(generation),
  };
  if (deviceId) headers["x-bytes-device-id"] = deviceId;
  const res = await signedFetch(
    `/api/sessions/bytes/${sessionId}/chunk/${chunkNumber}`,
    { method: "PUT", headers, body: bytes },
    token,
  );
  return { res, sha };
}

// ── Fixture transcript ─────────────────────────────────────────────────────

const CWD = "/Users/test/proj";

// One JSONL line per event; byte offsets are line starts in the
// concatenated plaintext. All-ASCII so char offsets == byte offsets.
const LINES = [
  JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2026-05-10T10:00:01Z" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] }, timestamp: "2026-05-10T10:00:02Z" }),
  JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),                                  // skipped: unknown type
  JSON.stringify({ type: "user", message: { content: "<command-name>/exit</command-name>" } }),     // skipped: protocol artifact
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${CWD}/a.ts` } }] }, timestamp: "2026-05-10T10:00:03Z" }),
];
const BODY = LINES.map((l) => l + "\n").join("");
const PARTIAL_TAIL = `{"type":"user","message":{"content":"still being writ`; // no newline

function offsetOf(i: number): number {
  return LINES.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/sessions/:id/events", () => {
  beforeAll(async () => { await applySchema(); });

  it("returns rendered events oldest-first with byte-offset ids", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    // POST metadata with cwd so the handler can relativise paths
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000, { cwd: CWD })] }),
    }, token);
    // Upload BODY + PARTIAL_TAIL as chunk 1
    const enc = new TextEncoder();
    const bytes = enc.encode(BODY + PARTIAL_TAIL);
    const { res: putRes } = await putChunk(token, sid, 1, bytes, 0, 0);
    expect(putRes.status).toBe(200);

    const res = await signedFetch(`/api/sessions/${sid}/events`, { method: "GET" }, token);
    expect(res.status).toBe(200);
    const events = await res.json() as Array<{ id: number; sessionId: string; role: string; text: string; ts: string | null; raw: null }>;

    // Only 3 events should come through: lines 0, 1, 4 (line 2 unknown type, line 3 protocol artifact)
    expect(events).toHaveLength(3);
    expect(events[0]!.id).toBe(offsetOf(0));
    expect(events[0]!.role).toBe("user");
    expect(events[0]!.text).toBe("hello");
    expect(events[1]!.id).toBe(offsetOf(1));
    expect(events[1]!.role).toBe("assistant");
    expect(events[1]!.text).toBe("hi there");
    expect(events[2]!.id).toBe(offsetOf(4));
    expect(events[2]!.role).toBe("tool");
    expect(events[2]!.text).toBe("[Edit a.ts]");

    // Timestamps and sessionId
    expect(events[0]!.ts).toBe("2026-05-10T10:00:01Z");
    expect(events[0]!.sessionId).toBe(sid);
    expect(events[0]!.raw).toBeNull();
  });

  it("honours after= (live tail)", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000, { cwd: CWD })] }),
    }, token);
    const enc = new TextEncoder();
    const bytes = enc.encode(BODY + PARTIAL_TAIL);
    expect((await putChunk(token, sid, 1, bytes, 0, 0)).res.status).toBe(200);

    const res = await signedFetch(`/api/sessions/${sid}/events?after=${offsetOf(0)}`, { method: "GET" }, token);
    expect(res.status).toBe(200);
    const events = await res.json() as Array<{ id: number }>;
    expect(events.map((e) => e.id)).toEqual([offsetOf(1), offsetOf(4)]);
  });

  it("honours before= and limit= (scroll up)", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000, { cwd: CWD })] }),
    }, token);
    const enc = new TextEncoder();
    const bytes = enc.encode(BODY + PARTIAL_TAIL);
    expect((await putChunk(token, sid, 1, bytes, 0, 0)).res.status).toBe(200);

    const res = await signedFetch(`/api/sessions/${sid}/events?before=${offsetOf(4)}&limit=1`, { method: "GET" }, token);
    expect(res.status).toBe(200);
    const events = await res.json() as Array<{ id: number }>;
    // latest 1 below cursor: offsetOf(1)
    expect(events.map((e) => e.id)).toEqual([offsetOf(1)]);
  });

  it("returns [] for a session with metadata but no chunks", async () => {
    const { token } = await makeProSession();
    const sid = `s-${crypto.randomUUID()}`;
    await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [sampleSession(sid, 1000, { cwd: CWD })] }),
    }, token);
    // No putChunk — metadata only

    const res = await signedFetch(`/api/sessions/${sid}/events`, { method: "GET" }, token);
    expect(res.status).toBe(200);
    const events = await res.json();
    expect(events).toEqual([]);
  });

  it("requires auth", async () => {
    const res = await SELF.fetch(`https://example.com/api/sessions/some-id/events`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("rejects free tier with 403", async () => {
    const { token } = await makeFreeSession();
    const res = await signedFetch(`/api/sessions/some-id/events`, { method: "GET" }, token);
    expect(res.status).toBe(403);
  });
});

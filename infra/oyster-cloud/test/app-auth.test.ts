// Direct-handler tests for the app.oyster.to handshake callback and
// sign-out (spec 2026-06-05-app-oyster-to-migration). Dispatch wiring is
// integration-tested in app-shell.test.ts (Task 6).
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";
import { handleAppCallback, handleAppSignOut } from "../src/app-auth.js";

async function sha256HexStr(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedSession(opts: { revoked?: boolean; expired?: boolean } = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const sid = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'pro', ?)")
    .bind(userId, `${userId}@example.com`, now).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sid, userId, now,
      opts.expired ? now - 1000 : now + 86_400_000,
      opts.revoked ? now : null).run();
  return sid;
}

async function seedCode(sid: string, opts: { expired?: boolean; consumed?: boolean } = {}): Promise<string> {
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app_handoff_codes (code_hash, session_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256HexStr(raw), sid, now,
    opts.expired ? now - 1000 : now + 60_000,
    opts.consumed ? now : null).run();
  return raw;
}

function callbackReq(code: string | null, ret?: string): { req: Request; url: URL } {
  const u = new URL("https://app.oyster.to/auth/callback");
  if (code !== null) u.searchParams.set("code", code);
  if (ret !== undefined) u.searchParams.set("return", ret);
  return { req: new Request(u), url: u };
}

describe("GET /auth/callback (app.oyster.to)", () => {
  beforeAll(async () => { await applySchema(); });

  it("burns a valid code, sets a host-only cookie, 302s to /", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw);
    const res = await handleAppCallback(req, env, url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`oyster_session=${sid}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain="); // invariant 1: host-only
    expect(res.headers.get("cache-control")).toContain("no-store");
    // Burned in D1.
    const row = await env.DB.prepare("SELECT consumed_at FROM app_handoff_codes WHERE session_id = ?")
      .bind(sid).first<{ consumed_at: number | null }>();
    expect(row!.consumed_at).not.toBeNull();
  });

  it("honours a validated return path", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw, "/sessions/abc?tab=1");
    const res = await handleAppCallback(req, env, url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sessions/abc?tab=1");
  });

  it("falls back to / for an invalid return path", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw, "//evil.example");
    const res = await handleAppCallback(req, env, url);
    expect(res.headers.get("location")).toBe("/");
  });

  async function expectRetryPage(res: Response): Promise<void> {
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("https://oyster.to/auth/app-handoff"); // retry link, no auto-redirect
  }

  it("shows the retry page for a missing code", async () => {
    const { req, url } = callbackReq(null);
    await expectRetryPage(await handleAppCallback(req, env, url));
  });

  it("shows the retry page for an unknown code", async () => {
    const { req, url } = callbackReq("not-a-real-code");
    await expectRetryPage(await handleAppCallback(req, env, url));
  });

  it("shows the retry page for an expired code", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid, { expired: true });
    const { req, url } = callbackReq(raw);
    await expectRetryPage(await handleAppCallback(req, env, url));
  });

  it("shows the retry page for a reused code (single-use)", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const a = callbackReq(raw);
    const first = await handleAppCallback(a.req, env, a.url);
    expect(first.status).toBe(302);
    const b = callbackReq(raw);
    await expectRetryPage(await handleAppCallback(b.req, env, b.url));
  });

  // Miniflare serialises D1 writes, so this runs the two callbacks
  // back-to-back rather than truly interleaved — it proves single-use
  // under racing callers at the SQL level, not scheduler-level races.
  it("burns exactly once under concurrency", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const [r1, r2] = await Promise.all([
      (() => { const c = callbackReq(raw); return handleAppCallback(c.req, env, c.url); })(),
      (() => { const c = callbackReq(raw); return handleAppCallback(c.req, env, c.url); })(),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([302, 400]);
  });

  it("shows the retry page when the session was revoked between mint and burn", async () => {
    const sid = await seedSession({ revoked: true });
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw);
    await expectRetryPage(await handleAppCallback(req, env, url));
  });
});

describe("POST /auth/sign-out (app.oyster.to)", () => {
  beforeAll(async () => { await applySchema(); });

  function signOutReq(opts: { cookie?: string; origin?: string } = {}): Request {
    const headers = new Headers();
    if (opts.cookie) headers.set("Cookie", `oyster_session=${opts.cookie}`);
    if (opts.origin) headers.set("Origin", opts.origin);
    return new Request("https://app.oyster.to/auth/sign-out", { method: "POST", headers });
  }

  it("revokes the shared session row and clears the cookie", async () => {
    const sid = await seedSession();
    const res = await handleAppSignOut(signOutReq({ cookie: sid }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const row = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(sid).first<{ revoked_at: number | null }>();
    expect(row!.revoked_at).not.toBeNull(); // invariant 3: apex is signed out too
  });

  it("is idempotent without a cookie", async () => {
    const res = await handleAppSignOut(signOutReq(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects a foreign browser origin", async () => {
    const sid = await seedSession();
    const res = await handleAppSignOut(signOutReq({ cookie: sid, origin: "https://evil.example" }), env);
    expect(res.status).toBe(403);
  });
});

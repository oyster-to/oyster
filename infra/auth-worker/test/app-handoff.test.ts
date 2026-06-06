// Tests for GET /auth/app-handoff — the apex side of the app.oyster.to
// handshake (spec 2026-06-05-app-oyster-to-migration).
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { sha256Hex } from "../src/worker";
import { applySchema } from "./fixtures/seed";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).MAGIC_LINK_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => { await applySchema(); });

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedSession(opts: { revoked?: boolean; expired?: boolean } = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const sid = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `${userId}@example.com`, now, now).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sid, userId, now,
      opts.expired ? now - 1000 : now + 86_400_000,
      opts.revoked ? now : null).run();
  return sid;
}

function handoffReq(opts: { cookie?: string; ret?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", `oyster_session=${opts.cookie}`);
  const qs = opts.ret !== undefined ? `?return=${encodeURIComponent(opts.ret)}` : "";
  return new Request(`https://oyster.to/auth/app-handoff${qs}`, { headers });
}

describe("GET /auth/app-handoff", () => {
  it("redirects to sign-in when there is no cookie", async () => {
    const res = await call(handoffReq());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/sign-in?return=%2Fauth%2Fapp-handoff");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("redirects to sign-in when the session is revoked", async () => {
    const sid = await seedSession({ revoked: true });
    const res = await call(handoffReq({ cookie: sid }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/sign-in?return=%2Fauth%2Fapp-handoff");
  });

  it("mints a hashed single-use code and 302s to the app callback", async () => {
    const sid = await seedSession();
    const before = Date.now();
    const res = await call(handoffReq({ cookie: sid }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://app.oyster.to");
    expect(loc.pathname).toBe("/auth/callback");
    const code = loc.searchParams.get("code")!;
    expect(code.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url

    const row = await env.DB.prepare("SELECT * FROM app_handoff_codes WHERE code_hash = ?")
      .bind(await sha256Hex(code))
      .first<{ session_id: string; expires_at: number; consumed_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe(sid);
    expect(row!.consumed_at).toBeNull();
    // 60s TTL in milliseconds.
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + 59_000);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("passes a valid return path through to the callback", async () => {
    const sid = await seedSession();
    const res = await call(handoffReq({ cookie: sid, ret: "/sessions/abc?tab=1" }));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBe("/sessions/abc?tab=1");
  });

  it.each([
    ["protocol-relative", "//evil.example"],
    ["absolute", "https://evil.example/"],
    ["control chars", "/a\nb"],
    ["overlong", "/" + "a".repeat(300)],
  ])("drops an invalid return path (%s)", async (_name, ret) => {
    const sid = await seedSession();
    const res = await call(handoffReq({ cookie: sid, ret }));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBeNull();
    expect(loc.searchParams.get("code")).not.toBeNull(); // handoff still proceeds
  });

  it("GCs expired rows on mint (proves DELETE … LIMIT on the fixture)", async () => {
    const sid = await seedSession();
    await env.DB.prepare(
      "INSERT INTO app_handoff_codes (code_hash, session_id, created_at, expires_at) VALUES ('stale', ?, 0, 1)",
    ).bind(sid).run();
    await call(handoffReq({ cookie: sid }));
    const stale = await env.DB.prepare("SELECT 1 FROM app_handoff_codes WHERE code_hash = 'stale'").first();
    expect(stale).toBeNull();
  });
});

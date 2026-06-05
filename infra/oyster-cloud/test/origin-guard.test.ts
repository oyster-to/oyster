import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

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

function signedFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `oyster_session=${token}`);
  return SELF.fetch(`https://example.com${path}`, { ...init, headers });
}

describe("origin guard on mutating routes", () => {
  beforeAll(async () => { await applySchema(); });

  it("rejects a mutating request from a foreign browser origin", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/api/sessions/metadata", {
      method: "POST",
      headers: {
        Cookie: `oyster_session=${token}`,
        Origin: "https://share.oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessions: [] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("bad_origin");
  });

  it("allows the apex origin", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/api/sessions/metadata", {
      method: "POST",
      headers: {
        Cookie: `oyster_session=${token}`,
        Origin: "https://oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessions: [] }),
    });
    expect(res.status).not.toBe(403);
  });

  it("allows requests with no Origin header (local server)", async () => {
    const { token } = await makeProSession();
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [] }),
    }, token);
    expect(res.status).not.toBe(403);
  });
});

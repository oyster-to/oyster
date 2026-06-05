import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

async function makeSession(tier: "pro" | "free", suffix = crypto.randomUUID()): Promise<{ token: string; email: string }> {
  const userId = `u-${tier}-${suffix}`;
  const token  = `tok-${tier}-${suffix}`;
  const email  = `${tier}-${suffix}@example.com`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, ?, ?)`)
    .bind(userId, email, tier, Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, email };
}

function signedFetch(path: string, token: string): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    headers: { Cookie: `oyster_session=${token}` },
  });
}

describe("GET /api/me", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("returns 200 {email, tier} for a signed-in user", async () => {
    const { token, email } = await makeSession("pro");
    const res = await signedFetch("/api/me", token);
    expect(res.status).toBe(200);
    const body = await res.json() as { email: string; tier: string };
    expect(body.email).toBe(email);
    expect(body.tier).toBe("pro");
  });

  it("works for any tier (no pro gate)", async () => {
    const { token, email } = await makeSession("free");
    const res = await signedFetch("/api/me", token);
    expect(res.status).toBe(200);
    const body = await res.json() as { email: string; tier: string };
    expect(body.email).toBe(email);
    expect(body.tier).toBe("free");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await SELF.fetch("https://example.com/api/me");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("sign_in_required");
  });
});

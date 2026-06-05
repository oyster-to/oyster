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

describe("GET /app", () => {
  beforeAll(async () => { await applySchema(); });

  it("serves a sign-in prompt when unauthenticated", async () => {
    const res = await SELF.fetch("https://example.com/app");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Sign in");
  });

  it("serves the SPA index when signed in", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/app", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("oyster");
  });

  it("serves hashed assets publicly (no auth)", async () => {
    const res = await SELF.fetch("https://example.com/app/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture");
  });

  it("rewrites /app/api/* onto the API dispatch (not the SPA catch-all)", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/app/api/sessions/metadata", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    // Guards the dispatch-order trap: if the SPA catch-all had swallowed the
    // rewrite this would be text/html, not JSON.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toHaveProperty("sessions");
  });

  it("rejects non-GET methods under /app", async () => {
    const res = await SELF.fetch("https://example.com/app", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

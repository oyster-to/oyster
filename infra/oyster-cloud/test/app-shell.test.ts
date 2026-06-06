// app.oyster.to shell + dispatch integration tests (spec
// 2026-06-05-app-oyster-to-migration). Replaces the oyster.to/app-era
// tests — the legacy URLs are covered by redirects.test.ts now.
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

describe("app.oyster.to shell", () => {
  beforeAll(async () => { await applySchema(); });

  it("redirects a signed-out navigation into the apex handoff", async () => {
    // Use a path that doesn't exist as a static file so the worker runs first
    // (miniflare serves known ASSETS paths before the worker when
    // run_worker_first is not yet supported by the local runtime version).
    const res = await SELF.fetch("https://app.oyster.to/dashboard", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://oyster.to/auth/app-handoff?return=%2Fdashboard");
  });

  it("carries the deep link as a return param", async () => {
    const res = await SELF.fetch("https://app.oyster.to/sessions/abc?tab=1", { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/auth/app-handoff");
    expect(loc.searchParams.get("return")).toBe("/sessions/abc?tab=1");
  });

  it("serves the SPA index when signed in", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("oyster");
  });

  it("serves SPA routes (deep paths) when signed in", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/s/some-space", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves hashed assets publicly (no auth)", async () => {
    const res = await SELF.fetch("https://app.oyster.to/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture");
  });

  it("rejects non-GET methods on shell paths", async () => {
    const res = await SELF.fetch("https://app.oyster.to/", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("app.oyster.to API dispatch", () => {
  beforeAll(async () => { await applySchema(); });

  it("serves /api/* bare via the shared dispatch (not the SPA catch-all)", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/api/sessions/metadata", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    // Dispatch-order guard: html here would mean the shell swallowed it.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toHaveProperty("sessions");
  });

  it("forwards /api/publish/* to the PUBLISH service binding", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/api/publish/mine", {
      headers: { Cookie: `oyster_session=${token}`, Origin: "https://app.oyster.to" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stub).toBe("oyster-publish");
    expect(body.url).toBe("https://app.oyster.to/api/publish/mine"); // hostname preserved
    expect(body.origin).toBe("https://app.oyster.to");               // Origin passes through
    expect(body.hasCookie).toBe(true);                                // cookie passes through
  });

  it("forwards /api/spaces/* to the PUBLISH service binding", async () => {
    const res = await SELF.fetch("https://app.oyster.to/api/spaces/mine");
    const body = await res.json() as Record<string, unknown>;
    expect(body.stub).toBe("oyster-publish");
    expect(body.method).toBe("GET");
  });

  it("auth callback is reachable through the dispatch", async () => {
    const res = await SELF.fetch("https://app.oyster.to/auth/callback?code=bogus", { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Try again");
  });

  it("sign-out is reachable through the dispatch", async () => {
    const res = await SELF.fetch("https://app.oyster.to/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

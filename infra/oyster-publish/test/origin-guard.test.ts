import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, seedActivePublication, authHeader } from "./fixtures/seed";

beforeEach(async () => {
  await applySchema();
});

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function patchRequest(token: string, opts: {
  sessionToken?: string;
  origin?: string;
  body?: object;
} = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.sessionToken) headers.set("Cookie", `oyster_session=${opts.sessionToken}`);
  if (opts.origin) headers.set("Origin", opts.origin);
  return new Request(`https://oyster.to/api/publish/${token}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(opts.body ?? { mode: "open" }),
  });
}

describe("origin guard on mutating routes", () => {
  it("rejects a mutating request from a foreign browser origin", async () => {
    // Guard runs before auth/body-parsing — no seeded session or publication needed.
    const res = await call(patchRequest("anytoken", {
      origin: "https://share.oyster.to",
    }));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("bad_origin");
  });

  it("allows the apex origin", async () => {
    const u = await seedUser({ tier: "free" });
    const tok = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_apex" });
    const res = await call(patchRequest(tok, {
      sessionToken: u.sessionToken,
      origin: "https://oyster.to",
      body: { mode: "open" },
    }));
    expect(res.status).not.toBe(403);
  });

  it("allows requests with no Origin header (local server)", async () => {
    const u = await seedUser({ tier: "free" });
    const tok = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_local" });
    const res = await call(patchRequest(tok, {
      sessionToken: u.sessionToken,
      // no origin header
      body: { mode: "open" },
    }));
    expect(res.status).not.toBe(403);
  });
});

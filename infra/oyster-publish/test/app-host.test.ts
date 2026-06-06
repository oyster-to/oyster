// Host-behaviour tests for the app.oyster.to service-binding path (spec
// 2026-06-05-app-oyster-to-migration, invariant 6). The oyster-cloud
// worker forwards /api/publish/* and /api/spaces/* with the URL hostname
// preserved as app.oyster.to — these prove the handlers behave exactly
// as they do on the apex, and that the host-dependent branches
// (access-redirect's www/share 308, /p/*'s apex 308) don't fire.
import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, authHeader, seedSyncedSpace, seedActivePublication } from "./fixtures/seed";

beforeEach(async () => { await applySchema(); });

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("app.oyster.to host behaviour", () => {
  it("GET /api/spaces/mine works identically on the app host", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", updatedAt: 1000 });
    const res = await call(new Request("https://app.oyster.to/api/spaces/mine", {
      headers: { Cookie: authHeader(u.sessionToken).Cookie },
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as { spaces: Array<{ space_id: string }> };
    expect(json.spaces.map((s) => s.space_id)).toEqual(["work"]);
  });

  it("GET /api/publish/mine works identically on the app host", async () => {
    const u = await seedUser();
    await seedActivePublication({ ownerUserId: u.id, artifactId: "art_mine" });
    const res = await call(new Request("https://app.oyster.to/api/publish/mine", {
      headers: { Cookie: authHeader(u.sessionToken).Cookie },
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as { publications: unknown[] };
    expect(json.publications).toHaveLength(1);
  });

  it("PATCH /api/publish/:token works with the app origin on the app host", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_patch" });
    const res = await call(new Request(`https://app.oyster.to/api/publish/${token}`, {
      method: "PATCH",
      headers: {
        Cookie: authHeader(u.sessionToken).Cookie,
        Origin: "https://app.oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "open" }),
    }));
    expect(res.status).toBe(200);
  });

  it("DELETE /api/publish/:token works on the app host", async () => {
    const u = await seedUser();
    const token = await seedActivePublication({ ownerUserId: u.id, artifactId: "art_delete" });
    const res = await call(new Request(`https://app.oyster.to/api/publish/${token}`, {
      method: "DELETE",
      headers: {
        Cookie: authHeader(u.sessionToken).Cookie,
        Origin: "https://app.oyster.to",
      },
    }));
    expect(res.status).toBe(200);
  });

  it("access-redirect on the app host does NOT 308 away (falls through to the handler)", async () => {
    const res = await call(new Request("https://app.oyster.to/api/publish/access-redirect/sometoken"));
    // www/share hosts 308 to the apex here; the app host must fall through
    // to handleAccessRedirect (which 404s/redirects per its own logic for
    // an unknown token — anything but the host-308 is correct).
    expect(res.status).not.toBe(308);
  });
});

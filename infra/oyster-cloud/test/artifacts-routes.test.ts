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

function sampleArtifact(id: string, syncVersionAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    device_id: "dev-mac-01",
    device_label: "MacBook-Pro",
    label: "Quarterly notes",
    artifact_kind: "notes",
    space_id: "spc-1",
    project_id: "prj-1",
    group_name: null,
    source_origin: "ai_generated",
    created_at: "2026-06-01 10:00:00",
    updated_at: "2026-06-01 10:00:00",
    removed_at: null,
    pinned_at: null,
    sync_version_at: syncVersionAt,
    ...overrides,
  };
}

function postArtifacts(token: string, artifacts: unknown[]): Promise<Response> {
  return signedFetch("/api/artifacts/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifacts }),
  }, token);
}

describe("POST /api/artifacts/metadata", () => {
  beforeAll(async () => { await applySchema(); });

  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/artifacts/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifacts: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects free-tier users with 403", async () => {
    const { token } = await makeFreeSession();
    const res = await postArtifacts(token, []);
    expect(res.status).toBe(403);
  });

  it("accepts a valid artefact and stores it scoped to owner", async () => {
    const { token, userId } = await makeProSession();
    const aid = `a-${crypto.randomUUID()}`;
    const res = await postArtifacts(token, [sampleArtifact(aid, 1000)]);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([aid]);
    expect(body.rejected).toEqual([]);

    const row = await env.DB.prepare(
      `SELECT owner_id, label, artifact_kind, source_origin, sync_version_at, artifact_updated_at
         FROM synced_artifacts WHERE owner_id = ? AND artifact_id = ?`,
    ).bind(userId, aid).first();
    expect(row).toMatchObject({
      owner_id: userId, label: "Quarterly notes", artifact_kind: "notes",
      source_origin: "ai_generated", sync_version_at: 1000,
      artifact_updated_at: "2026-06-01 10:00:00",
    });
  });

  it("LWW: a stale sync_version_at does not overwrite a newer cloud row", async () => {
    const { token, userId } = await makeProSession();
    const aid = `a-${crypto.randomUUID()}`;
    await postArtifacts(token, [sampleArtifact(aid, 2000, { label: "v1" })]);
    await postArtifacts(token, [sampleArtifact(aid, 3000, { label: "v2" })]);
    // Stale write still gets acked (client clears its dirty flag) but loses.
    const res = await postArtifacts(token, [sampleArtifact(aid, 1000, { label: "ancient" })]);
    const body = await res.json() as { accepted: string[] };
    expect(body.accepted).toEqual([aid]);

    const row = await env.DB.prepare(
      `SELECT label, sync_version_at FROM synced_artifacts WHERE owner_id = ? AND artifact_id = ?`,
    ).bind(userId, aid).first<{ label: string; sync_version_at: number }>();
    expect(row).toMatchObject({ label: "v2", sync_version_at: 3000 });
  });

  it("rejects malformed rows individually without poisoning the batch", async () => {
    const { token, userId } = await makeProSession();
    const good = `a-${crypto.randomUUID()}`;
    const res = await postArtifacts(token, [
      sampleArtifact(good, 1000),
      { id: "", label: "no id", artifact_kind: "notes", created_at: "x", sync_version_at: 1 },
      sampleArtifact(`a-${crypto.randomUUID()}`, 1000, { label: 42 }),          // non-string label
      sampleArtifact(`a-${crypto.randomUUID()}`, Number.NaN),                   // bad LWW key
      sampleArtifact(`a-${crypto.randomUUID()}`, 1000, { space_id: ["x"] }),    // non-string nullable
    ]);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([good]);
    expect(body.rejected).toHaveLength(4);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM synced_artifacts WHERE owner_id = ?`,
    ).bind(userId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects non-finite pinned_at (1e999 parses to Infinity; NaN can't arrive via JSON)", async () => {
    const { token } = await makeProSession();
    const aid = `a-${crypto.randomUUID()}`;
    // Hand-crafted body: JSON.stringify would turn Infinity into null, which
    // is legal. 1e999 is the wire-reachable way to smuggle a non-finite in.
    const res = await signedFetch("/api/artifacts/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"artifacts":[{"id":"${aid}","label":"x","artifact_kind":"notes","created_at":"2026-06-01 10:00:00","sync_version_at":1000,"pinned_at":1e999}]}`,
    }, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: string[]; rejected: string[] };
    expect(body.accepted).toEqual([]);
    expect(body.rejected).toEqual([aid]);
  });

  it("accepts tombstones (removed_at set) — deletions propagate", async () => {
    const { token, userId } = await makeProSession();
    const aid = `a-${crypto.randomUUID()}`;
    await postArtifacts(token, [sampleArtifact(aid, 1000)]);
    const res = await postArtifacts(token, [
      sampleArtifact(aid, 2000, { removed_at: "2026-06-06 12:00:00" }),
    ]);
    const body = await res.json() as { accepted: string[] };
    expect(body.accepted).toEqual([aid]);

    const row = await env.DB.prepare(
      `SELECT removed_at FROM synced_artifacts WHERE owner_id = ? AND artifact_id = ?`,
    ).bind(userId, aid).first<{ removed_at: string | null }>();
    expect(row?.removed_at).toBe("2026-06-06 12:00:00");
  });

  it("caps the batch at 1000 artefacts with 413", async () => {
    const { token } = await makeProSession();
    const res = await postArtifacts(
      token,
      Array.from({ length: 1001 }, (_, i) => sampleArtifact(`a-${i}`, 1000)),
    );
    expect(res.status).toBe(413);
  });
});

describe("GET /api/artifacts/metadata", () => {
  beforeAll(async () => { await applySchema(); });

  it("rejects unsigned requests with 401", async () => {
    const res = await SELF.fetch("https://example.com/api/artifacts/metadata");
    expect(res.status).toBe(401);
  });

  it("rejects free-tier users with 403", async () => {
    const { token } = await makeFreeSession();
    const res = await signedFetch("/api/artifacts/metadata", {}, token);
    expect(res.status).toBe(403);
  });

  it("returns only the owner's live rows; tombstones are filtered", async () => {
    const { token, userId } = await makeProSession();
    const live = `a-${crypto.randomUUID()}`;
    const dead = `a-${crypto.randomUUID()}`;
    await postArtifacts(token, [
      sampleArtifact(live, 1000, { label: "alive", pinned_at: 777 }),
      sampleArtifact(dead, 1000, { removed_at: "2026-06-06 12:00:00" }),
    ]);
    // Another owner's artefact must not leak in.
    const other = await makeProSession();
    await postArtifacts(other.token, [sampleArtifact(`a-${crypto.randomUUID()}`, 1000)]);

    const res = await signedFetch("/api/artifacts/metadata", {}, token);
    expect(res.status).toBe(200);
    const body = await res.json() as { artifacts: Array<Record<string, unknown>> };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      artifact_id: live, label: "alive", device_label: "MacBook-Pro",
      space_id: "spc-1", pinned_at: 777,
    });
    void userId;
  });

  it("a tombstoned artefact disappears from GET after the delete propagates", async () => {
    const { token } = await makeProSession();
    const aid = `a-${crypto.randomUUID()}`;
    await postArtifacts(token, [sampleArtifact(aid, 1000)]);

    let body = await (await signedFetch("/api/artifacts/metadata", {}, token)).json() as
      { artifacts: Array<{ artifact_id: string }> };
    expect(body.artifacts.map((a) => a.artifact_id)).toContain(aid);

    await postArtifacts(token, [sampleArtifact(aid, 2000, { removed_at: "2026-06-06 12:00:00" })]);
    body = await (await signedFetch("/api/artifacts/metadata", {}, token)).json() as
      { artifacts: Array<{ artifact_id: string }> };
    expect(body.artifacts.map((a) => a.artifact_id)).not.toContain(aid);
  });
});

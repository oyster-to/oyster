import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createArtifactSyncService } from "../src/artifact-sync-service.js";
import { createProfileBindingService } from "../src/profile-binding-service.js";

// Minimal DB harness: just the columns ArtifactSyncService reads from
// artifacts (+ projects for the derived space_id, profile_binding for the
// gate, device_identity for stamping). Mirrors session-sync-service.test.ts.
function harness() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE artifacts (
      id              TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      artifact_kind   TEXT NOT NULL,
      group_name      TEXT,
      removed_at      TEXT,
      source_origin   TEXT NOT NULL DEFAULT 'manual',
      project_id      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      pinned_at       INTEGER,
      sync_dirty_at   INTEGER,
      cloud_synced_at INTEGER,
      cloud_owner_id  TEXT
    );
    CREATE TABLE projects (
      id       TEXT PRIMARY KEY,
      space_id TEXT
    );
    CREATE TABLE profile_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_owner_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    );
    CREATE TABLE device_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      label TEXT NOT NULL
    );
  `);
  const profileBinding = createProfileBindingService({ db });
  return { db, profileBinding };
}

function makeService(
  h: ReturnType<typeof harness>,
  fetchImpl: typeof fetch,
  user: { id: string; email: string; tier: string } | null = { id: "user-A", email: "a@a", tier: "pro" },
) {
  return createArtifactSyncService({
    db: h.db,
    profileBinding: h.profileBinding,
    currentUser: () => user,
    sessionToken: () => (user ? "tok" : null),
    workerBase: "https://example.com",
    fetch: fetchImpl,
  });
}

function insertDirtyArtifact(
  db: Database.Database,
  id: string,
  dirtyAt = Date.now(),
  overrides: Record<string, unknown> = {},
) {
  db.prepare(
    `INSERT INTO artifacts (id, label, artifact_kind, sync_dirty_at, project_id, removed_at, cloud_owner_id, cloud_synced_at)
     VALUES (@id, @label, @kind, @dirty, @project_id, @removed_at, @cloud_owner_id, @cloud_synced_at)`,
  ).run({
    id,
    label: `Artefact ${id}`,
    kind: "notes",
    dirty: dirtyAt,
    project_id: null,
    removed_at: null,
    cloud_owner_id: null,
    cloud_synced_at: null,
    ...overrides,
  });
}

function okAccepting(ids: () => string[]) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    void init;
    return new Response(JSON.stringify({ accepted: ids() }), { status: 200 });
  });
}

describe("ArtifactSyncService", () => {
  it("pushPending is a no-op for free users", async () => {
    const h = harness();
    insertDirtyArtifact(h.db, "a1");
    const fetchSpy = vi.fn();
    const svc = makeService(h, fetchSpy as unknown as typeof fetch, { id: "u1", email: "x@x", tier: "free" });
    expect(await svc.pushPending()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushPending is a no-op when profile is bound to a different account", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "a1");
    const fetchSpy = vi.fn();
    const svc = makeService(h, fetchSpy as unknown as typeof fetch, { id: "user-B", email: "b@b", tier: "pro" });
    expect(await svc.pushPending()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushes dirty rows with the wire shape: sync_version_at, derived space_id, device stamp", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    h.db.prepare(`INSERT INTO device_identity (id, device_id, label) VALUES (1, ?, ?)`)
      .run("dev-uuid", "MacBook-Pro");
    h.db.prepare(`INSERT INTO projects (id, space_id) VALUES ('prj-1', 'spc-1')`).run();
    insertDirtyArtifact(h.db, "a1", 1234, { project_id: "prj-1" });
    insertDirtyArtifact(h.db, "a2", 1235);  // unfiled → space_id null on the wire

    let capturedBody: string | null = null;
    const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ accepted: ["a1", "a2"] }), { status: 200 });
    });
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);
    expect(await svc.pushPending()).toBe(2);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/api/artifacts/metadata",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(capturedBody ?? "{}") as {
      artifacts: Array<Record<string, unknown>>;
    };
    expect(body.artifacts).toHaveLength(2);
    const a1 = body.artifacts.find((a) => a.id === "a1")!;
    expect(a1.sync_version_at).toBe(1234);
    expect(a1.space_id).toBe("spc-1");
    expect(a1.device_id).toBe("dev-uuid");
    expect(a1.device_label).toBe("MacBook-Pro");
    expect(a1).not.toHaveProperty("sync_dirty_at");
    const a2 = body.artifacts.find((a) => a.id === "a2")!;
    expect(a2.space_id).toBeNull();
  });

  it("marks accepted rows synced + claimed; they don't re-push", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "a1", 1000);
    const fetchSpy = okAccepting(() => ["a1"]);
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);

    expect(await svc.pushPending()).toBe(1);
    const row = h.db.prepare(
      "SELECT cloud_synced_at, cloud_owner_id FROM artifacts WHERE id='a1'",
    ).get() as { cloud_synced_at: number; cloud_owner_id: string };
    expect(row.cloud_synced_at).toBeGreaterThan(0);
    expect(row.cloud_owner_id).toBe("user-A");

    // Second drain: nothing pending, no HTTP.
    fetchSpy.mockClear();
    expect(await svc.pushPending()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a row dirtied again after ack re-pushes on the next drain", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "a1", 1000);
    const fetchSpy = okAccepting(() => ["a1"]);
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);
    await svc.pushPending();

    // Mutation after the ack: sync_dirty_at moves one ms past cloud_synced_at.
    const synced = h.db.prepare("SELECT cloud_synced_at FROM artifacts WHERE id = 'a1'")
      .get() as { cloud_synced_at: number };
    h.db.prepare("UPDATE artifacts SET sync_dirty_at = ? WHERE id = 'a1'").run(synced.cloud_synced_at + 1);
    // Let the wall clock pass the new dirty mark so the next ack clears it
    // in one batch (same-ms acks self-heal a tick later in production).
    await new Promise((r) => setTimeout(r, 5));
    fetchSpy.mockClear();
    expect(await svc.pushPending()).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const after = h.db.prepare("SELECT cloud_synced_at FROM artifacts WHERE id = 'a1'")
      .get() as { cloud_synced_at: number };
    expect(after.cloud_synced_at).toBeGreaterThan(synced.cloud_synced_at);
  });

  it("pushes tombstones (removed_at set) so deletions propagate", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "a1", 1000, { removed_at: "2026-06-06 10:00:00" });

    let capturedBody: string | null = null;
    const fetchSpy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ accepted: ["a1"] }), { status: 200 });
    });
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);
    expect(await svc.pushPending()).toBe(1);
    const body = JSON.parse(capturedBody ?? "{}") as { artifacts: Array<Record<string, unknown>> };
    expect(body.artifacts[0]!.removed_at).toBe("2026-06-06 10:00:00");
  });

  it("does not push rows owned by a different account", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "theirs", 1000, { cloud_owner_id: "user-B" });
    const fetchSpy = vi.fn();
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);
    expect(await svc.pushPending()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops draining when the server accepts nothing (no hot loop)", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "a1");
    const fetchSpy = okAccepting(() => []);
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);
    expect(await svc.pushPending()).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("network failure returns what was accepted so far without throwing", async () => {
    const h = harness();
    h.profileBinding.bindToOwner("user-A");
    insertDirtyArtifact(h.db, "a1");
    const fetchSpy = vi.fn(async () => { throw new Error("offline"); });
    const svc = makeService(h, fetchSpy as unknown as typeof fetch);
    await expect(svc.pushPending()).resolves.toBe(0);
  });
});

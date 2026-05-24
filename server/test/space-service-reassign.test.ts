import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { SqliteSpaceStore } from "../src/space-store.js";
import { SpaceService } from "../src/space-service.js";
import type { ArtifactService } from "../src/artifact-service.js";

// Minimal helpers
function makeService(db: ReturnType<typeof initDb>) {
  const artifactStore = new SqliteArtifactStore(db);
  const spaceStore = new SqliteSpaceStore(db);
  // _artifactService is discarded by SpaceService — safe to pass null
  const svc = new SpaceService(spaceStore, artifactStore, null as unknown as ArtifactService, db);
  return { svc, artifactStore, spaceStore };
}

function seedArtifact(
  db: ReturnType<typeof initDb>,
  id: string,
  projectId: string | null,
  groupName: string | null = null,
) {
  db.prepare(
    `INSERT INTO artifacts (id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, project_id, group_name)
     VALUES (?, ?, 'notes', 'filesystem', '{"path":"/x"}', 'static_file', '{}', ?, ?)`,
  ).run(id, id, projectId, groupName);
}

function ensureHomeSpace(db: ReturnType<typeof initDb>) {
  const exists = db.prepare("SELECT id FROM spaces WHERE id='home'").get();
  if (!exists) {
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('home','Home','#000','none')`);
  }
}

describe("SpaceService.deleteSpace — reassigns artifacts via project", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-svc-"));
    db = initDb(userland);
    ensureHomeSpace(db);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-work','work','work-proj')").run();
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-home','home','home-proj')").run();
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("artifact previously in deleted space derives 'home' afterward (not orphaned)", () => {
    seedArtifact(db, "a1", "p-work");
    const { svc, artifactStore } = makeService(db);

    svc.deleteSpace("work");

    const row = artifactStore.getById("a1");
    expect(row).toBeDefined();
    expect(row!.space_id).toBe("home");
  });

  it("artifact gets the folder label (deleted space display name) after deletion", () => {
    seedArtifact(db, "a2", "p-work");
    const { svc, artifactStore } = makeService(db);

    svc.deleteSpace("work");

    const row = artifactStore.getById("a2");
    expect(row!.group_name).toBe("Work"); // display_name of the deleted space
  });

  it("artifact already in home is unaffected by the deletion of another space", () => {
    seedArtifact(db, "a-home", "p-home");
    seedArtifact(db, "a-work", "p-work");
    const { svc, artifactStore } = makeService(db);

    svc.deleteSpace("work");

    const homeArtifact = artifactStore.getById("a-home");
    expect(homeArtifact!.space_id).toBe("home");
    expect(homeArtifact!.group_name).toBeNull(); // untouched
  });

  it("getBySpaceId('home') returns the moved artifact after deleteSpace", () => {
    seedArtifact(db, "a3", "p-work");
    const { svc, artifactStore } = makeService(db);

    svc.deleteSpace("work");

    const inHome = artifactStore.getBySpaceId("home").map((r) => r.id);
    expect(inHome).toContain("a3");
  });

  it("throws when deleting reserved space 'home'", () => {
    const { svc } = makeService(db);
    expect(() => svc.deleteSpace("home")).toThrow(/reserved/);
  });
});

describe("SpaceService.convertFolderToSpace — reassigns project to target space", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-cfs-"));
    db = initDb(userland);
    ensureHomeSpace(db);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('target','Target','#000','none')`);
    // Two projects in home, one per folder (folders ARE projects in the new model)
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-folder','home','my-folder')").run();
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-other','home','other-folder')").run();
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("folder artifacts derive the target space afterward via project JOIN", () => {
    seedArtifact(db, "a1", "p-folder", "MyFolder");
    seedArtifact(db, "a2", "p-folder", "MyFolder");
    const { svc, artifactStore } = makeService(db);

    svc.convertFolderToSpace("home", "MyFolder", "target");

    expect(artifactStore.getById("a1")!.space_id).toBe("target");
    expect(artifactStore.getById("a2")!.space_id).toBe("target");
  });

  it("group_name is cleared on converted artifacts", () => {
    seedArtifact(db, "a3", "p-folder", "MyFolder");
    const { svc, artifactStore } = makeService(db);

    svc.convertFolderToSpace("home", "MyFolder", "target");

    expect(artifactStore.getById("a3")!.group_name).toBeNull();
  });

  it("getBySpaceId('target') returns the converted artifacts", () => {
    seedArtifact(db, "a4", "p-folder", "MyFolder");
    const { svc, artifactStore } = makeService(db);

    svc.convertFolderToSpace("home", "MyFolder", "target");

    const inTarget = artifactStore.getBySpaceId("target").map((r) => r.id);
    expect(inTarget).toContain("a4");
  });

  it("artifacts in a different project/folder are unaffected", () => {
    seedArtifact(db, "a5", "p-folder", "MyFolder");
    // a6 belongs to a DIFFERENT project (different folder = different project)
    seedArtifact(db, "a6", "p-other", "OtherFolder");
    const { svc, artifactStore } = makeService(db);

    svc.convertFolderToSpace("home", "MyFolder", "target");

    // OtherFolder artifact stays in home (its project was not moved)
    expect(artifactStore.getById("a6")!.space_id).toBe("home");
    expect(artifactStore.getById("a6")!.group_name).toBe("OtherFolder");
  });
});

describe("SpaceService session sync on deleteSpace / convertFolderToSpace", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-sess-"));
    db = initDb(userland);
    ensureHomeSpace(db);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('target','Target','#000','none')`);
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-work','work','work-proj')").run();
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-home','home','home-proj')").run();
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-folder','home','my-folder')").run();
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("deleteSpace: session in deleted space is moved to home", () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, state, space_id, project_id) VALUES ('s-work', 'claude-code', 'done', 'work', 'p-work')`,
    ).run();

    const { svc } = makeService(db);
    svc.deleteSpace("work");

    const row = db.prepare("SELECT space_id FROM sessions WHERE id = 's-work'").get() as { space_id: string };
    expect(row.space_id).toBe("home");
  });

  it("deleteSpace: session in a different space is unaffected", () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, state, space_id, project_id) VALUES ('s-home', 'claude-code', 'done', 'home', 'p-home')`,
    ).run();

    const { svc } = makeService(db);
    svc.deleteSpace("work");

    const row = db.prepare("SELECT space_id FROM sessions WHERE id = 's-home'").get() as { space_id: string };
    expect(row.space_id).toBe("home"); // unchanged
  });

  it("convertFolderToSpace: session bound to converted project gets targetSpaceId", () => {
    seedArtifact(db, "a-folder", "p-folder", "MyFolder");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, space_id, project_id) VALUES ('s-folder', 'claude-code', 'done', 'home', 'p-folder')`,
    ).run();

    const { svc } = makeService(db);
    svc.convertFolderToSpace("home", "MyFolder", "target");

    const row = db.prepare("SELECT space_id FROM sessions WHERE id = 's-folder'").get() as { space_id: string };
    expect(row.space_id).toBe("target");
  });

  it("convertFolderToSpace: session bound to unaffected project keeps its space", () => {
    seedArtifact(db, "a-folder", "p-folder", "MyFolder");
    db.prepare(
      `INSERT INTO sessions (id, agent, state, space_id, project_id) VALUES ('s-other', 'claude-code', 'done', 'home', 'p-home')`,
    ).run();

    const { svc } = makeService(db);
    svc.convertFolderToSpace("home", "MyFolder", "target");

    const row = db.prepare("SELECT space_id FROM sessions WHERE id = 's-other'").get() as { space_id: string };
    expect(row.space_id).toBe("home"); // unchanged
  });
});

// Tests that ArtifactService.registerArtifact resolves project_id (and
// hence spaceId) automatically via lookupProject when no project_id is
// supplied, and falls back to '' for orphan paths.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

describe("ArtifactService.registerArtifact — project_id resolution via lookupProject", () => {
  let userland: string;
  let projectDir: string;
  let orphanDir: string;
  let db: Database.Database;
  let service: ArtifactService;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-svc-proj-"));
    projectDir = mkdtempSync(join(tmpdir(), "oyster-projdir-"));
    orphanDir = mkdtempSync(join(tmpdir(), "oyster-orphan-"));
    db = initDb(userland);

    // Seed a space and a project with a project_paths entry so lookupProject
    // step-2 can resolve files under projectDir.
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p1', 'work', 'Test Project')`);
    db.exec(`INSERT INTO project_paths (project_id, path) VALUES ('p1', '${projectDir}')`);

    service = new ArtifactService(
      db,
      new SqliteArtifactStore(db),
      "https://oyster.to",
      "https://share.oyster.to",
      userland,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(userland, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(orphanDir, { recursive: true, force: true });
  });

  it("resolves spaceId from project when file is under a project_paths entry (no project_id passed)", async () => {
    const filePath = join(projectDir, "notes.md");
    writeFileSync(filePath, "# hello");

    const art = await service.registerArtifact({ path: filePath, label: "Notes" }, []);

    expect(art.spaceId).toBe("work");
    expect(art.projectId).toBe("p1");
  });

  it("resolves to spaceId '' when file is under no known project", async () => {
    const filePath = join(orphanDir, "readme.md");
    writeFileSync(filePath, "# orphan");

    const art = await service.registerArtifact({ path: filePath, label: "Readme" }, []);

    expect(art.spaceId).toBe("");
    expect(art.projectId).toBeNull();
  });

  it("uses the supplied project_id when explicitly provided, ignoring the file path", async () => {
    // File lives under orphanDir (no project there), but we override with p1.
    const filePath = join(orphanDir, "override.md");
    writeFileSync(filePath, "# override");

    const art = await service.registerArtifact({ path: filePath, label: "Override", project_id: "p1" }, []);

    expect(art.spaceId).toBe("work");
    expect(art.projectId).toBe("p1");
  });

  it("allows null project_id to be passed explicitly (orphan regardless of path)", async () => {
    // File is under projectDir (would resolve p1), but project_id: null overrides.
    const filePath = join(projectDir, "forced-orphan.md");
    writeFileSync(filePath, "# forced orphan");

    const art = await service.registerArtifact({ path: filePath, label: "Forced orphan", project_id: null }, []);

    expect(art.spaceId).toBe("");
    expect(art.projectId).toBeNull();
  });
});

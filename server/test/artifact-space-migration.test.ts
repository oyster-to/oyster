import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { backfillArtifactProjects } from "../src/artifact-space-migration.js";

function seedArtifact(db: ReturnType<typeof initDb>, id: string, spaceId: string, path: string, projectId: string | null = null) {
  db.prepare(
    `INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, project_id)
     VALUES (?, ?, ?, 'notes', 'filesystem', ?, 'static_file', '{}', ?)`,
  ).run(id, spaceId, id, JSON.stringify({ path }), projectId);
}

describe("backfillArtifactProjects", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-asm-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none'),('home','Home','#111','none')`);
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-repo','work','repo')").run();
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES ('p-repo','/repo')").run();
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("backfills project_id from longest-prefix path, makes native projects, reports counts + mismatches", () => {
    seedArtifact(db, "a-repo", "work", "/repo/docs/report.md");           // resolves to p-repo (space work — matches)
    seedArtifact(db, "a-mismatch", "home", "/repo/docs/other.md");         // resolves to p-repo (space work) — mismatch vs 'home'
    seedArtifact(db, "a-native", "work", join(userland, "spaces", "work", "note.md")); // native folder → native project
    seedArtifact(db, "a-orphan", "home", "/elsewhere/loose.md");           // no project → stays null
    // pre-existing project_id whose old space disagrees with the project's space:
    seedArtifact(db, "a-pre", "home", "/repo/docs/pre.md", "p-repo");      // project p-repo (space work) ≠ old 'home'

    const report = backfillArtifactProjects(db, userland);

    expect(db.prepare("SELECT project_id FROM artifacts WHERE id='a-repo'").get()).toEqual({ project_id: "p-repo" });
    const nativePid = (db.prepare("SELECT project_id FROM artifacts WHERE id='a-native'").get() as { project_id: string }).project_id;
    expect(nativePid).toBeTruthy();
    expect(db.prepare("SELECT space_id FROM projects WHERE id=?").get(nativePid)).toEqual({ space_id: "work" });
    expect(db.prepare("SELECT project_id FROM artifacts WHERE id='a-orphan'").get()).toEqual({ project_id: null });

    expect(report.total).toBe(5);
    expect(report.backfilled).toBe(3);       // repo, mismatch, native (a-orphan unresolved, a-pre already had project)
    expect(report.stillOrphan).toBe(1);      // a-orphan
    const mmIds = report.mismatches.map((m) => m.id);
    expect(mmIds).toContain("a-mismatch");   // newly backfilled, space disagrees
    expect(mmIds).toContain("a-pre");        // pre-existing project, space disagrees
  });
});

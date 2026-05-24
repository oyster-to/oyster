import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { backfillArtifactProjects, dropArtifactSpaceColumn } from "../src/artifact-space-migration.js";

// Helper to insert test artifacts; _spaceId is kept for call-site readability (documents pre-migration space) but is intentionally not inserted.
function seedArtifact(db: ReturnType<typeof initDb>, id: string, _spaceId: string, path: string, projectId: string | null = null) {
  db.prepare(
    `INSERT INTO artifacts (id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, project_id)
     VALUES (?, ?, 'notes', 'filesystem', ?, 'static_file', '{}', ?)`,
  ).run(id, id, JSON.stringify({ path }), projectId);
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

  it("native artifacts resolve correctly when dbDir and oysterHome are distinct dirs", () => {
    // Simulate the production layout: dbDir = oysterHome/db, oysterHome != dbDir.
    // The DB lives at oysterHome/db/oyster.db, native artifacts at oysterHome/spaces/<id>/.
    // Previously initDb forwarded dbDir to the migration, so nativeRoot was
    // oysterHome/db/spaces — and every native-workspace artifact silently stayed orphan.
    const oysterHome = mkdtempSync(join(tmpdir(), "oyster-home-"));
    const dbDir = join(oysterHome, "db");
    mkdirSync(dbDir, { recursive: true });
    let distinctDb: ReturnType<typeof initDb> | undefined;
    try {
      distinctDb = initDb(dbDir, oysterHome);
      distinctDb.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
      const nativePath = join(oysterHome, "spaces", "work", "note.md");
      distinctDb.prepare(
        `INSERT INTO artifacts (id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config)
         VALUES ('a-native-dist', 'note', 'notes', 'filesystem', ?, 'static_file', '{}')`,
      ).run(JSON.stringify({ path: nativePath }));

      const report = backfillArtifactProjects(distinctDb, oysterHome);

      // The native artifact must have been assigned a project_id (not orphaned).
      const row = distinctDb.prepare("SELECT project_id FROM artifacts WHERE id='a-native-dist'").get() as { project_id: string | null };
      expect(row.project_id).toBeTruthy();
      expect(report.stillOrphan).toBe(0);
    } finally {
      distinctDb?.close();
      rmSync(oysterHome, { recursive: true, force: true });
    }
  });

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
    // space_id column is dropped by initDb before seeds run; mismatch detection
    // requires the column and is skipped — mismatches is empty.
    expect(report.mismatches).toHaveLength(0);
  });

  it("drops space_id and is idempotent", () => {
    seedArtifact(db, "a-repo", "work", "/repo/r.md");
    backfillArtifactProjects(db, userland);
    dropArtifactSpaceColumn(db);
    const cols = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("space_id");
    expect(() => dropArtifactSpaceColumn(db)).not.toThrow(); // idempotent
  });

  it("underscore in project path does not wildcard-match sibling paths (LIKE escape fix)", () => {
    // Project root: /a/my_proj  — the underscore must NOT act as a LIKE wildcard.
    // An artifact at /a/myXproj/f.md must NOT resolve to this project.
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-under','work','underscore')").run();
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES ('p-under','/a/my_proj')").run();
    seedArtifact(db, "a-nomatch", "work", "/a/myXproj/f.md");  // 'X' replaces '_' in the path
    seedArtifact(db, "a-match",   "work", "/a/my_proj/f.md");  // genuine child — must match

    backfillArtifactProjects(db, userland);

    // The sibling path must NOT resolve to p-under
    expect(db.prepare("SELECT project_id FROM artifacts WHERE id='a-nomatch'").get()).toEqual({ project_id: null });
    // The genuine child must resolve correctly
    expect(db.prepare("SELECT project_id FROM artifacts WHERE id='a-match'").get()).toEqual({ project_id: "p-under" });
  });

  it("re-keyed dedup index: same source_ref same project rejected; orphans allowed", () => {
    backfillArtifactProjects(db, userland);
    dropArtifactSpaceColumn(db);
    const ins = (id: string, projectId: string | null, ref: string) => db.prepare(
      `INSERT INTO artifacts (id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config,source_ref,project_id)
       VALUES (?,?, 'notes','filesystem','{}','static_file','{}',?,?)`).run(id, id, ref, projectId);
    ins("x1", "p-repo", "README.md:notes");
    expect(() => ins("x2", "p-repo", "README.md:notes")).toThrow(); // same project+ref → UNIQUE violation
    expect(() => ins("x3", null, "README.md:notes")).not.toThrow(); // orphan
    expect(() => ins("x4", null, "README.md:notes")).not.toThrow(); // orphan NULLs distinct (intentional)
  });

  it("reports a stored space_id that disagrees with the resolved project's space (column present)", () => {
    // Build a minimal schema WITH artifacts.space_id present (mimics a pre-migration DB),
    // WITHOUT initDb (which would drop the column).
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, display_name TEXT, color TEXT, scan_status TEXT);
      CREATE TABLE projects (id TEXT PRIMARY KEY, space_id TEXT, name TEXT);
      CREATE TABLE project_paths (project_id TEXT, path TEXT);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT,
        label TEXT, artifact_kind TEXT, storage_kind TEXT,
        storage_config TEXT, runtime_kind TEXT, runtime_config TEXT,
        source_ref TEXT, removed_at TEXT
      );
    `);
    mem.exec(`INSERT INTO spaces (id,display_name,color,scan_status) VALUES ('work','Work','#000','none'),('home','Home','#111','none')`);
    mem.prepare("INSERT INTO projects (id,space_id,name) VALUES ('p-repo','work','repo')").run();
    mem.prepare("INSERT INTO project_paths (project_id,path) VALUES ('p-repo','/repo')").run();
    // artifact stored under space 'home' but its path resolves to p-repo (space 'work') → mismatch
    mem.prepare(`INSERT INTO artifacts (id,space_id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config)
                 VALUES ('a-mm','home','x','notes','filesystem',?, 'static_file','{}')`).run(JSON.stringify({ path: "/repo/x.md" }));

    const report = backfillArtifactProjects(mem, "/tmp/whatever-oyster-home");
    expect(report.backfilled).toBe(1);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({ id: "a-mm", oldSpace: "home", newSpace: "work" });
    mem.close();
  });
});

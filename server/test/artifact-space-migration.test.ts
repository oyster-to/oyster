import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { backfillArtifactProjects, dropArtifactSpaceColumn } from "../src/artifact-space-migration.js";
import { ensureNativeProject } from "../src/native-project.js";

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

  it("Windows-style backslash path separator: artifact under project resolves correctly", () => {
    // Project path uses backslash separators (Windows). A child artifact using
    // `\` must resolve to the project; a sibling at the same depth must NOT.
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, display_name TEXT, color TEXT, scan_status TEXT);
      CREATE TABLE projects (id TEXT PRIMARY KEY, space_id TEXT, name TEXT);
      CREATE TABLE project_paths (project_id TEXT, path TEXT);
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, project_id TEXT,
        label TEXT, artifact_kind TEXT, storage_kind TEXT,
        storage_config TEXT, runtime_kind TEXT, runtime_config TEXT,
        source_ref TEXT, removed_at TEXT
      );
    `);
    mem.exec(`INSERT INTO spaces (id,display_name,color,scan_status) VALUES ('w','W','#000','none')`);
    mem.prepare("INSERT INTO projects (id,space_id,name) VALUES ('p-win','w','win-proj')").run();
    // Project path uses single backslash separator (Windows style: C:\proj).
    // In JS string, `\\` = one backslash character stored in SQLite.
    mem.prepare("INSERT INTO project_paths (project_id,path) VALUES ('p-win','C:\\proj')").run();

    // Child artifact: C:\proj\file.md — should match p-win via backslash clause.
    mem.prepare(`INSERT INTO artifacts (id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config)
                 VALUES ('a-child','f','notes','filesystem',?,'static_file','{}')`).run(JSON.stringify({ path: "C:\\proj\\file.md" }));
    // Sibling artifact: C:\proj-other\file.md — must NOT match p-win.
    mem.prepare(`INSERT INTO artifacts (id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config)
                 VALUES ('a-sibling','g','notes','filesystem',?,'static_file','{}')`).run(JSON.stringify({ path: "C:\\proj-other\\file.md" }));

    backfillArtifactProjects(mem, "/irrelevant");

    expect((mem.prepare("SELECT project_id FROM artifacts WHERE id='a-child'").get() as { project_id: string | null }).project_id).toBe("p-win");
    expect((mem.prepare("SELECT project_id FROM artifacts WHERE id='a-sibling'").get() as { project_id: string | null }).project_id).toBeNull();
    mem.close();
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

describe("FK ordering regression: seed spaces before backfill", () => {
  it("ensureNativeProject does NOT throw FK error when spaces row is seeded first", () => {
    // Simulates the pre-migration state: empty `spaces` table, artifact with a
    // space_id that has no corresponding `spaces` row yet. The old ordering
    // called backfillArtifactProjects (which calls ensureNativeProject → INSERT
    // into projects(space_id=?)) BEFORE seeding spaces from artifacts.space_id,
    // causing a FK violation when foreign_keys=ON. The fix seeds spaces first.
    //
    // This test drives the functions in the CORRECT order (seed → ensure) and
    // verifies no FK error. A companion assertion proves the WRONG order fails.

    const mem = new Database(":memory:");
    mem.pragma("foreign_keys = ON");
    mem.exec(`
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        removed_at TEXT
      );
      CREATE TABLE project_paths (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, path)
      );
    `);

    const spaceId = "s1";
    const oysterHome = mkdtempSync(join(tmpdir(), "oyster-fktest-"));
    try {
      // Seed the space row FIRST (correct order).
      mem.exec(`INSERT OR IGNORE INTO spaces (id, display_name) VALUES ('${spaceId}', '${spaceId}')`);

      // Now ensureNativeProject should succeed — space row exists.
      expect(() => ensureNativeProject(mem, oysterHome, spaceId)).not.toThrow();

      // Sanity: the native project was actually created.
      const rows = mem.prepare("SELECT id FROM projects WHERE space_id = ?").all(spaceId) as { id: string }[];
      expect(rows.length).toBe(1);
    } finally {
      mem.close();
      rmSync(oysterHome, { recursive: true, force: true });
    }
  });

  it("ensureNativeProject DOES throw FK error when spaces row is absent (proves reorder necessity)", () => {
    // Wrong order: call ensureNativeProject before the space row exists.
    const mem = new Database(":memory:");
    mem.pragma("foreign_keys = ON");
    mem.exec(`
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        removed_at TEXT
      );
      CREATE TABLE project_paths (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, path)
      );
    `);

    const oysterHome = mkdtempSync(join(tmpdir(), "oyster-fktest2-"));
    try {
      // spaces table is empty — ensureNativeProject's INSERT INTO projects
      // references a non-existent space_id, which violates the FK.
      expect(() => ensureNativeProject(mem, oysterHome, "nonexistent-space")).toThrow();
    } finally {
      mem.close();
      rmSync(oysterHome, { recursive: true, force: true });
    }
  });

  it("initDb does NOT throw when legacy DB has artifacts referencing a space not yet in spaces table", () => {
    // Full-stack regression: build a DB file that looks like a legacy install
    // (space_id column present, spaces table empty, artifact referencing a
    // space) and call initDb. Before the fix, this threw an FK error during
    // backfillArtifactProjects. After the fix it must succeed.
    const oysterHome = mkdtempSync(join(tmpdir(), "oyster-fkfull-"));
    const dbDir = join(oysterHome, "db");
    mkdirSync(dbDir, { recursive: true });

    // 1. Create a raw DB that looks like pre-migration state: space_id column
    //    present on artifacts, spaces table empty, artifact with space_id set.
    const legacySpaceId = "myspace";
    {
      const raw = new Database(join(dbDir, "oyster.db"));
      raw.pragma("foreign_keys = OFF"); // no FK enforcement during manual setup
      raw.exec(`
        CREATE TABLE spaces (
          id TEXT PRIMARY KEY, display_name TEXT NOT NULL, color TEXT,
          scan_status TEXT NOT NULL DEFAULT 'none',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, space_id TEXT, project_id TEXT,
          label TEXT NOT NULL, artifact_kind TEXT NOT NULL,
          storage_kind TEXT NOT NULL, storage_config TEXT NOT NULL DEFAULT '{}',
          runtime_kind TEXT NOT NULL, runtime_config TEXT NOT NULL DEFAULT '{}',
          source_origin TEXT NOT NULL DEFAULT 'manual', source_ref TEXT,
          removed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // Native workspace artifact — space_id set, but spaces table empty.
      const nativePath = join(oysterHome, "spaces", legacySpaceId, "note.md");
      mkdirSync(join(oysterHome, "spaces", legacySpaceId), { recursive: true });
      writeFileSync(nativePath, "# hello");
      raw.prepare(
        `INSERT INTO artifacts (id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, space_id)
         VALUES ('a1', 'note', 'notes', 'filesystem', ?, 'static_file', '{}', ?)`,
      ).run(JSON.stringify({ path: nativePath }), legacySpaceId);
      raw.close();
    }

    // 2. Call initDb — must NOT throw.
    let db: ReturnType<typeof initDb> | undefined;
    try {
      expect(() => { db = initDb(dbDir, oysterHome); }).not.toThrow();
      // The spaces table must now have the legacy space id (seeded from artifact.space_id).
      const spaceRow = db!.prepare("SELECT id FROM spaces WHERE id = ?").get(legacySpaceId) as { id: string } | undefined;
      expect(spaceRow?.id).toBe(legacySpaceId);
      // The artifact must have been assigned a project_id (backfill succeeded).
      const artRow = db!.prepare("SELECT project_id FROM artifacts WHERE id = 'a1'").get() as { project_id: string | null };
      expect(artRow.project_id).toBeTruthy();
    } finally {
      db?.close();
      rmSync(oysterHome, { recursive: true, force: true });
    }
  });
});

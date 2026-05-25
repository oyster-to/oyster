// Migration guard: projects.space_id NOT NULL → nullable.
//
// Older DBs (and fresh installs of the version that shipped the NOT NULL
// CREATE) have a NOT NULL space_id. The "remove project from space" feature
// needs it nullable. initDb rebuilds the table via the 12-step pattern when
// it detects the old constraint. This proves the rebuild preserves rows and
// keeps inbound FKs (sessions.project_id → projects) resolving — the bit
// most likely to surprise — and that space_id can then go NULL.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("projects.space_id NOT NULL → nullable migration", () => {
  it("rebuilds a NOT NULL projects table to nullable, preserving rows + bound sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-projmig-"));
    try {
      // 1. Full current schema, then force projects back to the OLD NOT NULL
      //    shape so initDb's migration has something to convert on reopen.
      let db = initDb(dir);
      db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
      db.pragma("foreign_keys = OFF");
      db.exec(`
        BEGIN;
        CREATE TABLE _projects_old (
          id          TEXT PRIMARY KEY,
          space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          removed_at  TEXT
        );
        INSERT INTO _projects_old (id, space_id, name) SELECT id, space_id, name FROM projects;
        DROP TABLE projects;
        ALTER TABLE _projects_old RENAME TO projects;
        COMMIT;
      `);
      db.pragma("foreign_keys = ON");
      db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p1','work','Proj')`);
      db.exec(`INSERT INTO sessions (id, agent, state, cwd, project_id, space_id) VALUES ('s1','claude-code','done','/x','p1','work')`);

      const before = (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === "space_id");
      expect(before?.notnull).toBe(1); // simulated old state really is NOT NULL
      db.close();

      // 2. Reopen — initDb detects NOT NULL and rebuilds to nullable.
      db = initDb(dir);
      const after = (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string; notnull: number }>)
        .find((c) => c.name === "space_id");
      expect(after?.notnull).toBe(0);

      // Rows preserved.
      expect(db.prepare("SELECT id, space_id, name FROM projects WHERE id='p1'").get())
        .toEqual({ id: "p1", space_id: "work", name: "Proj" });
      // Inbound FK still resolves: the bound session survived the drop+rename.
      expect((db.prepare("SELECT project_id FROM sessions WHERE id='s1'").get() as { project_id: string }).project_id)
        .toBe("p1");
      // The payoff: space_id can now be NULL.
      db.exec("UPDATE projects SET space_id = NULL WHERE id='p1'");
      expect((db.prepare("SELECT space_id FROM projects WHERE id='p1'").get() as { space_id: string | null }).space_id)
        .toBeNull();

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when space_id is already nullable (idempotent reopen)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-projmig-noop-"));
    try {
      let db = initDb(dir);
      db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
      db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p1',NULL,'Unassigned')`); // only valid if nullable
      db.close();

      db = initDb(dir); // second pass must not disturb the NULL row
      expect((db.prepare("SELECT space_id FROM projects WHERE id='p1'").get() as { space_id: string | null }).space_id)
        .toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

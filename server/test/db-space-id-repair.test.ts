// Repair migration for the inconsistency where a session has a valid
// project_id but a stale (NULL or different) space_id. Came up after an
// UPDATE-FROM order bug in an earlier ad-hoc dedup SQL silently set
// space_id to NULL while moving sessions between merged projects. The
// FK can't enforce "space_id must equal projects.space_id" — that's
// app-level consistency, so the migration heals it at boot.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("initDb space_id repair", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "oyster-repair-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("syncs sessions.space_id from project's space when they disagree (NULL case)", () => {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('oyster', 'Oyster', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'oyster', 'Proj')`);
    // The bad state: project_id set, space_id NULL — orphan in UI even
    // though the binding to the project is valid.
    db.exec(`INSERT INTO sessions (id, agent, state, cwd, project_id, space_id) VALUES ('s', 'claude-code', 'done', '/foo', '11111111-1111-1111-1111-111111111111', NULL)`);
    db.close();

    // Re-open → migrations run → repair fires
    const db2 = initDb(dir);
    const row = db2.prepare("SELECT space_id FROM sessions WHERE id = 's'").get() as { space_id: string };
    expect(row.space_id).toBe("oyster");
    db2.close();
  });

  it("artefacts no longer have a stored space_id (column dropped by initDb)", () => {
    // artifacts.space_id was dropped as part of the artifact→project model
    // refactor; space is now derived at read-time via project JOIN. Verify
    // the column is absent after initDb runs.
    const db = initDb(dir);
    const cols = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("space_id");
    db.close();
  });

  it("leaves space_id alone when project is soft-deleted (don't re-bind to a tombstone)", () => {
    const db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('oyster', 'Oyster', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name, removed_at) VALUES ('33333333-3333-3333-3333-333333333333', 'oyster', 'Dead', datetime('now'))`);
    db.exec(`INSERT INTO sessions (id, agent, state, cwd, project_id, space_id) VALUES ('s', 'claude-code', 'done', '/foo', '33333333-3333-3333-3333-333333333333', NULL)`);
    db.close();

    const db2 = initDb(dir);
    const row = db2.prepare("SELECT space_id FROM sessions WHERE id = 's'").get() as { space_id: string | null };
    expect(row.space_id).toBeNull(); // unchanged
    db2.close();
  });
});

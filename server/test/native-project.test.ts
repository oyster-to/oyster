import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { ensureNativeProject } from "../src/native-project.js";

describe("ensureNativeProject", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-np-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("creates a project bound to the space with the native folder path, idempotently", () => {
    const id1 = ensureNativeProject(db, userland, "work");
    const id2 = ensureNativeProject(db, userland, "work");
    expect(id1).toBe(id2); // idempotent — same project reused

    const proj = db.prepare("SELECT space_id FROM projects WHERE id = ?").get(id1) as { space_id: string };
    expect(proj.space_id).toBe("work");

    const path = db.prepare("SELECT path FROM project_paths WHERE project_id = ?").get(id1) as { path: string };
    expect(path.path).toBe(join(userland, "spaces", "work"));
  });

  it("creates the native folder on disk", () => {
    const id = ensureNativeProject(db, userland, "work");
    expect(existsSync(join(userland, "spaces", "work"))).toBe(true);
    expect(id).toBeTruthy();
  });
});

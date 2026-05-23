import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ProjectService } from "../src/project-service.js";

describe("ProjectService.getOrCreateByCwd", () => {
  let dir: string;
  let db: Database.Database;
  let service: ProjectService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-gocbc-"));
    db = initDb(dir);
    // A space exists so we can test the "already in a space" case.
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work', 'Work', '#000', 'none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("creates an orphan project on first call (space_id=NULL, name=basename)", () => {
    const result = service.getOrCreateByCwd("/Users/matt/Dev/my-project");

    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(result.spaceId).toBeNull();
    expect(result.name).toBe("my-project");

    const row = db.prepare("SELECT id, space_id, name FROM projects WHERE id = ?").get(result.id) as { id: string; space_id: string | null; name: string };
    expect(row.space_id).toBeNull();
    expect(row.name).toBe("my-project");
  });

  it("seeds project_paths so the cwd is cached for future lookups", () => {
    const result = service.getOrCreateByCwd("/Users/matt/Dev/my-project");

    const path = db.prepare("SELECT path FROM project_paths WHERE project_id = ?").get(result.id) as { path: string } | undefined;
    expect(path?.path).toBe("/Users/matt/Dev/my-project");
  });

  it("returns the same project on subsequent calls for the same cwd (idempotent)", () => {
    const first = service.getOrCreateByCwd("/Users/matt/Dev/my-project");
    const second = service.getOrCreateByCwd("/Users/matt/Dev/my-project");

    expect(second.id).toBe(first.id);
    // Only one row in project_paths.
    const paths = db.prepare("SELECT path FROM project_paths WHERE project_id = ?").all(first.id) as Array<{ path: string }>;
    expect(paths).toHaveLength(1);
  });

  it("returns the existing project when path already attached to a space", () => {
    // Simulate a project that was attached to a space via attachFolder.
    const spacedProject = service.createProject({ spaceId: "work", name: "My Project" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(spacedProject.id, "/Users/matt/Dev/spaced");

    const result = service.getOrCreateByCwd("/Users/matt/Dev/spaced");

    expect(result.id).toBe(spacedProject.id);
    expect(result.spaceId).toBe("work");
    // No new project created.
    const count = (db.prepare("SELECT COUNT(*) AS n FROM projects WHERE removed_at IS NULL").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("throws on an empty cwd", () => {
    expect(() => service.getOrCreateByCwd("")).toThrow();
    expect(() => service.getOrCreateByCwd("   ")).toThrow();
  });

  it("uses basename for the project name when given a POSIX path", () => {
    const result = service.getOrCreateByCwd("/some/deeply/nested/folder-name");
    expect(result.name).toBe("folder-name");
  });

  it("uses basename for the project name when given a Windows-style path", () => {
    const result = service.getOrCreateByCwd("C:\\Users\\matt\\Dev\\win-project");
    expect(result.name).toBe("win-project");
  });
});

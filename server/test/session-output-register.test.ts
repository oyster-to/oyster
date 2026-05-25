// Integration tests for registerTouchedOutput — the shared handler that
// classifies a session file touch, registers an artefact (if it qualifies),
// and links it to the session via session_artifacts.
//
// Mirrors the ArtifactService construction pattern from
// artifact-service-project.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { registerTouchedOutput } from "../src/session-output-sweep.js";
import type { SweepDeps, Touch } from "../src/session-output-sweep.js";

describe("registerTouchedOutput", () => {
  let userland: string;
  let repoDir: string;
  let db: Database.Database;
  let service: ArtifactService;
  let sessionStore: SqliteSessionStore;
  let deps: SweepDeps;

  beforeEach(() => {
    userland = mkdtempSync(join(homedir(), "oyster-test-"));
    repoDir = mkdtempSync(join(homedir(), "oyster-test-"));
    db = initDb(userland);

    // Seed: space s, project p (space s), project_paths row mapping repoDir → p.
    // This lets lookupProject resolve files under repoDir to project p via the
    // cache fallback (step 2 in lookupProject.ts).
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('s', 'Space', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p', 's', 'Repo Project')`);
    db.exec(`INSERT INTO project_paths (project_id, path) VALUES ('p', '${repoDir}')`);

    // Session sess belongs to project p.
    db.exec(`INSERT INTO sessions (id, space_id, project_id, agent, state, title)
             VALUES ('sess', 's', 'p', 'claude-code', 'done', 'Test session')`);

    // Second space + project p2 and session sess2. sess2.project_id = p2, and
    // its cwd is NOT under repoDir (so path-wins test shows p takes priority).
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('s2', 'Space2', '#111', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p2', 's2', 'Other Project')`);
    db.exec(`INSERT INTO sessions (id, space_id, project_id, agent, state, title)
             VALUES ('sess2', 's2', 'p2', 'claude-code', 'done', 'Other session')`);

    service = new ArtifactService(
      db,
      new SqliteArtifactStore(db),
      "https://oyster.to",
      "https://share.oyster.to",
      userland,
    );
    sessionStore = new SqliteSessionStore(db);
    deps = { db, service, sessionStore };
  });

  afterEach(() => {
    db.close();
    rmSync(userland, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  // ── Test 1: create a notes file → artefact registered, link created ──

  it("registers a notes artefact for a created .md file under the repo dir", async () => {
    const filePath = join(repoDir, "report.md");
    writeFileSync(filePath, "# Report");

    const touch: Touch = {
      sessionId: "sess",
      path: filePath,
      role: "create",
      whenAt: "2024-01-01T10:00:00Z",
    };
    await registerTouchedOutput(deps, touch);

    // Artefact should exist, parented to project p (resolved from path).
    const art = (db.prepare(
      `SELECT a.*
         FROM artifacts a
        WHERE json_extract(a.storage_config, '$.path') = ?
          AND a.removed_at IS NULL`,
    ).get(filePath)) as { id: string; artifact_kind: string; source_origin: string; project_id: string } | undefined;

    expect(art).toBeDefined();
    expect(art!.artifact_kind).toBe("notes");
    expect(art!.source_origin).toBe("discovered");
    expect(art!.project_id).toBe("p");

    // session_artifacts link should exist with role=create.
    const link = (db.prepare(
      "SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ? AND role = ?",
    ).get("sess", art!.id, "create")) as { id: number } | undefined;
    expect(link).toBeDefined();
  });

  // ── Test 2: source file (.tsx) → no artefact, no throw, no link ──

  it("does not register an artefact for a source code file", async () => {
    const srcDir = join(repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const filePath = join(srcDir, "App.tsx");
    writeFileSync(filePath, "export default function App() {}");

    const touch: Touch = {
      sessionId: "sess",
      path: filePath,
      role: "modify",
      whenAt: "2024-01-01T10:01:00Z",
    };
    const result = await registerTouchedOutput(deps, touch);
    expect(result).toEqual({ registered: false, linked: false });

    const count = (db.prepare("SELECT COUNT(*) as n FROM artifacts").get()) as { n: number };
    expect(count.n).toBe(0);

    const links = (db.prepare("SELECT COUNT(*) as n FROM session_artifacts").get()) as { n: number };
    expect(links.n).toBe(0);
  });

  // ── Test 3: second touch of the same file → same artefact reused, new link ──

  it("reuses an existing artefact and adds a second link on a second touch", async () => {
    const filePath = join(repoDir, "report.md");
    writeFileSync(filePath, "# Report");

    await registerTouchedOutput(deps, {
      sessionId: "sess",
      path: filePath,
      role: "create",
      whenAt: "2024-01-01T10:00:00Z",
    });

    await registerTouchedOutput(deps, {
      sessionId: "sess",
      path: filePath,
      role: "modify",
      whenAt: "2024-01-01T10:05:00Z",
    });

    // Still only one artefact row.
    const artCount = (db.prepare(
      "SELECT COUNT(*) as n FROM artifacts WHERE json_extract(storage_config,'$.path') = ? AND removed_at IS NULL",
    ).get(filePath)) as { n: number };
    expect(artCount.n).toBe(1);

    // Two session_artifacts links (one per role).
    const links = (db.prepare(
      "SELECT role FROM session_artifacts WHERE session_id = 'sess' ORDER BY when_at",
    ).all()) as Array<{ role: string }>;
    expect(links).toHaveLength(2);
    expect(links.map((r) => r.role)).toEqual(["create", "modify"]);
  });

  // ── Test 4: same stem, different path → separate artefact (UUID fix) ──

  it("registers a SEPARATE artefact for a same-stem file in a different subdir (no collision)", async () => {
    const filePath1 = join(repoDir, "report.md");
    const subDir = join(repoDir, "sub");
    mkdirSync(subDir, { recursive: true });
    const filePath2 = join(subDir, "report.md");

    writeFileSync(filePath1, "# Root report");
    writeFileSync(filePath2, "# Sub report");

    await registerTouchedOutput(deps, {
      sessionId: "sess",
      path: filePath1,
      role: "create",
      whenAt: "2024-01-01T10:00:00Z",
    });

    // This must NOT throw (would throw if it inferred the same stem-id "report").
    const result2 = await registerTouchedOutput(deps, {
      sessionId: "sess",
      path: filePath2,
      role: "create",
      whenAt: "2024-01-01T10:01:00Z",
    });
    expect(result2).toEqual({ registered: true, linked: true });

    // Two distinct artefact rows.
    const artCount = (db.prepare(
      "SELECT COUNT(*) as n FROM artifacts WHERE removed_at IS NULL",
    ).get()) as { n: number };
    expect(artCount.n).toBe(2);

    // Confirm each path has its own distinct artefact id.
    const ids = (db.prepare(
      "SELECT id FROM artifacts WHERE removed_at IS NULL ORDER BY created_at",
    ).all()) as Array<{ id: string }>;
    expect(ids[0].id).not.toBe(ids[1].id);
  });

  // ── Test 5: read of a never-seen file → no artefact, no link ──

  it("does not register an artefact or link for a read-only touch of an unknown file", async () => {
    const filePath = join(repoDir, "never-seen.md");
    writeFileSync(filePath, "# Never seen");

    await registerTouchedOutput(deps, {
      sessionId: "sess",
      path: filePath,
      role: "read",
      whenAt: "2024-01-01T10:00:00Z",
    });

    const artCount = (db.prepare("SELECT COUNT(*) as n FROM artifacts").get()) as { n: number };
    expect(artCount.n).toBe(0);

    const linkCount = (db.prepare("SELECT COUNT(*) as n FROM session_artifacts").get()) as { n: number };
    expect(linkCount.n).toBe(0);
  });

  // ── Test 6: path-wins — sess2 (project p2) touches file under repoDir → parents to p ──

  it("parents artefact to the project resolved from the FILE PATH, not the session project", async () => {
    const filePath = join(repoDir, "from-elsewhere.md");
    writeFileSync(filePath, "# From elsewhere");

    // sess2 belongs to project p2, but the file is under repoDir (project p).
    await registerTouchedOutput(deps, {
      sessionId: "sess2",
      path: filePath,
      role: "create",
      whenAt: "2024-01-01T10:00:00Z",
    });

    const art = (db.prepare(
      "SELECT project_id FROM artifacts WHERE json_extract(storage_config,'$.path') = ? AND removed_at IS NULL",
    ).get(filePath)) as { project_id: string } | undefined;

    expect(art).toBeDefined();
    // Path resolution should win: file is under repoDir → project 'p', not 'p2'.
    expect(art!.project_id).toBe("p");
  });
});

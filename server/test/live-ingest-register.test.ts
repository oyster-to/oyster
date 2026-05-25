// Task 7: Live ingestion hook — integration test.
//
// Verifies that both backfillRange (history ingest) and consumeOnce (live
// append ingest) call registerTouchedOutput so that file-output artefacts
// written by the agent are auto-registered and linked even when no space is
// associated with the session.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { ClaudeCodeWatcher } from "../src/watchers/claude-code.js";

// must match encodeCwd() in src/watchers/claude-code.ts
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function makeWriteEventLine(filePath: string, ts?: string): string {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: ts ?? new Date().toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: filePath },
          },
        ],
      },
    }) + "\n"
  );
}

interface Env {
  watcher: ClaudeCodeWatcher;
  sessionStore: SqliteSessionStore;
  service: ArtifactService;
  db: Database.Database;
  root: string;        // fake ~/.claude/projects dir
  repoDir: string;     // fake project repo dir
  cleanup: () => Promise<void>;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "oyster-live-reg-root-"));
  const repoDir = mkdtempSync(join(tmpdir(), "oyster-live-reg-repo-"));
  const userland = mkdtempSync(join(tmpdir(), "oyster-live-reg-db-"));
  const db = initDb(userland);

  // Space s → project p → project_paths (repoDir → p).
  // No space_id on the session intentionally — this test proves that the
  // new path works even for "homeless" sessions (the whole point of Task 7).
  db.exec(
    `INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('s', 'Space', '#000', 'none')`,
  );
  db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p', 's', 'Repo Project')`);
  db.exec(`INSERT INTO project_paths (project_id, path) VALUES ('p', '${repoDir}')`);

  const artifactStore = new SqliteArtifactStore(db);
  const service = new ArtifactService(
    db,
    artifactStore,
    "https://oyster.to",
    "https://share.oyster.to",
    userland,
  );
  const sessionStore = new SqliteSessionStore(db);

  const watcher = new ClaudeCodeWatcher({
    sessionStore,
    artifactStore,
    service,
    db,
    // lookupProject returns no spaceId — tests the "homeless" path that the
    // old code skipped with `if (!spaceId) continue`. New code must NOT skip.
    lookupProject: () => ({ projectId: null, spaceId: null }),
    projectsRoot: root,
  });

  return {
    watcher,
    sessionStore,
    service,
    db,
    root,
    repoDir,
    cleanup: async () => {
      await watcher.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userland, { recursive: true, force: true });
    },
  };
}

describe("live ingest — auto-registers touched file outputs", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ── backfillRange path ───────────────────────────────────────────────────
  // Write the JSONL BEFORE calling start() so the boot-scan picks it up via
  // backfillRange, not consumeOnce.

  it("backfillRange: registers a touched output artefact and links the session", async () => {
    const outputPath = join(env.repoDir, "new-report.md");
    writeFileSync(outputPath, "# New Report");

    const sessionId = `00000000-0000-0000-0000-${Date.now().toString(16).padStart(12, "0")}`;
    const ts = new Date().toISOString();
    const encodedDir = encodeCwd(env.repoDir);
    const projectDir = join(env.root, encodedDir);
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

    // Initial user event (gives the session a timestamp / row)
    const initial =
      JSON.stringify({ type: "user", message: { content: "go" }, cwd: env.repoDir, timestamp: ts }) + "\n";
    // Assistant Write event for the output file
    const writeLine = makeWriteEventLine(outputPath, ts);
    writeFileSync(jsonlPath, initial + writeLine);

    await env.watcher.start();

    // Artefact must exist and be parented to project p (resolved from path).
    const art = env.db
      .prepare(
        `SELECT a.id, a.project_id, a.artifact_kind
           FROM artifacts a
          WHERE json_extract(a.storage_config, '$.path') = ?
            AND a.removed_at IS NULL`,
      )
      .get(outputPath) as { id: string; project_id: string; artifact_kind: string } | undefined;

    expect(art, "artefact should be registered").toBeDefined();
    expect(art!.project_id).toBe("p");
    expect(art!.artifact_kind).toBe("notes");

    // session_artifacts link must exist.
    const link = env.db
      .prepare(
        "SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ?",
      )
      .get(sessionId, art!.id) as { id: number } | undefined;

    expect(link, "session_artifacts link should exist").toBeDefined();
  });

  it("backfillRange: does NOT register a source-code file (src/*.ts)", async () => {
    const srcDir = join(env.repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const srcPath = join(srcDir, "x.ts");
    writeFileSync(srcPath, "export const x = 1;");

    const sessionId = `00000000-0000-0000-0000-${(Date.now() + 1).toString(16).padStart(12, "0")}`;
    const ts = new Date().toISOString();
    const encodedDir = encodeCwd(env.repoDir);
    const projectDir = join(env.root, encodedDir);
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

    const initial =
      JSON.stringify({ type: "user", message: { content: "go" }, cwd: env.repoDir, timestamp: ts }) + "\n";
    const writeLine = makeWriteEventLine(srcPath, ts);
    writeFileSync(jsonlPath, initial + writeLine);

    await env.watcher.start();

    const artCount = (
      env.db
        .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE removed_at IS NULL")
        .get() as { n: number }
    ).n;
    expect(artCount).toBe(0);
  });

  // ── consumeOnce path ─────────────────────────────────────────────────────
  // Write the JSONL first with only a user event, then call start(), then
  // APPEND the Write event. That forces it through consumeOnce (live tail).

  it("consumeOnce: registers a touched output artefact and links the session", async () => {
    const outputPath = join(env.repoDir, "live-report.md");
    writeFileSync(outputPath, "# Live Report");

    const sessionId = `00000000-0000-0000-0000-${(Date.now() + 2).toString(16).padStart(12, "0")}`;
    const ts = new Date().toISOString();
    const encodedDir = encodeCwd(env.repoDir);
    const projectDir = join(env.root, encodedDir);
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

    // Only a user event before start — no Write yet.
    const initial =
      JSON.stringify({ type: "user", message: { content: "go" }, cwd: env.repoDir, timestamp: ts }) + "\n";
    writeFileSync(jsonlPath, initial);

    await env.watcher.start();

    // Confirm session was created and no artefact yet.
    expect(env.sessionStore.getById(sessionId)).toBeDefined();
    const artsBefore = (
      env.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE removed_at IS NULL").get() as { n: number }
    ).n;
    expect(artsBefore).toBe(0);

    // Append the Write event (consumeOnce path).
    appendFileSync(jsonlPath, makeWriteEventLine(outputPath, new Date().toISOString()));

    // Poll until the artefact appears (chokidar change event + async processing).
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const art = env.db
        .prepare(
          `SELECT id FROM artifacts WHERE json_extract(storage_config, '$.path') = ? AND removed_at IS NULL`,
        )
        .get(outputPath);
      if (art) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const art = env.db
      .prepare(
        `SELECT a.id, a.project_id, a.artifact_kind
           FROM artifacts a
          WHERE json_extract(a.storage_config, '$.path') = ?
            AND a.removed_at IS NULL`,
      )
      .get(outputPath) as { id: string; project_id: string; artifact_kind: string } | undefined;

    expect(art, "artefact should be registered via consumeOnce").toBeDefined();
    expect(art!.project_id).toBe("p");
    expect(art!.artifact_kind).toBe("notes");

    const link = env.db
      .prepare(
        "SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ?",
      )
      .get(sessionId, art!.id) as { id: number } | undefined;

    expect(link, "session_artifacts link should exist").toBeDefined();
  });

  it("consumeOnce: does NOT register a source-code file (src/*.ts)", async () => {
    const srcDir = join(env.repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const srcPath = join(srcDir, "x.ts");
    writeFileSync(srcPath, "export const x = 1;");

    // Qualifying output file appended in the same batch as the source file.
    // Once its artefact appears we KNOW the batch was processed — only then
    // assert that the source file did NOT get registered.
    const outputPath = join(env.repoDir, "anchor-output.md");
    writeFileSync(outputPath, "# anchor");

    const sessionId = `00000000-0000-0000-0000-${(Date.now() + 3).toString(16).padStart(12, "0")}`;
    const ts = new Date().toISOString();
    const encodedDir = encodeCwd(env.repoDir);
    const projectDir = join(env.root, encodedDir);
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

    const initial =
      JSON.stringify({ type: "user", message: { content: "go" }, cwd: env.repoDir, timestamp: ts }) + "\n";
    writeFileSync(jsonlPath, initial);

    await env.watcher.start();

    // Append both events together: source-file touch (should not register) +
    // output-file touch (should register, used as processing anchor).
    appendFileSync(jsonlPath, makeWriteEventLine(srcPath, new Date().toISOString()));
    appendFileSync(jsonlPath, makeWriteEventLine(outputPath, new Date().toISOString()));

    // Poll until the anchor output artefact appears — proves the batch was processed.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const art = env.db
        .prepare(
          `SELECT id FROM artifacts WHERE json_extract(storage_config, '$.path') = ? AND removed_at IS NULL`,
        )
        .get(outputPath);
      if (art) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Anchor must have registered (proves the batch ran).
    const anchor = env.db
      .prepare(
        `SELECT id FROM artifacts WHERE json_extract(storage_config, '$.path') = ? AND removed_at IS NULL`,
      )
      .get(outputPath);
    expect(anchor, "anchor output artefact should be registered").toBeDefined();

    // Source file must NOT have registered.
    const srcArt = env.db
      .prepare(
        `SELECT id FROM artifacts WHERE json_extract(storage_config, '$.path') = ? AND removed_at IS NULL`,
      )
      .get(srcPath);
    expect(srcArt, "source-code file should NOT be registered").toBeUndefined();
  });
});

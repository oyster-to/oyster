// Integration tests for runOutputBackfill — the one-time historical sweep
// that walks session_events, re-renders text with file paths (Job A), and
// registers touched outputs + links (Job B). Mirrors the harness pattern
// from session-output-register.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { ArtifactService } from "../src/artifact-service.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { runOutputBackfill } from "../src/session-output-sweep.js";
import type { SweepDeps } from "../src/session-output-sweep.js";

// Helper: build a raw JSONL event line with a tool_use block using a Write tool.
function makeWriteEventLine(filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2024-06-01T10:00:00.000Z",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Write",
          input: { file_path: filePath },
        },
      ],
    },
  });
}

describe("runOutputBackfill", () => {
  let userland: string;
  let repoDir: string;
  let db: Database.Database;
  let service: ArtifactService;
  let sessionStore: SqliteSessionStore;
  let deps: SweepDeps;

  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-sweep-"));
    repoDir = mkdtempSync(join(tmpdir(), "oyster-repo-"));
    db = initDb(userland);

    // Space s → project p → project_paths (repoDir → p).
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('s', 'Space', '#000', 'none')`);
    db.exec(`INSERT INTO projects (id, space_id, name) VALUES ('p', 's', 'Repo')`);
    db.exec(`INSERT INTO project_paths (project_id, path) VALUES ('p', '${repoDir}')`);

    // Session sess belongs to project p, cwd = repoDir.
    db.exec(`INSERT INTO sessions (id, space_id, project_id, cwd, agent, state, title)
             VALUES ('sess', 's', 'p', '${repoDir}', 'claude-code', 'done', 'Test')`);

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

  it("registers output artefact, links it, re-renders text, and skips source/secret", async () => {
    // Create the actual files (registerTouchedOutput checks existsSync).
    const outputPath = join(repoDir, "report.md");
    const srcDir = join(repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const sourcePath = join(srcDir, "App.tsx");
    const secretPath = join(repoDir, ".env");
    writeFileSync(outputPath, "# Report");
    writeFileSync(sourcePath, "export default function App() {}");
    writeFileSync(secretPath, "SECRET=abc");

    const ts = "2024-06-01T10:00:00.000Z";

    // Insert session_events directly. text is a stale placeholder that Job A
    // should overwrite. raw contains tool_use blocks.
    const insertEvent = db.prepare(
      `INSERT INTO session_events (session_id, role, text, ts, raw, is_protocol_artifact)
       VALUES (?, ?, ?, ?, ?, 0)`,
    );
    const outputLine = makeWriteEventLine(outputPath);
    const sourceLine = makeWriteEventLine(sourcePath);
    const secretLine = makeWriteEventLine(secretPath);
    const { lastInsertRowid: outId } = insertEvent.run("sess", "assistant", "[Write]", ts, outputLine);
    insertEvent.run("sess", "assistant", "[Write]", ts, sourceLine);
    insertEvent.run("sess", "assistant", "[Write]", ts, secretLine);

    const result = await runOutputBackfill(deps);

    // 1. Output artefact registered (project p, derived space s); source + secret NOT.
    const artRows = db.prepare(
      "SELECT project_id, json_extract(storage_config,'$.path') AS path FROM artifacts WHERE removed_at IS NULL",
    ).all() as Array<{ project_id: string; path: string }>;
    expect(artRows).toHaveLength(1);
    expect(artRows[0]!.project_id).toBe("p");
    expect(artRows[0]!.path).toBe(outputPath);

    // 2. session_artifacts link created with when_at equal to the event's ts.
    // With skipTouchBackfill=true the sweep's own insertArtifactTouch is the
    // sole inserter, so the link carries the real event timestamp (not now()).
    const links = db.prepare(
      "SELECT sa.when_at FROM session_artifacts sa JOIN artifacts a ON a.id = sa.artifact_id WHERE sa.session_id = 'sess'",
    ).all() as Array<{ when_at: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]!.when_at).toBe(ts);

    // 3a. session_events.text for the output row now contains the relative path.
    const evRow = db.prepare("SELECT text FROM session_events WHERE id = ?").get(outId) as { text: string } | undefined;
    expect(evRow?.text).toContain("report.md");
    expect(evRow?.text).not.toBe("[Write]"); // the original placeholder

    // 3b. FTS index has been updated — verify via the real production API.
    // "report" is a plain word so searchEvents issues a prefix query "report*"
    // which matches the filename embedded in the rendered text. If this throws
    // SQLITE_CORRUPT_VTAB the triggers or is_protocol_artifact gating is broken
    // (do NOT work around it — report BLOCKED instead).
    const searchHits = sessionStore.searchEvents("report");
    expect(searchHits.length).toBeGreaterThan(0);
    expect(searchHits.some((h) => h.id === Number(outId))).toBe(true);

    // 4. result counters reflect real work: exactly 1 output registered (report.md),
    //    source and secret did not qualify. links >= 1 (the output was linked).
    expect(result.events).toBeGreaterThan(0);
    expect(result.registered).toBe(1);
    expect(result.links).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — second call is a no-op (done=1)", async () => {
    const outputPath = join(repoDir, "notes.md");
    writeFileSync(outputPath, "# Notes");
    const ts = "2024-06-01T11:00:00.000Z";
    const line = makeWriteEventLine(outputPath);
    db.prepare(
      `INSERT INTO session_events (session_id, role, text, ts, raw, is_protocol_artifact) VALUES (?, ?, ?, ?, ?, 0)`,
    ).run("sess", "assistant", "[Write]", ts, line);

    await runOutputBackfill(deps);

    const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM session_artifacts").get() as { n: number }).n;
    const result2 = await runOutputBackfill(deps);
    const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM session_artifacts").get() as { n: number }).n;

    expect(result2).toEqual({ events: 0, registered: 0, links: 0 });
    expect(countAfter).toBe(countBefore);
  });

  it("resumes from low_water_id — only processes events below the cursor", async () => {
    // Seed two events. We will reset done=0 but set low_water_id to the second
    // event's id so only the FIRST event (lower id) would be re-processed on
    // the resumed run.
    const path1 = join(repoDir, "alpha.md");
    const path2 = join(repoDir, "beta.md");
    writeFileSync(path1, "# Alpha");
    writeFileSync(path2, "# Beta");
    const ts = "2024-06-01T12:00:00.000Z";

    const insert = db.prepare(
      `INSERT INTO session_events (session_id, role, text, ts, raw, is_protocol_artifact) VALUES (?, ?, ?, ?, ?, 0)`,
    );
    const { lastInsertRowid: id1 } = insert.run("sess", "assistant", "[Write]", ts, makeWriteEventLine(path1));
    const { lastInsertRowid: id2 } = insert.run("sess", "assistant", "[Write]", ts, makeWriteEventLine(path2));
    // id1 < id2 (SQLite autoincrement)
    const lowId = Number(id1);
    const highId = Number(id2);
    expect(lowId).toBeLessThan(highId);

    // Run the full sweep first to populate done=1.
    await runOutputBackfill(deps);
    // Verify both paths registered after full sweep.
    const fullCount = (db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE removed_at IS NULL").get() as { n: number }).n;
    expect(fullCount).toBe(2);

    // Reset state: done=0, low_water_id = id2. This means on the next
    // run the cursor starts at id2 and sweeps downward from id2-1, so only
    // id1 (which is < id2) would be in scope — NOT id2 (which equals the cursor).
    db.prepare("UPDATE output_backfill_state SET done = 0, low_water_id = ? WHERE id = 1").run(highId);

    // Remove all artifacts + links so the partial run must (re-)register them.
    db.prepare("DELETE FROM session_artifacts").run();
    db.prepare("DELETE FROM artifacts").run();
    // Reset event text so Job A re-runs visibly.
    db.prepare("UPDATE session_events SET text = '[Write]'").run();

    const partialResult = await runOutputBackfill(deps);

    // Only events with id < highId were processed, i.e. only id1 (alpha.md).
    // beta.md (id = highId) should NOT have been touched.
    const arts = db.prepare(
      `SELECT json_extract(storage_config,'$.path') AS path FROM artifacts WHERE removed_at IS NULL`,
    ).all() as Array<{ path: string }>;
    expect(arts).toHaveLength(1);
    expect(arts[0]!.path).toBe(path1); // alpha only

    // The event row for id1 got its text re-rendered; id2 did not.
    const ev1 = db.prepare("SELECT text FROM session_events WHERE id = ?").get(id1) as { text: string };
    const ev2 = db.prepare("SELECT text FROM session_events WHERE id = ?").get(id2) as { text: string };
    expect(ev1.text).toContain("alpha.md");
    expect(ev2.text).toBe("[Write]"); // untouched by the partial run

    // The partial result processed exactly one event (alpha.md).
    expect(partialResult.events).toBe(1);
  });
});

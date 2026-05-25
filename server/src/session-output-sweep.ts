import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { classifyOutput } from "./output-classifier.js";
import { lookupProject } from "./lookup-project.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionStore } from "./session-store.js";
import { renderEvent, artifactTouchFromToolUse } from "./watchers/claude-code.js";

export interface Touch {
  sessionId: string;
  path: string;
  role: "create" | "modify" | "read";
  whenAt: string;
}

export interface SweepDeps {
  db: Database.Database;
  service: ArtifactService;
  sessionStore: SessionStore;
}

/** Register a touched *file-output* (if it qualifies) and link it to the session.
 *  Parents the artefact to the project resolved FROM THE FILE PATH, session
 *  project_id only as fallback. No-op for source/unknown/secret paths. Idempotent
 *  (getByPath + INSERT OR IGNORE). Reads never register, but a read of an
 *  already-registered output still links (provenance). */
export async function registerTouchedOutput(deps: SweepDeps, touch: Touch): Promise<void> {
  const absPath = resolve(touch.path);

  // Check whether an artefact is already registered for this path.
  let artifactId = deps.service.getByPath(absPath)?.id;

  if (!artifactId) {
    // Reads of unknown files do not trigger registration.
    if (touch.role === "read") return;

    const kind = classifyOutput(absPath);
    if (!kind) return;

    // Skip outputs that have since been deleted — registerArtifact would throw.
    if (!existsSync(absPath)) return;

    // Project from path first, fall back to the session's own project.
    const projectId =
      lookupProject(deps.db, dirname(absPath)).projectId ?? sessionProjectId(deps.db, touch.sessionId);

    const art = await deps.service.registerArtifact(
      {
        path: absPath,
        // Explicit UUID — avoid same-stem id collisions across different files
        // (e.g. two `report.md` files in different dirs would both infer id
        // "report" and the second would throw). registerArtifact throws on a
        // duplicate active id, so a fresh UUID per new registration is correct.
        id: crypto.randomUUID(),
        project_id: projectId,
        label: basename(absPath),
        artifact_kind: kind,
        source_origin: "discovered",
      },
      [], // no approved-root check — paths are from the user's own session history
    );
    artifactId = art.id;
  }

  deps.sessionStore.insertArtifactTouch({
    session_id: touch.sessionId,
    artifact_id: artifactId,
    role: touch.role,
    when_at: touch.whenAt,
  });
}

function sessionProjectId(db: Database.Database, sessionId: string): string | null {
  return (
    db
      .prepare("SELECT project_id FROM sessions WHERE id = ?")
      .get(sessionId) as { project_id: string | null } | undefined
  )?.project_id ?? null;
}

const BATCH = 5000;

export async function runOutputBackfill(deps: SweepDeps): Promise<{ events: number; registered: number; links: number }> {
  const state = deps.db
    .prepare("SELECT done, low_water_id FROM output_backfill_state WHERE id = 1")
    .get() as { done: number; low_water_id: number } | undefined;
  if (state?.done) return { events: 0, registered: 0, links: 0 };

  const sessionCwd = deps.db.prepare("SELECT cwd FROM sessions WHERE id = ?");
  const updateText = deps.db.prepare("UPDATE session_events SET text = ? WHERE id = ?");
  const setLow = deps.db.prepare("UPDATE output_backfill_state SET low_water_id = ? WHERE id = 1");

  // Resume from where a previous (crashed) run left off; a fresh run has
  // low_water_id=0 → start from the top (MAX_SAFE_INTEGER as the first cursor).
  let cursor = state && state.low_water_id > 0 ? state.low_water_id : Number.MAX_SAFE_INTEGER;
  const report = { events: 0, registered: 0, links: 0 };

  for (;;) {
    const rows = deps.db
      .prepare(
        `SELECT id, session_id, ts, raw FROM session_events
          WHERE id < ? AND raw IS NOT NULL AND role IN ('assistant','tool')
          ORDER BY id DESC LIMIT ?`,
      )
      .all(cursor, BATCH) as { id: number; session_id: string; ts: string; raw: string }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const cwd =
        (sessionCwd.get(row.session_id) as { cwd: string | null } | undefined)?.cwd ?? null;
      const rendered = renderEvent(parsed, cwd);
      if (rendered) {
        updateText.run(rendered.text, row.id);
        report.events++;
      }
      const content = (parsed as any)?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const t = artifactTouchFromToolUse(block);
        if (!t) continue;
        const before = countLinks(deps.db);
        try {
          await registerTouchedOutput(deps, {
            sessionId: row.session_id,
            path: t.path,
            role: t.role,
            whenAt: row.ts,
          });
        } catch (err) {
          // One bad touch must not abort the entire pass.
          console.warn("[output-backfill] touch failed", t.path, err);
          continue;
        }
        if (countLinks(deps.db) > before) report.links++;
      }
    }
    setLow.run(cursor); // advance resume cursor after each batch
  }

  deps.db.prepare("UPDATE output_backfill_state SET done = 1 WHERE id = 1").run();
  return report;
}

function countLinks(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM session_artifacts").get() as { n: number }).n;
}

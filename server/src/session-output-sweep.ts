import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { classifyOutput } from "./output-classifier.js";
import { lookupProject } from "./lookup-project.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionStore } from "./session-store.js";

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

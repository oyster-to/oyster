import type Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** The native workspace folder for a space (`<userland>/spaces/<id>`) is the
 *  path where `create_artifact` writes content (via getNativeSourcePath).
 *  Compute it the same way the rest of the server does — via `path.join`, so
 *  the separator is platform-correct. */
export function nativeSpaceDir(userlandDir: string, spaceId: string): string {
  return join(userlandDir, "spaces", spaceId);
}

/** The native workspace folder for a space is itself a project, filed under
 *  that space. This keeps the model uniform: every artefact — repo file or
 *  agent-created content — is project-parented, and its space derives via
 *  that project. Ensures the folder exists on disk (create_artifact writes
 *  into it). Idempotent: returns the existing native project id if one is
 *  already registered for the folder. */
export function ensureNativeProject(db: Database.Database, userlandDir: string, spaceId: string): string {
  const nativePath = nativeSpaceDir(userlandDir, spaceId);
  mkdirSync(nativePath, { recursive: true });
  const existing = db
    .prepare("SELECT project_id FROM project_paths WHERE path = ?")
    .get(nativePath) as { project_id: string } | undefined;
  if (existing) return existing.project_id;

  const id = randomUUID();
  db.prepare("INSERT INTO projects (id, space_id, name) VALUES (?, ?, ?)").run(id, spaceId, spaceId);
  db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(id, nativePath);
  return id;
}

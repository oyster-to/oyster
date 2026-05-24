import type Database from "better-sqlite3";
import { join, relative, sep, isAbsolute } from "node:path";
import { ensureNativeProject } from "./native-project.js";

export interface ArtifactSpaceReport {
  total: number;
  hadSpace: number;
  backfilled: number;
  stillOrphan: number;
  mismatches: { id: string; path: string; oldSpace: string; newSpace: string | null }[];
}

/** Backfill artifacts.project_id from the file path so space can be derived
 *  via project. Native workspace files (<userland>/spaces/<id>) get a native
 *  project for their space first. Does NOT drop space_id — that is a separate
 *  step run only after all readers stop using the column.
 *
 *  Idempotent AND safe after space_id has been dropped: the SELECT shape is
 *  chosen from PRAGMA, so it never names a column that no longer exists. */
export function backfillArtifactProjects(db: Database.Database, userlandDir: string): ArtifactSpaceReport {
  const cols = db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[];
  const hasSpaceCol = cols.some((c) => c.name === "space_id");

  // Use substr-based prefix matching instead of LIKE to avoid treating `_` and
  // `%` in project paths as SQL wildcards. Mirrors the approach in
  // project-service.ts ~lines 149-163. A path matches if it equals the project
  // root exactly, or if it is a direct descendant (separated by `/` or `\`).
  // The backslash variant handles Windows project_paths rows. Three `?` params
  // map to: exact-match candidate, `/`-separator candidate, `\`-separator candidate.
  const resolveProject = db.prepare(
    `SELECT pp.project_id FROM project_paths pp
      WHERE ? = pp.path
         OR substr(?, 1, length(pp.path) + 1) = pp.path || '/'
         OR substr(?, 1, length(pp.path) + 1) = pp.path || '\\'
      ORDER BY LENGTH(pp.path) DESC LIMIT 1`,
  );
  const setProject = db.prepare("UPDATE artifacts SET project_id = ? WHERE id = ?");
  const projectSpace = db.prepare("SELECT space_id FROM projects WHERE id = ?");
  const nativeRoot = join(userlandDir, "spaces");

  const report: ArtifactSpaceReport = { total: 0, hadSpace: 0, backfilled: 0, stillOrphan: 0, mismatches: [] };
  const txn = db.transaction(() => {
    report.total = (db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
    if (hasSpaceCol) {
      report.hadSpace = (db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE space_id IS NOT NULL AND space_id != ''").get() as { n: number }).n;
    }

    // 1. Backfill project_id for rows missing it. The query NEVER references
    //    space_id directly — it may have been dropped on a prior boot.
    const needBackfill = db
      .prepare(
        `SELECT id, json_extract(storage_config,'$.path') AS path
           FROM artifacts
          WHERE project_id IS NULL AND json_extract(storage_config,'$.path') IS NOT NULL`,
      )
      .all() as { id: string; path: string }[];
    for (const row of needBackfill) {
      // Native workspace file → ensure its space's native project first.
      const rel = relative(nativeRoot, row.path);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        const spaceId = rel.split(sep)[0];
        if (spaceId) ensureNativeProject(db, userlandDir, spaceId);
      }
      const hit = resolveProject.get(row.path, row.path, row.path) as { project_id: string } | undefined;
      if (!hit) { report.stillOrphan++; continue; }
      setProject.run(hit.project_id, row.id);
      report.backfilled++;
    }

    // 2. Mismatch report — only possible while space_id still exists. Covers
    //    ALL parented rows (pre-existing project_id too), not just the ones
    //    just backfilled, so a stale manual space assignment is surfaced.
    if (hasSpaceCol) {
      const withBoth = db
        .prepare(
          `SELECT id, space_id, project_id, json_extract(storage_config,'$.path') AS path
             FROM artifacts
            WHERE project_id IS NOT NULL AND space_id IS NOT NULL AND space_id != ''`,
        )
        .all() as { id: string; space_id: string; project_id: string; path: string }[];
      for (const row of withBoth) {
        const projectRow = projectSpace.get(row.project_id) as { space_id: string | null } | undefined;
        if (!projectRow) continue; // stale project_id — skip
        const newSpace = projectRow.space_id;
        if (row.space_id !== newSpace) {
          report.mismatches.push({ id: row.id, path: row.path, oldSpace: row.space_id, newSpace });
        }
      }
    }
  });
  txn();
  return report;
}

export function dropArtifactSpaceColumn(db: Database.Database): void {
  const hasCol = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).some((c) => c.name === "space_id");
  if (hasCol) {
    // The old dedup index includes space_id; SQLite refuses to drop a column
    // referenced by an index, so drop it first.
    db.exec("DROP INDEX IF EXISTS artifacts_space_source_ref_uq");
    // DROP COLUMN requires SQLite ≥ 3.35 (2021); better-sqlite3 v12 bundles a
    // newer SQLite, so this is supported. We deliberately do NOT swallow a
    // failure — dropping the column is the point; a silent no-op would hide a
    // real problem and leave the schema half-migrated. If a future runtime
    // lacks DROP COLUMN, this throws at boot (loud + visible).
    db.exec("ALTER TABLE artifacts DROP COLUMN space_id");
  }
  // Idempotent: ensure the new dedup index exists whether the column was just
  // dropped or dropped on a prior boot.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS artifacts_project_source_ref_uq
             ON artifacts(project_id, source_ref) WHERE source_ref IS NOT NULL`);
}

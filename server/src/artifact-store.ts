import type Database from "better-sqlite3";

// ── Row type (mirrors SQLite schema) ──

export interface ArtifactRow {
  id: string;
  owner_id: string | null;
  /** Derived via LEFT JOIN projects — not stored directly (transitional: column still exists but reads use the join). */
  space_id: string;
  label: string;
  artifact_kind: string;
  storage_kind: string;
  storage_config: string;
  runtime_kind: string;
  runtime_config: string;
  group_name: string | null;
  removed_at: string | null;
  source_origin: "manual" | "discovered" | "ai_generated";
  source_ref: string | null;   // e.g. 'web/:app', 'README.md:notes'
  project_id: string | null;   // FK to projects.id; NULL = not yet bound to a project
  created_at: string;
  updated_at: string;
  share_token: string | null;
  share_mode: "open" | "password" | "signin" | null;
  share_password_hash: string | null;
  published_at: number | null;
  share_updated_at: number | null;
  unpublished_at: number | null;
  pinned_at: number | null;
}

// ── Store interface ──

export type InsertRow = Omit<ArtifactRow, "space_id" | "created_at" | "updated_at" | "removed_at" | "source_origin" | "source_ref" | "project_id" | "share_token" | "share_mode" | "share_password_hash" | "published_at" | "share_updated_at" | "unpublished_at" | "pinned_at"> & {
  source_origin?: "manual" | "discovered" | "ai_generated";
  source_ref?: string | null;
  project_id?: string | null;
};

export interface ArtifactStore {
  getAll(): ArtifactRow[];
  getById(id: string): ArtifactRow | undefined;
  getBySpaceId(spaceId: string): ArtifactRow[];
  getByPath(absPath: string): ArtifactRow | undefined;
  getDistinctSpaces(): { space_id: string; count: number }[];
  getByProjectAndSourceRef(projectId: string, sourceRef: string): ArtifactRow | undefined;
  insert(row: InsertRow): void;
  update(id: string, fields: Partial<Omit<ArtifactRow, "id" | "created_at">>): void;
  resurface(id: string): void;
  remove(id: string): void;
  delete(id: string): void;
  pin(id: string, pinnedAt: number): void;
  unpin(id: string): void;
  getAllArchived(): ArtifactRow[];
  getArchivedFilePaths(): Set<string>;
}

// ── SQLite implementation ──

export class SqliteArtifactStore implements ArtifactStore {
  private stmts: {
    getAll: Database.Statement;
    getById: Database.Statement;
    getBySpaceId: Database.Statement;
    getByPath: Database.Statement;
    getDistinctSpaces: Database.Statement;
    getByProjectAndSourceRef: Database.Statement;
    getAllArchived: Database.Statement;
    insert: Database.Statement;
    delete: Database.Statement;
  };

  constructor(private db: Database.Database) {
    const pragmaCols = db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[];
    const hasSpaceCol = pragmaCols.some((c) => c.name === "space_id");
    // Column list for SELECTs: every artifact column EXCEPT space_id, plus the derived alias.
    const artCols = pragmaCols.filter((c) => c.name !== "space_id").map((c) => `a.${c.name}`).join(", ");
    const SELECT = `SELECT ${artCols}, COALESCE(p.space_id,'') AS space_id
                      FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id`;

    this.stmts = {
      getAll: db.prepare(`${SELECT} WHERE a.removed_at IS NULL ORDER BY p.space_id, a.created_at`),
      getById: db.prepare(`${SELECT} WHERE a.id = ?`),
      getBySpaceId: db.prepare(`${SELECT} WHERE p.space_id = ? AND a.removed_at IS NULL ORDER BY a.created_at`),
      getByPath: db.prepare(`${SELECT} WHERE json_extract(a.storage_config, '$.path') = ? AND a.removed_at IS NULL`),
      getDistinctSpaces: db.prepare(
        "SELECT p.space_id AS space_id, COUNT(*) as count FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.removed_at IS NULL GROUP BY p.space_id ORDER BY p.space_id"
      ),
      getByProjectAndSourceRef: db.prepare(
        `${SELECT} WHERE a.project_id = ? AND a.source_ref = ?`
      ),
      getAllArchived: db.prepare(
        `${SELECT} WHERE a.removed_at IS NOT NULL ORDER BY a.removed_at DESC`
      ),
      insert: db.prepare(
        hasSpaceCol
          ? `INSERT INTO artifacts (id, owner_id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, group_name, source_origin, source_ref, project_id)
             VALUES (@id, @owner_id, '', @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config, @group_name, COALESCE(@source_origin,'manual'), @source_ref, @project_id)`
          : `INSERT INTO artifacts (id, owner_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, group_name, source_origin, source_ref, project_id)
             VALUES (@id, @owner_id, @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config, @group_name, COALESCE(@source_origin,'manual'), @source_ref, @project_id)`,
      ),
      delete: db.prepare("DELETE FROM artifacts WHERE id = ?"),
    };
  }

  getAll(): ArtifactRow[] {
    return this.stmts.getAll.all() as ArtifactRow[];
  }

  getById(id: string): ArtifactRow | undefined {
    return this.stmts.getById.get(id) as ArtifactRow | undefined;
  }

  getBySpaceId(spaceId: string): ArtifactRow[] {
    return this.stmts.getBySpaceId.all(spaceId) as ArtifactRow[];
  }

  getByPath(absPath: string): ArtifactRow | undefined {
    return this.stmts.getByPath.get(absPath) as ArtifactRow | undefined;
  }

  getDistinctSpaces(): { space_id: string; count: number }[] {
    return this.stmts.getDistinctSpaces.all() as { space_id: string; count: number }[];
  }

  getByProjectAndSourceRef(projectId: string, sourceRef: string): ArtifactRow | undefined {
    return this.stmts.getByProjectAndSourceRef.get(projectId, sourceRef) as ArtifactRow | undefined;
  }

  insert(row: InsertRow): void {
    this.stmts.insert.run({ project_id: null, source_origin: null, source_ref: null, ...row });
  }

  resurface(id: string): void {
    this.db.prepare(
      "UPDATE artifacts SET removed_at = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  private static readonly UPDATABLE_COLUMNS = new Set([
    "owner_id", "label", "artifact_kind",
    "storage_kind", "storage_config", "runtime_kind", "runtime_config",
    "group_name", "removed_at", "source_origin", "source_ref", "project_id",
  ]);

  update(id: string, fields: Partial<Omit<ArtifactRow, "id" | "created_at">>): void {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(fields)) {
      if (!SqliteArtifactStore.UPDATABLE_COLUMNS.has(key)) continue;
      sets.push(`${key} = @${key}`);
      values[key] = value;
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  remove(id: string): void {
    this.db.prepare("UPDATE artifacts SET removed_at = datetime('now') WHERE id = ?").run(id);
  }

  pin(id: string, pinnedAt: number): void {
    this.db.prepare("UPDATE artifacts SET pinned_at = ?, updated_at = datetime('now') WHERE id = ?").run(pinnedAt, id);
  }

  unpin(id: string): void {
    this.db.prepare("UPDATE artifacts SET pinned_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  }

  // All rows that have been soft-deleted — newest first, for the Archived view.
  getAllArchived(): ArtifactRow[] {
    return this.stmts.getAllArchived.all() as ArtifactRow[];
  }

  // Paths of soft-deleted filesystem-backed artifacts. Used by getAllArtifacts
  // to suppress in-memory scanner shadows of archived rows (without this, a
  // file-backed artifact archived from the UI would still appear because the
  // scanner re-detects the underlying file each scan cycle).
  getArchivedFilePaths(): Set<string> {
    // Use SQLite's json_extract in-query instead of JSON.parse'ing each row
    // in JS. Matches the getByPath pattern above and scales better as the
    // archive grows.
    const rows = this.db.prepare(
      "SELECT json_extract(storage_config, '$.path') AS path FROM artifacts WHERE removed_at IS NOT NULL AND storage_kind = 'filesystem' AND json_extract(storage_config, '$.path') IS NOT NULL"
    ).all() as { path: string | null }[];
    return new Set(rows.map((r) => r.path).filter((p): p is string => typeof p === "string" && p.length > 0));
  }

  delete(id: string): void {
    this.stmts.delete.run(id);
  }
}

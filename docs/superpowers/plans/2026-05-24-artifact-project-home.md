# Artifact's home is the project, space is derived — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the legacy `artifacts.space_id` parent column; an artifact's home becomes its `project_id`, and its space is derived (`artifact → project → space`).

**Architecture:** Derive `space_id` once at the store read boundary via `LEFT JOIN projects` (`COALESCE(p.space_id,'')`), so `ArtifactRow.space_id` / `Artifact.spaceId` keep their `string` shape and all ~18 web consumers + `rowToArtifact` stay untouched. A boot migration backfills `project_id` (longest-prefix `project_paths`; native space folders become projects), logs a before/after report, then drops the column and re-keys the dedup index to `(project_id, source_ref)`. Tasks are ordered so **every commit leaves the app working** — the column is dropped only after all readers/writers stop using it.

**Tech Stack:** TypeScript, better-sqlite3, vitest (`server/test/*.test.ts`, run with `npm --prefix server test`). Spec: `docs/superpowers/specs/2026-05-24-artifact-project-home-design.md`.

---

## File structure

- **Create** `server/src/native-project.ts` — `ensureNativeProject(db, userlandDir, spaceId)` shared by the migration (`db.ts`) and `createArtifact` (`artifact-service.ts`).
- **Create** `server/src/artifact-space-migration.ts` — the backfill + report + drop logic, called from `initDb`. (Keeps `db.ts` lean; `db.ts` just invokes it.)
- **Modify** `server/src/db.ts` — call the migration; re-key the dedup index.
- **Modify** `server/src/artifact-store.ts` — derive `space_id` via join in SELECTs; drop it from insert + `UPDATABLE_COLUMNS`.
- **Modify** `server/src/artifact-service.ts` — `registerArtifact`/`createArtifact` resolve `project_id`; `updateArtifact` drops space reassignment.
- **Modify** `server/src/mcp-server.ts` — `register_artifact`/`update_artifact` drop `space_id`; `create_artifact` parents to native project.
- **Modify** `server/src/publish-service.ts` — derive `space_id` via join.
- **Modify** `server/src/import.ts`, `server/src/routes/import.ts` — resolve `project_id`.
- **Create** `server/test/artifact-space-derivation.test.ts`, `server/test/artifact-space-migration.test.ts`.

---

## Task 1: Native-project helper

**Files:**
- Create: `server/src/native-project.ts`
- Test: `server/test/native-project.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/native-project.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
```

> Add `existsSync` to the imports: `import { mkdtempSync, rmSync, existsSync } from "node:fs";`

- [ ] **Step 2: Run it, verify it fails**

Run: `npm --prefix server test -- native-project`
Expected: FAIL — `ensureNativeProject` not found.

- [ ] **Step 3: Implement**

```typescript
// server/src/native-project.ts
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
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm --prefix server test -- native-project`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/native-project.ts server/test/native-project.test.ts
git commit -m "feat(artifacts): ensureNativeProject — native space folder as a project"
```

---

## Task 2: Migration — native projects + project_id backfill + before/after report

**Files:**
- Create: `server/src/artifact-space-migration.ts`
- Test: `server/test/artifact-space-migration.test.ts`

This task does the backfill and report **without dropping `space_id`** (drop happens in Task 7, after all readers move). The function is split into `backfillArtifactProjects` (this task) and `dropArtifactSpaceColumn` (Task 7).

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/artifact-space-migration.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { backfillArtifactProjects } from "../src/artifact-space-migration.js";

function seedArtifact(db: ReturnType<typeof initDb>, id: string, spaceId: string, path: string) {
  db.prepare(
    `INSERT INTO artifacts (id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config)
     VALUES (?, ?, ?, 'notes', 'filesystem', ?, 'static_file', '{}')`,
  ).run(id, spaceId, id, JSON.stringify({ path }));
}

describe("backfillArtifactProjects", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-asm-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none'),('home','Home','#111','none')`);
    // A repo project at /repo, in space 'work'
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p-repo','work','repo')").run();
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES ('p-repo','/repo')").run();
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("backfills project_id from longest-prefix path, makes native projects, reports counts + mismatches", () => {
    seedArtifact(db, "a-repo", "work", "/repo/docs/report.md");        // resolves to p-repo (space work — matches)
    seedArtifact(db, "a-mismatch", "home", "/repo/docs/other.md");      // resolves to p-repo (space work) — mismatch vs 'home'
    seedArtifact(db, "a-native", "work", join(userland, "spaces", "work", "note.md")); // native folder → native project
    seedArtifact(db, "a-orphan", "home", "/elsewhere/loose.md");        // no project → stays null

    const report = backfillArtifactProjects(db, userland);

    expect(db.prepare("SELECT project_id FROM artifacts WHERE id='a-repo'").get()).toEqual({ project_id: "p-repo" });
    const nativePid = (db.prepare("SELECT project_id FROM artifacts WHERE id='a-native'").get() as { project_id: string }).project_id;
    expect(nativePid).toBeTruthy();
    expect(db.prepare("SELECT space_id FROM projects WHERE id=?").get(nativePid)).toEqual({ space_id: "work" });
    expect(db.prepare("SELECT project_id FROM artifacts WHERE id='a-orphan'").get()).toEqual({ project_id: null });

    expect(report.total).toBe(4);
    expect(report.backfilled).toBe(3);       // repo, mismatch, native
    expect(report.stillOrphan).toBe(1);      // a-orphan
    expect(report.mismatches.map((m) => m.id)).toContain("a-mismatch");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm --prefix server test -- artifact-space-migration`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// server/src/artifact-space-migration.ts
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

  const resolveProject = db.prepare(
    `SELECT pp.project_id FROM project_paths pp
      WHERE ? LIKE pp.path || '/%' OR ? = pp.path
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
      const hit = resolveProject.get(row.path, row.path) as { project_id: string } | undefined;
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
        const newSpace = (projectSpace.get(row.project_id) as { space_id: string | null }).space_id;
        if (row.space_id !== newSpace) {
          report.mismatches.push({ id: row.id, path: row.path, oldSpace: row.space_id, newSpace });
        }
      }
    }
  });
  txn();
  return report;
}
```

> The mismatch test in Step 1 still holds: `a-mismatch` is parented to `p-repo` (space `work`) in pass 1, then pass 2 finds its old space `home ≠ work` and reports it. Add a second assertion to the test that a row with a *pre-existing* `project_id` whose old `space_id` disagrees is also reported (seed one before calling).

- [ ] **Step 4: Run it, verify it passes**

Run: `npm --prefix server test -- artifact-space-migration`
Expected: PASS.

- [ ] **Step 5: Wire into `initDb` (with logging) and verify the suite still boots**

In `server/src/db.ts`, after the `project_id` ADD COLUMN block (around `:500-502`), add:

```typescript
import { backfillArtifactProjects } from "./artifact-space-migration.js"; // top of file
// … after artifacts.project_id index is created:
{
  const r = backfillArtifactProjects(db, userlandDir);
  if (r.backfilled > 0 || r.mismatches.length > 0) {
    console.log(`[artifact-space] backfilled ${r.backfilled} project_id (of ${r.total}; ${r.hadSpace} had space; ${r.stillOrphan} orphan)`);
    for (const m of r.mismatches) console.log(`[artifact-space] mismatch ${m.id} (${m.path}): space ${m.oldSpace} → ${m.newSpace} (project wins)`);
  }
}
```

Run: `npm --prefix server test`
Expected: existing tests still PASS (column not yet dropped; nothing else changed).

- [ ] **Step 6: Commit**

```bash
git add server/src/artifact-space-migration.ts server/test/artifact-space-migration.test.ts server/src/db.ts
git commit -m "feat(artifacts): backfill project_id from path + before/after report"
```

---

## Task 3: Derive space_id in the store SELECTs; stop reading/writing the column

**Files:**
- Modify: `server/src/artifact-store.ts:73-93` (SELECTs + insert), `:130-134` (UPDATABLE_COLUMNS)
- Test: `server/test/artifact-space-derivation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/artifact-space-derivation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

describe("artifact store derives space via project", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;
  let store: SqliteArtifactStore;
  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-asd-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p1','work','repo')").run();
    store = new SqliteArtifactStore(db);
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("derives space_id from the artifact's project; orphan → empty string", () => {
    store.insert({ id: "a1", owner_id: null, label: "r", artifact_kind: "notes", storage_kind: "filesystem", storage_config: JSON.stringify({ path: "/repo/r.md" }), runtime_kind: "static_file", runtime_config: "{}", group_name: null, project_id: "p1" });
    store.insert({ id: "a2", owner_id: null, label: "o", artifact_kind: "notes", storage_kind: "filesystem", storage_config: JSON.stringify({ path: "/x/o.md" }), runtime_kind: "static_file", runtime_config: "{}", group_name: null, project_id: null });

    expect(store.getById("a1")!.space_id).toBe("work");
    expect(store.getById("a2")!.space_id).toBe("");                // orphan
    expect(store.getBySpaceId("work").map((r) => r.id)).toEqual(["a1"]); // orphan excluded
    expect(store.getDistinctSpaces()).toEqual([{ space_id: "work", count: 1 }]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm --prefix server test -- artifact-space-derivation`
Expected: FAIL — `insert` still requires `space_id` (TS error or runtime: `a1` space_id is the stored value, `a2` insert errors on missing space_id).

- [ ] **Step 3: Implement — rewrite SELECTs + insert + UPDATABLE_COLUMNS**

In `server/src/artifact-store.ts`, replace the SELECT statements (`:73-80`). **Do not use `a.*`** — build the artifact column list dynamically from `PRAGMA table_info`, excluding `space_id`, and append the derived alias. This is robust whether or not the column still exists, and never produces a duplicate `space_id` column (so we don't rely on better-sqlite3's row-key overwrite order):

```typescript
// Column list for SELECTs: every artifact column EXCEPT space_id, plus the
// derived space alias. Built once; correct pre- and post-column-drop.
const artCols = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[])
  .map((c) => c.name)
  .filter((n) => n !== "space_id")
  .map((n) => `a.${n}`)
  .join(", ");
const SELECT = `SELECT ${artCols}, COALESCE(p.space_id,'') AS space_id
                  FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id`;
this.stmts = {
  getAll: db.prepare(`${SELECT} WHERE a.removed_at IS NULL ORDER BY p.space_id, a.created_at`),
  getById: db.prepare(`${SELECT} WHERE a.id = ?`),
  getBySpaceId: db.prepare(`${SELECT} WHERE p.space_id = ? AND a.removed_at IS NULL ORDER BY a.created_at`),
  getByPath: db.prepare(`${SELECT} WHERE json_extract(a.storage_config,'$.path') = ? AND a.removed_at IS NULL`),
  getDistinctSpaces: db.prepare(`SELECT p.space_id AS space_id, COUNT(*) as count FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.removed_at IS NULL GROUP BY p.space_id ORDER BY p.space_id`),
  getByProjectAndSourceRef: db.prepare(`${SELECT} WHERE a.project_id = ? AND a.source_ref = ?`),
  // INSERT must be built dynamically too: `space_id` is still NOT NULL until
  // Task 7 drops it, so while the column exists we must supply a value ('') to
  // satisfy the constraint; once dropped, we must NOT name it. Mirror the
  // SELECT's PRAGMA approach.
  insert: db.prepare(
    hasSpaceCol
      ? `INSERT INTO artifacts (id, owner_id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, group_name, source_origin, source_ref, project_id)
         VALUES (@id, @owner_id, '', @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config, @group_name, COALESCE(@source_origin,'manual'), @source_ref, @project_id)`
      : `INSERT INTO artifacts (id, owner_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, group_name, source_origin, source_ref, project_id)
         VALUES (@id, @owner_id, @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config, @group_name, COALESCE(@source_origin,'manual'), @source_ref, @project_id)`,
  ),
  delete: db.prepare("DELETE FROM artifacts WHERE id = ?"),
};
```

where `hasSpaceCol` is computed once at the top of the constructor:
```typescript
const hasSpaceCol = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).some((c) => c.name === "space_id");
```
The transitional `''` is never read (derived reads use the join alias), and once Task 7 drops the column the store is reconstructed with `hasSpaceCol = false` so the column is no longer named.

> `getBySpaceId` uses `LEFT JOIN` + `WHERE p.space_id = ?` — orphan artifacts (`project_id NULL` → `p.space_id NULL`) never match a real space id, so they're correctly excluded. `getAll` orders by `p.space_id` (the column is gone post-drop). `getDistinctSpaces` inner-joins (orphans absent), matching old behaviour where every artifact had a space.

**Rename `getBySpaceAndSourceRef` → `getByProjectAndSourceRef`** (signature `(projectId: string, sourceRef: string)`), keyed on `(project_id, source_ref)` to match the new dedup index — space-keyed lookup is ambiguous now (multiple projects per space). Update the `ArtifactStore` interface (`:45`) and the method body. The audit found **zero external callers**, so no call sites need updating; grep to confirm: `grep -rn "getBySpaceAndSourceRef" server/src`.

Update `InsertRow` (`:33`): **add `"space_id"` to the `Omit<ArtifactRow, ...>` list** so it is no longer a required insert field (callers stop supplying it; `project_id` is the home now). `ArtifactRow.space_id` (`:8`) **stays** `string` — populated by the derived alias (which is the *only* `space_id` column in the result, so no shadowing ambiguity). Add a comment on `ArtifactRow.space_id` noting it is derived, not stored.

Remove `"space_id"` from `UPDATABLE_COLUMNS` (`:130-134`):

```typescript
private static readonly UPDATABLE_COLUMNS = new Set([
  "owner_id", "label", "artifact_kind",
  "storage_kind", "storage_config", "runtime_kind", "runtime_config",
  "group_name", "removed_at", "source_origin", "source_ref", "project_id",
]);
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm --prefix server test -- artifact-space-derivation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/artifact-store.ts server/test/artifact-space-derivation.test.ts
git commit -m "feat(artifacts): derive space_id via project in store SELECTs; drop column writes"
```

---

## Task 4: Service layer — resolve project_id; drop space reassignment

**Files:**
- Modify: `server/src/artifact-service.ts:296-358` (`registerArtifact`), `:452-510` (`createArtifact`), `:589-593` (`updateArtifact`)

- [ ] **Step 1: Write the failing test**

```typescript
// add to server/test/artifact-space-derivation.test.ts
it("registerArtifact parents to the project resolved from the file path (no space_id param)", async () => {
  // (construct ArtifactService with this store + db per existing service test setup)
  // seed project p1 at /repo (space 'work'); register /repo/r.md with NO space_id:
  // expect the returned Artifact.spaceId === 'work', and the row's project_id === 'p1'.
});
```

> Model the service construction on `server/test/session-service.test.ts` / existing service tests. Assert: `registerArtifact({ path: "/repo/r.md", label: "r" }, [])` resolves `project_id='p1'` via `lookupProject(db, dirname(path))` and the returned `Artifact.spaceId` is `'work'`.

- [ ] **Step 2: Run it, verify it fails**

Run: `npm --prefix server test -- artifact-space-derivation`
Expected: FAIL — `registerArtifact` still requires `space_id`.

- [ ] **Step 3: Implement**

`registerArtifact` (`:296`): change the param type — replace `space_id: string;` with `project_id?: string | null;`. After `const absPath = resolve(params.path);`, resolve the project when not supplied:

```typescript
import { dirname } from "node:path";           // ensure imported
import { lookupProject } from "./lookup-project.js"; // ensure imported
// …
const projectId = params.project_id !== undefined
  ? params.project_id
  : lookupProject(this.db, dirname(absPath)).projectId;
```

In the resurface `store.update` (`:347-354`) replace `space_id: params.space_id,` with `project_id: projectId,`. In the new-row `store.insert` (`:363`) replace `space_id: params.space_id,` with `project_id: projectId,`. In the returned literal (`:386-397`) drop `spaceId` (it's set by `rowToArtifact` everywhere else; this hand-built literal should instead `return await this.rowToArtifact(this.store.getById(id)!);` for consistency — verify the existing literal isn't relied on for a field `rowToArtifact` omits; if it is, keep the literal but set `spaceId` from `lookupProject(...).spaceId`).

`createArtifact` (`:452`): it already has `space_id`. Keep that param (it picks the native folder). After computing the file path, ensure the native project and pass its id:

```typescript
import { ensureNativeProject } from "./native-project.js"; // ensure imported
// inside createArtifact, before the registerArtifact call (~:506):
const projectId = ensureNativeProject(this.db, this.userlandDir, space_id);
return await this.registerArtifact(
  { path: absPath, project_id: projectId, label, artifact_kind: params.artifact_kind, group_name: params.group_name, id, source_origin: params.source_origin },
  /* approvedRoots */ [],
);
```

> Confirm `ArtifactService` has `this.userlandDir` (or pass it in). If not, thread it through the constructor — check `server/src/index.ts` where the service is built.

`updateArtifact` (`:589-593`): delete the `fields.space_id` block entirely. Moving an artifact between spaces is no longer a direct operation (it's done by moving the project). Update the method's `fields` type to drop `space_id`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm --prefix server test -- artifact-space-derivation && npm --prefix server run build`
Expected: PASS; `build` (tsc) clean — fix any call sites the type change surfaces (e.g. callers passing `space_id` to `registerArtifact`).

- [ ] **Step 5: Commit**

```bash
git add server/src/artifact-service.ts server/test/artifact-space-derivation.test.ts
git commit -m "feat(artifacts): registerArtifact resolves project_id from path; createArtifact uses native project; drop space reassignment"
```

---

## Task 5: MCP tools — drop space_id from register/update; keep it as storage target in create

**Files:**
- Modify: `server/src/mcp-server.ts:581-597` (register_artifact), `:628-644` (create_artifact), `:663` (update_artifact)

- [ ] **Step 1: Edit register_artifact** — remove the `space_id: z.string()...` param (`:585`) and the `space_id` argument from the handler call (`:594-597`). Update the tool description to drop "Space to place…". 

- [ ] **Step 2: Edit update_artifact** — remove `space_id` from its input schema and from the `updateArtifact({...})` call (`:663`). Update description: it can rename / regroup, not reassign space.

- [ ] **Step 3: Edit create_artifact** — **keep** `space_id` (storage target). No code change to its handler beyond confirming it still passes `space_id` to `deps.service.createArtifact` (which now ensures the native project internally). Update description to note the artifact is filed under that space via its native project.

- [ ] **Step 4: Verify list_artifacts still filters by space** — `:556-558` filters `a.spaceId === space_id` off built `Artifact` objects (derived). No change needed; confirm by reading.

- [ ] **Step 5: Typecheck + commit**

Run: `npm --prefix server run build`
Expected: clean.

```bash
git add server/src/mcp-server.ts
git commit -m "feat(mcp): register/update drop space_id; create_artifact files via native project"
```

---

## Task 6: publish-service + import — derive space, resolve project

**Files:**
- Modify: `server/src/publish-service.ts:143`, `:444`
- Modify: `server/src/import.ts:538-580`, `server/src/routes/import.ts:84`

- [ ] **Step 1: publish-service SELECTs** — both `SELECT ... space_id FROM artifacts WHERE id = ?` (`:143`, `:444`) become joins:

```sql
SELECT a.id, a.artifact_kind, a.owner_id, a.share_token, a.unpublished_at, a.label,
       COALESCE(p.space_id,'') AS space_id
  FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id
 WHERE a.id = ?
```
(and the `:444` one analogously with its `label, space_id` columns). The wire payload is unchanged — only how `space_id` is obtained.

- [ ] **Step 2: import.ts** — `createArtifact({ space_id: spaceId, ... })` calls (`:538-580`) are unchanged in signature (createArtifact still takes `space_id` as the storage target and now ensures the native project). Confirm no direct `store.insert({ space_id })` exists in import. `routes/import.ts:84` `store.getBySpaceId(s.id)` is unchanged (the store method now joins). Read both to confirm no remaining direct `space_id` writes.

- [ ] **Step 3: Typecheck + targeted publish test**

Run: `npm --prefix server run build && npm --prefix server test -- publish`
Expected: clean + publish tests pass (fix the SELECT-derived `space_id` if any test asserts the old shape).

- [ ] **Step 4: Commit**

```bash
git add server/src/publish-service.ts server/src/import.ts server/src/routes/import.ts
git commit -m "feat(publish,import): derive artifact space via project"
```

---

## Task 7: Drop the space_id column + re-key the dedup index

**Files:**
- Modify: `server/src/artifact-space-migration.ts` (add `dropArtifactSpaceColumn`), `server/src/db.ts` (call it; re-key index), `server/src/artifact-store.ts` (fix `getAll` ORDER BY)
- Test: `server/test/artifact-space-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// add to server/test/artifact-space-migration.test.ts
import { backfillArtifactProjects, dropArtifactSpaceColumn } from "../src/artifact-space-migration.js";

it("drops space_id and is idempotent", () => {
  seedArtifact(db, "a-repo", "work", "/repo/r.md");
  backfillArtifactProjects(db, userland);
  dropArtifactSpaceColumn(db);
  const cols = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).not.toContain("space_id");
  // idempotent — second call is a no-op
  expect(() => dropArtifactSpaceColumn(db)).not.toThrow();
});

it("re-keyed dedup index: same source_ref same project rejected; orphans allowed", () => {
  backfillArtifactProjects(db, userland);
  dropArtifactSpaceColumn(db);
  const ins = (id: string, projectId: string | null, ref: string) => db.prepare(
    `INSERT INTO artifacts (id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config,source_ref,project_id)
     VALUES (?,?, 'notes','filesystem','{}','static_file','{}',?,?)`).run(id, id, ref, projectId);
  ins("x1", "p-repo", "README.md:notes");
  expect(() => ins("x2", "p-repo", "README.md:notes")).toThrow(); // same project+ref
  expect(() => ins("x3", null, "README.md:notes")).not.toThrow(); // orphan
  expect(() => ins("x4", null, "README.md:notes")).not.toThrow(); // orphan NULLs distinct (intentional)
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm --prefix server test -- artifact-space-migration`
Expected: FAIL — `dropArtifactSpaceColumn` not exported; index still keyed on space_id.

- [ ] **Step 3: Implement `dropArtifactSpaceColumn`**

```typescript
// append to server/src/artifact-space-migration.ts
export function dropArtifactSpaceColumn(db: Database.Database): void {
  const hasCol = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).some((c) => c.name === "space_id");
  if (hasCol) {
    db.exec("DROP INDEX IF EXISTS artifacts_space_source_ref_uq");
    // DROP COLUMN requires SQLite ≥ 3.35 (2021); better-sqlite3 v12 bundles a
    // newer SQLite, so this is supported. We deliberately do NOT swallow a
    // failure — dropping the column is the whole point of this migration; a
    // silent no-op would hide a real problem and leave the schema half-done.
    // If a future runtime ever lacks DROP COLUMN support, this throws at boot
    // (loud + visible) rather than degrading quietly.
    db.exec("ALTER TABLE artifacts DROP COLUMN space_id");
  }
  // Idempotent: ensure the new dedup index exists regardless of whether the
  // column was just dropped or dropped on a prior boot.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS artifacts_project_source_ref_uq
             ON artifacts(project_id, source_ref) WHERE source_ref IS NOT NULL`);
}
```

- [ ] **Step 4: Re-key the index in `db.ts` and call the drop**

In `server/src/db.ts`, replace the `artifacts_space_source_ref_uq` creation block (`:114-120`) — leave it (it's harmless if the column's already dropped via IF NOT EXISTS guard order); the authoritative index is now created in `dropArtifactSpaceColumn`. After the `backfillArtifactProjects` call added in Task 2, add:

```typescript
dropArtifactSpaceColumn(db); // import alongside backfillArtifactProjects
```

> Order matters: `backfillArtifactProjects` (needs `space_id` for the report) runs first, then `dropArtifactSpaceColumn`. The old `artifacts_space_source_ref_uq` CREATE at `db.ts:114-120` must be **removed** (the column won't exist) — delete those lines; `dropArtifactSpaceColumn` now owns the dedup index. (`getAll`'s ORDER BY already uses `p.space_id` from Task 3, so nothing to change here.)

- [ ] **Step 5: Run tests + full suite + build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: all PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/artifact-space-migration.ts server/src/db.ts server/src/artifact-store.ts server/test/artifact-space-migration.test.ts
git commit -m "feat(artifacts): drop space_id column; re-key dedup index to (project_id, source_ref)"
```

---

## Task 8: Full verification + changelog check

- [ ] **Step 1: Whole suite + typecheck + web build**

Run: `npm --prefix server test && npm --prefix server run build && npm --prefix web run build`
Expected: all green. The web build confirms no `Artifact.spaceId` type ripple.

- [ ] **Step 2: Boot against a copy of the real DB and read the report**

```bash
cp -r ~/Oyster /tmp/oyster-modelfix-check
OYSTER_USERLAND=/tmp/oyster-modelfix-check node server/dist/server/src/index.js  # observe [artifact-space] log lines, then Ctrl-C
```
Expected: `[artifact-space] backfilled ~131 …` and a short mismatch list. Eyeball the mismatches with Matthew; the project should be the correct owner in each.

- [ ] **Step 3: Changelog decision**

The model fix is internal. **User-visible only if** the desktop UI exposes "move artefact to a different space" (which `update_artifact`/the route no longer supports directly). Grep web for an artefact-space-move control:

Run: `grep -rniE "move.*art+e?fact|artifact.*space|changeSpace" web/src | head`
- If a UI control exists → add a CHANGELOG `Changed` bullet ("Artefacts now follow their project's space") and run `npm run build:changelog`.
- If not → no changelog entry (internal change).

- [ ] **Step 4: Final commit (if changelog touched)**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): artefacts follow their project's space"
```

---

## Notes for the implementer

- **Every commit leaves the app working.** The column is read until Task 3, written until Task 4, and only dropped in Task 7 once nothing uses it.
- **Don't touch `shared/types.ts` `Artifact.spaceId`** — it stays `string`, populated by the derived store column.
- **Don't remove `projects.space_id`** or any space plumbing — spaces still organise projects. Out of scope.
- **No reactive registration** — that's Plan 2 (`2026-05-24-session-output-registration-design.md`), built on this.
- If a TS call site breaks because it passed `space_id` to `registerArtifact`, that's expected — switch it to omit `space_id` (project resolves from path) or pass `project_id`.
- **Path portability (residual):** native-folder construction and containment now use `path.join` / `path.relative` / `path.sep` (platform-correct). One known residual remains — the longest-prefix `resolveProject` SQL uses `LIKE pp.path || '/%'` with a hard-coded `/`. On the current (macOS) machine all stored `storage_config.path` and `project_paths.path` are POSIX, so this is correct here. If Oyster targets Windows, normalise both sides to `/` before the `LIKE` (or store canonical POSIX paths). Out of scope for this PR; flagged so it isn't a silent surprise.

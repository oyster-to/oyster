# Artifact's home is the project; space is derived

**Date:** 2026-05-24
**Status:** Draft — pending Matthew's review
**Author:** Matthew Slight + Claude
**Driver:** Surfaced while planning reactive session-output registration. A fresh user has **0 spaces**, but `artifacts.space_id` is `NOT NULL` — so registration can't create artefacts for the very user the feature targets. Root cause: the artifact→space coupling is a 0.4/0.5-era model where space was the artifact's parent. It should be derived.

> **Sequencing:** this is **Plan 1**, a foundational data-model fix. The reactive-registration + search feature (`2026-05-24-session-output-registration-design.md`) is **Plan 2** and builds on the corrected model. Plan 2's spec needs a one-spot amendment after this lands (reactive outputs resolve `project_id` from the touched file, space derived — no `space_id` param).

---

## Principle

An artifact's intrinsic facts are: **its file** (a path), **its home** (the project / folder the file lives in), and **its provenance** (the sessions that touched it). A **space** is none of these — it's a user's *organisational grouping of projects*. So an artifact's space is **derived**: `artifact → project → space`. It must not be a stored, required parent.

```
Session ──touches──▶ Artifact ──lives in──▶ Project ──filed under (optional)──▶ Space
            (provenance)         (home: project_id)         (organisation, derived)
```

`artifacts.space_id NOT NULL` is the last un-demoted holdover of the old "space is parent" model. `artifacts.project_id` already exists (added in the sessions era, `db.ts:500`). Sessions-first already made `sessions.space_id` and `projects.space_id` nullable. This change finishes that migration: **project is the home, space is derived, `artifacts.space_id` is dropped.**

**Confirmed scope is local-only:** the cloud `published_artifacts` table carries `space_id` in its *wire payload* but no schema dependency on the artifact→space coupling exists; `space-sync-service` syncs only the `spaces` table. Production has 3 auth users (Matthew + two one-time sign-ins on 2026-05-16 that never synced); the 13 published / 6 synced-spaces / 144 synced-sessions footprint is all Matthew's. The migration must be **data-preserving and idempotent** (one external install exists), but needs no cloud or backward-compat code shims — we own every reader.

## Current state (measured, main DB)

- 202 active artifacts; **all 202 have a space**, only 71 have a `project_id`.
- **131 have a space but no project.** All 131 have a file path, and **all 131 resolve to a containing project** via longest-prefix `project_paths` match.
- 0 have a project but no space.

So a `project_id` backfill can cover every space-bearing artifact before `space_id` is dropped — nobody is orphaned.

## Target model

- `artifacts.project_id` (already exists, nullable) is the **home**. Null = fully orphan (file outside any tracked project) — allowed; such an artifact has no space until its folder is organised.
- `artifacts.space_id` column is **dropped**.
- An artifact's space is **derived in the store layer** via `LEFT JOIN projects`. The `Artifact` TypeScript type keeps `spaceId` unchanged — it's now computed, not stored — so **all ~18 web components, `rowToArtifact`, and every API consumer keep working untouched.**

## Derivation strategy — single point, in the store SELECTs

Every artifact-store SELECT gains `LEFT JOIN projects p ON p.id = a.project_id` and selects `COALESCE(p.space_id, '') AS space_id`. The `COALESCE` to `''` (not `NULL`) is deliberate: the codebase already treats empty-string space as "no space" (`db.ts:837` `WHERE space_id IS NOT NULL AND space_id != ''`), so `ArtifactRow.space_id` stays typed `string` and `Artifact.spaceId` keeps its `string` shape — **no type ripple into the 18 consumers**. `rowToArtifact` (`artifact-service.ts:707-750`, both branches set `spaceId: row.space_id`) is **unchanged**. This is the whole trick: derive once at the read boundary, leave consumers alone.

- `getAll` / `getById` / `getByPath` / `getBySpaceAndSourceRef`: rewrite SELECT to `LEFT JOIN projects` and `COALESCE(p.space_id,'') AS space_id`.
- `getBySpaceId(spaceId)` → `... JOIN projects p ON p.id = a.project_id WHERE p.space_id = ? AND a.removed_at IS NULL` (inner join — orphans aren't in any space).
- `getDistinctSpaces()` → `... JOIN projects p ON p.id = a.project_id WHERE a.removed_at IS NULL GROUP BY p.space_id`.

## Migration (boot-time, in `initDb`, idempotent)

Run as one transaction in `initDb`, guarded so repeat boots are no-ops (detect `space_id` column presence via `PRAGMA table_info(artifacts)`).

0. **Ensure a native project per space that holds created content.** Artifacts whose file lives under `~/Oyster/spaces/<space-id>/` (agent-created via `create_artifact` — 18 on the main DB, 0 project-resolvable since no `project_paths` point there) get a **native project**: for each such space, ensure a `projects` row bound to that space and a `project_paths` entry `path = <userland>/spaces/<space-id>`. The model stays uniform — *every* artifact is project-parented; a space's native folder is simply a project filed under that space. The backfill in step 1 then resolves these via the same longest-prefix match.
1. **Backfill `project_id`** for every artifact (active and tombstoned) that has `project_id IS NULL` and a `storage_config.$.path`, using **longest-prefix** `project_paths` match:
   ```sql
   UPDATE artifacts
      SET project_id = (
        SELECT pp.project_id FROM project_paths pp
        WHERE json_extract(artifacts.storage_config,'$.path') LIKE pp.path || '/%'
           OR json_extract(artifacts.storage_config,'$.path') = pp.path
        ORDER BY LENGTH(pp.path) DESC LIMIT 1)
    WHERE project_id IS NULL
      AND json_extract(storage_config,'$.path') IS NOT NULL;
   ```
2. **Log a before/after report** (informational, never a failure), captured *before* the column is dropped:
   - total artifacts; how many had a non-empty `space_id`; how many `project_id` were just backfilled; how many still have `project_id IS NULL` after backfill (→ will be orphan); 
   - the **mismatch list**: artifacts whose *old* `space_id` differs from their newly-resolved `project → space_id` (id, path, old space, new space). Matthew eyeballs these once; with 506 path-derived `discovered` artifacts the set should be tiny. The project wins — this is just visibility, not a prompt.
3. **Rebuild the table without `space_id`** (SQLite `ALTER TABLE artifacts DROP COLUMN space_id` is available ≥3.35 and already used at `db.ts:112` for `repo_path`; prefer it, fall back to a `_artifacts_new` rebuild if a dependent object blocks it). Data preserved.
4. **Rebuild the dedup index** `artifacts_space_source_ref_uq` (`db.ts:116`) from `(space_id, source_ref)` → **`(project_id, source_ref) WHERE source_ref IS NOT NULL`** (keep the existing partial predicate).

   **Explicit `project_id IS NULL` behaviour:** SQLite treats `NULL`s as distinct under `UNIQUE`, so this index does **not** constrain orphan artifacts (no project) — multiple orphans with the same `source_ref` are permitted by the index. This is **intentional and safe** because the authoritative dedup for *every* filesystem artifact is `getByPath` (the absolute path in `storage_config`), which is independent of project and `source_ref`. The `(project_id, source_ref)` index is a secondary guard for the scanner's `<path>:<kind>` convention *within a known project*; orphan dedup rides on `getByPath`. (In practice `source_ref`-bearing artifacts are always created in a project context, so orphan + `source_ref` is essentially nonexistent — but the behaviour is now stated rather than accidental.)

## Code changes (the write/derive paths — from the audit)

- **`artifact-store.ts`**: drop `space_id` from the INSERT column list (`:83`) and from `UPDATABLE_COLUMNS` (`:130-134`); rewrite the six SELECTs to join projects; `getBySpaceAndSourceRef` keys on `(project_id, source_ref)` (`:78`).
- **`artifact-service.ts`**: `registerArtifact` (`:296`) takes `project_id?: string | null` instead of `space_id`; resolves it from the file path via `lookupProject` when not supplied. `createArtifact` (`:452`) resolves `project_id` from the target path. The returned `Artifact` literal (`:395`) sets `spaceId` from the resolved project's space. `updateArtifact` (`:589`) **drops** direct space reassignment — moving an artifact between spaces now means moving its **project** (or the file); document this. `reconcileGeneratedArtifact` (`:557`) passes `project_id` (from `artifact.projectId`).
- **`mcp-server.ts`**: `register_artifact` (`:594`) drops the `space_id` tool param — project (hence space) comes from the file's path. `create_artifact` (`:640`) **keeps** `space_id` (it still chooses *which* native folder to write into via `getNativeSourcePath(space_id)`), but the created artifact is parented to that space's **native project**, not given a stored `space_id`. `update_artifact` (`:663`) drops `space_id` reassignment. **MCP API change** (register/update), acceptable (single user, local tools); update tool descriptions.
- **`artifact-service.ts` `createArtifact`** ensures the space's native project exists (idempotent — same helper the migration uses) and passes its `project_id` to `registerArtifact`.
- **`publish-service.ts`**: `publishArtifact` (`:143,182`) and `backfillPublications` (`:444-474`) derive `space_id` via `JOIN projects` before bundling it into the cloud payload. Wire format unchanged.
- **`import.ts`** (`:538-580`) and **`routes/import.ts`** (`:84`): `createArtifact` calls resolve a `project_id` for the target folder/space context instead of passing `space_id`.

## What stays unchanged

- `shared/types.ts` `Artifact.spaceId` (now derived, same shape).
- `rowToArtifact` — reads `row.space_id` which the joined SELECT still provides.
- All ~18 web components reading `artifact.spaceId` off API responses (`App.tsx`, `SpotlightSearch.tsx`, `ChatBar.tsx`, `ArtefactInspector.tsx`, …).
- `getByPath` semantics (matches absolute path in `storage_config`).
- `space-sync-service` (syncs the `spaces` table only).

## Project resolution helper

Reuse `lookupProject(db, dir, …)` (`lookup-project.ts:35`) for path→project on the live/registration path (marker walk + `project_paths` fallback, returns `{projectId, spaceId}`; pass the file's `dirname`). The migration uses the longest-prefix SQL above directly (it must match orphan-project files too, which `lookupProject` step 2 deliberately skips).

## Error handling & edge cases

- **Path under no project** → `project_id` stays null → derived space `''` → artifact is orphan (valid; matches the existing `space_id != ''` "no space" convention). It gains a space when its folder is organised.
- **Ambiguous longest-prefix** (two `project_paths` of equal length) → `LIMIT 1` picks one deterministically; logged in the mismatch report.
- **Tombstoned artifacts** are backfilled too, so undelete/recovery keeps working post-drop.
- **Repeat boots** → column already absent → migration block skips (idempotent).

## Testing

- **Migration parity (fixture DB):** seed artifacts mirroring the real split (some `space_id` + no project, some both, one path under no project). After migration: every artifact's *derived* space equals its pre-migration `space_id` where a project resolved; the path-less/project-less one becomes null; assert exact counts (e.g. 131-analogue all resolve).
- **Mismatch report:** seed one artifact whose `space_id` disagrees with its resolved project's space; assert it appears in the logged report and the project wins.
- **Idempotency:** run `initDb` twice; second boot makes no changes (no `space_id` column, no project_id rewrites).
- **Derived queries:** `getBySpaceId(s)` returns exactly the artifacts whose project is in space `s`; `getDistinctSpaces` matches; an orphan (null project) appears in none.
- **Dedup index:** two artifacts, same `source_ref`, same project → second insert rejected; same `source_ref`, different project → both allowed; two orphans (`project_id NULL`), same `source_ref` → both allowed (NULLs distinct, intentional), while `getByPath` still rejects a duplicate at the same absolute path.
- **Before/after report:** assert the migration logs total / had-space / project-backfilled / still-orphan counts and the mismatch list (seed a known mismatch, assert it's reported and the project's space wins).
- **No regression:** existing artifact tests (`db-artefact-tombstone-recovery.test.ts`, etc.) pass.

## Non-goals

- No change to the `Artifact` type or web grid behaviour (space still appears, derived).
- No cloud/worker schema change.
- No reactive registration (Plan 2).
- No removal of `projects.space_id` or other space plumbing — spaces still organise projects.

## Key files

`server/src/artifact-store.ts`, `server/src/artifact-service.ts`, `server/src/db.ts`, `server/src/mcp-server.ts`, `server/src/publish-service.ts`, `server/src/import.ts`, `server/src/routes/import.ts`, `server/src/lookup-project.ts`, `shared/types.ts`.

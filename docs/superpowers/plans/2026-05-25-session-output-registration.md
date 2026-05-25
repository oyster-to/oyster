# Reactive session-output registration + path-indexed search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Read the spec first:** `docs/superpowers/specs/2026-05-24-session-output-registration-design.md` — it has the full *why/purpose/goal* and the v0.10.0 lineage. This plan turns it into tasks.
>
> **Branch/worktree:** `session-output-registration`, off `main` at v0.10.0 (`d3a3eb4`). Built on the artifact→project model: `registerArtifact` takes `project_id` (not `space_id`); space is derived.

**Goal:** Artefacts populate themselves from session history — curated *output* chips per session, and every touched source file searchable by name — without polluting the grid.

**Architecture:** A single pass over `session_events` (boot, debounced, background, newest-first, high-water-marked) parses each event's `raw` once and does two jobs: **(A)** re-render `text` to embed the tool's relative file path so the existing FTS finds it; **(B)** if the touched path is a *useful output*, register it (parented to the session's `project_id`) and link it to the session. Live ingestion does both inline for new events. A one-time historical sweep covers existing events.

**Tech Stack:** TypeScript, better-sqlite3, vitest (`server/test/*.test.ts`, run `npm --prefix server test`). ESM `.js` imports. Spec: `2026-05-24-session-output-registration-design.md`.

> **Re-verify line numbers** before editing — they predate any drift. Confirmed at plan time (v0.10.0): `renderEvent` `claude-code.ts:1041`, `artifactTouchFromToolUse` `:1106`, `RenderedEvent` `:1033`; `session_artifacts` schema `db.ts:299-305`; `registerArtifact(params: { path, project_id?, label, ... })` in `artifact-service.ts`; sessions carry `project_id` (`session-store.ts`).

---

## File structure

- **Create** `server/src/output-classifier.ts` — `classifyOutput(path): ArtifactKind | null` (allow-list × secret/noise deny-list). Pure, no deps.
- **Create** `server/src/session-output-sweep.ts` — the historical sweep (`runOutputBackfill(db, deps)`), high-water-mark state, and the shared per-touch handler `registerTouchedOutput(...)` used by both the sweep and live ingestion.
- **Modify** `server/src/watchers/claude-code.ts` — `renderEvent` embeds relative paths (Job A); `consumeOnce` calls the per-touch handler inline (Job B live).
- **Modify** `server/src/db.ts` — `session_artifacts` UNIQUE migration; `output_backfill_state` single-row table; kick the sweep after boot.
- **Modify** `server/src/session-store.ts` — `insertArtifactTouch` becomes `INSERT OR IGNORE` and accepts `when_at`.
- **Create tests** per task.

**Sequencing rule:** every commit leaves `npm --prefix server test` green and `tsc` clean. Search-re-render (Job A) and registration (Job B) are independent and can land in either order; the UNIQUE migration precedes Job B linking.

---

## Task 1: Output classifier (allow-list × deny-list)

**Files:** Create `server/src/output-classifier.ts`; Test `server/test/output-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/output-classifier.test.ts
import { describe, it, expect } from "vitest";
import { classifyOutput } from "../src/output-classifier.js";

describe("classifyOutput", () => {
  it("classifies allowed output types by extension", () => {
    expect(classifyOutput("/r/report.md")).toBe("notes");
    expect(classifyOutput("/r/data.csv")).toBe("table");
    expect(classifyOutput("/r/deck.pdf")).toBe("deck");
    expect(classifyOutput("/r/diagram.mmd")).toBe("diagram");
    expect(classifyOutput("/r/page.html")).toBe("wireframe");
    expect(classifyOutput("/r/nb.ipynb")).toBe("notebook");
  });
  it("rejects source code and unknown extensions", () => {
    expect(classifyOutput("/r/src/App.tsx")).toBeNull();
    expect(classifyOutput("/r/main.py")).toBeNull();
    expect(classifyOutput("/r/Makefile")).toBeNull();
    expect(classifyOutput("/r/data.bin")).toBeNull();
  });
  it("rejects images in v1", () => {
    expect(classifyOutput("/r/logo.png")).toBeNull();
    expect(classifyOutput("/r/icon.svg")).toBeNull();
  });
  it("applies the secret/noise/vendor deny-list even to allowed extensions", () => {
    expect(classifyOutput("/r/.env")).toBeNull();
    expect(classifyOutput("/r/secrets/notes.md")).toBeNull();
    expect(classifyOutput("/r/node_modules/foo/readme.md")).toBeNull();
    expect(classifyOutput("/r/dist/index.html")).toBeNull();
    expect(classifyOutput("/r/.cache/x.md")).toBeNull();
    expect(classifyOutput("/tmp/scratch.md")).toBeNull();
    expect(classifyOutput("/r/.git/COMMIT_EDITMSG.md")).toBeNull();
    expect(classifyOutput(process.env.HOME + "/.ssh/notes.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails** — `npm --prefix server test -- output-classifier` → module not found.

- [ ] **Step 3: Implement**

```typescript
// server/src/output-classifier.ts
import type { ArtifactKind } from "../../shared/types.js"; // confirm the ArtifactKind import path/name

// Allow-list: known useful OUTPUT extensions → artefact kind. Source code,
// config, images (v1), and unknown extensions are NOT registered.
const KIND_BY_EXT: Record<string, ArtifactKind> = {
  md: "notes", markdown: "notes", txt: "notes", rst: "notes", rtf: "notes",
  docx: "notes", doc: "notes", pages: "notes", odt: "notes",
  csv: "table", tsv: "table", xlsx: "table", xls: "table", ods: "table", numbers: "table", parquet: "table",
  pdf: "deck", pptx: "deck", key: "deck", odp: "deck",
  mmd: "diagram", mermaid: "diagram", dot: "diagram", drawio: "diagram", excalidraw: "diagram",
  html: "wireframe", htm: "wireframe",
  ipynb: "notebook",
};

// Hard deny-list (path/name), applied even to allowed extensions: secrets,
// dependencies/vendor, caches, build output, temp, VCS, hidden dirs.
const DENY_SEGMENT = /(^|\/)(node_modules|vendor|bower_components|\.pnpm-store|\.venv|venv|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|dist|build|target|\.next|\.nuxt|out|coverage|\.git|tmp|\.ssh|\.aws|secrets)(\/|$)/;
const DENY_NAME = /(^|\/)(\.env|\.npmrc|\.netrc|\.DS_Store|id_rsa|id_dsa|credentials)|\.(pem|key|p12|pfx|keystore|tmp|temp|swp)$|~$/i;
const HIDDEN_DIR = /\/\.[^/]+\//; // any intermediate directory segment beginning with "."

function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}

/** Returns the artefact kind for a *useful output* file, or null if the path
 *  is source code, an unknown type, or matches the secret/noise deny-list. */
export function classifyOutput(path: string): ArtifactKind | null {
  if (DENY_SEGMENT.test(path) || DENY_NAME.test(path) || HIDDEN_DIR.test(path)) return null;
  return KIND_BY_EXT[ext(path)] ?? null;
}
```

> Note `.env` is caught by `DENY_NAME` (it has no allowed extension anyway). The `.ssh`/`.aws`/`secrets` cases are caught by `DENY_SEGMENT`. `key` as an extension (`*.key` deck) collides with secret `*.key` — `DENY_NAME` runs first and wins, which is the safe choice.

- [ ] **Step 4: Run, verify pass** — `npm --prefix server test -- output-classifier`.
- [ ] **Step 5: Commit** — `git commit -m "feat(registration): output classifier (allow-list × secret/noise deny-list)"`

---

## Task 2: `renderEvent` embeds relative file paths (Job A)

**Files:** Modify `server/src/watchers/claude-code.ts`; Test `server/test/render-event-paths.test.ts`

Goal: `[Write]` → `[Write src/App.jsx]` so the existing FTS (`session_events_fts` over `text`) finds touched files by name. Path is **relative** to the session `cwd` when under it; else `~`-collapsed; else absolute.

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/render-event-paths.test.ts
import { describe, it, expect } from "vitest";
import { renderEvent } from "../src/watchers/claude-code.js";

const toolUse = (name: string, file: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: { file_path: file } }] },
});

describe("renderEvent embeds relative file paths", () => {
  it("renders a Write under cwd as a relative path", () => {
    const r = renderEvent(toolUse("Write", "/repo/src/App.jsx"), "/repo");
    expect(r?.text).toContain("App.jsx");
    expect(r?.text).toBe("[Write src/App.jsx]");
  });
  it("collapses a path under HOME but outside cwd to ~", () => {
    const home = process.env.HOME!;
    const r = renderEvent(toolUse("Read", `${home}/.claude/settings.json`), "/repo");
    expect(r?.text).toBe("[Read ~/.claude/settings.json]");
  });
  it("covers Edit / MultiEdit / NotebookEdit", () => {
    expect(renderEvent(toolUse("Edit", "/repo/a.md"), "/repo")?.text).toBe("[Edit a.md]");
    expect(renderEvent(toolUse("MultiEdit", "/repo/a.md"), "/repo")?.text).toBe("[MultiEdit a.md]");
    expect(renderEvent(toolUse("NotebookEdit", "/repo/n.ipynb"), "/repo")?.text).toBe("[NotebookEdit n.ipynb]");
  });
  it("still renders non-path tool calls and prose unchanged", () => {
    const bash = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } };
    expect(renderEvent(bash, "/repo")?.text).toBe("[Bash]");
  });
});
```

- [ ] **Step 2: Run, verify it fails** — current `renderEvent` ignores the 2nd arg and renders `[Write]`.

- [ ] **Step 3: Implement** — add a `cwd` param and a relative-path helper.

In `claude-code.ts`, add near the top of the file (or beside `artifactTouchFromToolUse`):

```typescript
import { relative, isAbsolute } from "node:path"; // ensure imported

/** Display form for a touched file path: relative to the session cwd when
 *  under it; else ~-collapsed; else absolute. Never a bare local absolute path
 *  when avoidable. */
export function displayTouchPath(filePath: string, cwd: string | null | undefined): string {
  if (cwd) {
    const rel = relative(cwd, filePath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  const home = process.env.HOME;
  if (home && (filePath === home || filePath.startsWith(home + "/"))) return "~" + filePath.slice(home.length);
  return filePath;
}
```

Change the signature `renderEvent(ev: Record<string, any>): RenderedEvent | null` → `renderEvent(ev: Record<string, any>, cwd?: string | null): RenderedEvent | null`. In BOTH tool_use rendering branches (the pure tool-call turn ~`:1077` and the mixed-content map ~`:1083`), when a block is a `tool_use` with a string `input.file_path`, render `[${name} ${displayTouchPath(file_path, cwd)}]` instead of `[${name}]`. Tool calls without a `file_path` (Bash, etc.) stay `[${name}]`.

Update the two call sites in the watcher (`backfillRange` and `consumeOnce`) to pass the session cwd: `renderEvent(ev, meta.cwd)` / `renderEvent(ev, tracker.cwd)` — confirm the exact cwd variable in scope at each call.

- [ ] **Step 4: Run, verify pass** — `npm --prefix server test -- render-event-paths`, then full suite (existing inspector/render tests must still pass — they may assert `[Write]`; update any that now legitimately see the path, but do NOT weaken — the path is the intended new behaviour).
- [ ] **Step 5: Commit** — `git commit -m "feat(search): renderEvent embeds relative tool file paths so FTS finds touched files"`

> User-visible (inspector timeline shows the path; search finds files). **CHANGELOG entry required** — defer the actual entry to Task 8.

---

## Task 3: `session_artifacts` UNIQUE migration + idempotent touch insert

**Files:** Modify `server/src/db.ts`, `server/src/session-store.ts`; Test `server/test/session-artifacts-unique.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/test/session-artifacts-unique.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("session_artifacts UNIQUE(session_id, artifact_id, role)", () => {
  let dir: string; let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-sau-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id,display_name,color,scan_status) VALUES ('s','S','#000','none')`);
    db.prepare(`INSERT INTO projects (id,space_id,name) VALUES ('p','s','proj')`).run();
    db.exec(`INSERT INTO sessions (id,agent,state,project_id) VALUES ('sess','claude-code','done','p')`);
    db.prepare(`INSERT INTO artifacts (id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config,project_id) VALUES ('a','a','notes','filesystem','{}','static_file','{}','p')`).run();
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("rejects a duplicate (session, artifact, role) and keeps one row", () => {
    const ins = db.prepare(`INSERT OR IGNORE INTO session_artifacts (session_id, artifact_id, role, when_at) VALUES ('sess','a','create',?)`);
    ins.run("2026-01-01T00:00:00Z");
    ins.run("2026-01-02T00:00:00Z"); // dup (session,artifact,role) — ignored
    const n = db.prepare("SELECT COUNT(*) AS n FROM session_artifacts WHERE session_id='sess' AND artifact_id='a' AND role='create'").get() as { n: number };
    expect(n.n).toBe(1);
  });
  it("allows the same artifact with a different role", () => {
    db.prepare(`INSERT OR IGNORE INTO session_artifacts (session_id,artifact_id,role) VALUES ('sess','a','create')`).run();
    db.prepare(`INSERT OR IGNORE INTO session_artifacts (session_id,artifact_id,role) VALUES ('sess','a','modify')`).run();
    const n = db.prepare("SELECT COUNT(*) AS n FROM session_artifacts WHERE session_id='sess' AND artifact_id='a'").get() as { n: number };
    expect(n.n).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify it fails** — without the unique index the first test yields 2 rows.

- [ ] **Step 3: Implement the migration** (in `initDb`, `db.ts`). The base table can't gain a UNIQUE via `ALTER`; de-dup then add a unique index (idempotent):

```typescript
// after the session_artifacts CREATE / its indexes (~db.ts:299-307)
// De-dup any existing rows, keeping the newest when_at per (session,artifact,role).
db.exec(`
  DELETE FROM session_artifacts WHERE id NOT IN (
    SELECT MAX(id) FROM session_artifacts GROUP BY session_id, artifact_id, role
  );
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS session_artifacts_uq
           ON session_artifacts(session_id, artifact_id, role)`);
```

> `MAX(id)` keeps the most-recently-inserted row; acceptable for de-dup. (If you prefer newest `when_at`, group-select by that — `id` is fine here since dupes are near-identical.)

- [ ] **Step 4: Make `insertArtifactTouch` idempotent + timestamp-aware** (`session-store.ts`). Change the prepared statement to `INSERT OR IGNORE INTO session_artifacts (session_id, artifact_id, role, when_at) VALUES (@session_id, @artifact_id, @role, COALESCE(@when_at, datetime('now')))` and add `when_at?: string` to `InsertSessionArtifact`. Existing callers that omit `when_at` keep working (defaults to now()).

- [ ] **Step 5: Run** the new test + full suite (the existing backfill/touch tests must still pass). **Commit** — `git commit -m "feat(sessions): UNIQUE(session,artifact,role) on session_artifacts; idempotent touch insert with when_at"`

---

## Task 4: Per-touch output registration (Job B core)

**Files:** Create `server/src/session-output-sweep.ts` (the shared handler); Test `server/test/regist(...)` 

This is the reusable unit both the historical sweep and live ingestion call. Given a touch, classify → register output (parented to the **session's project_id**) → link.

- [ ] **Step 1: Write the failing test** (integration, fixture DB + real `ArtifactService`)

```typescript
// server/test/session-output-register.test.ts
// Build a DB via initDb; seed a space 's', project 'p' (space 's') with a
// project_paths entry '/repo'; a session 'sess' with project_id 'p'; construct
// an ArtifactService (mirror server/test/artifact-service*.test.ts setup).
// Then call registerTouchedOutput for:
//   - /repo/report.md (create)  → expect an artefact registered with project_id 'p'
//     (so derived spaceId === 's'), kind 'notes', and a session_artifacts link (role create).
//   - /repo/src/App.tsx (modify) → expect NO artefact (source code), but NO throw.
//   - second call for /repo/report.md (modify) → expect the SAME artefact reused
//     (getByPath), a second link row (role modify), no duplicate artefact.
// Assert via store.getByPath and session_artifacts queries.
```

> Model the `ArtifactService` construction on `server/test/artifact-service-project.test.ts` (it already seeds project_paths and asserts derived space). Write the assertions concretely there.

- [ ] **Step 2: Run, verify it fails** — handler not implemented.

- [ ] **Step 3: Implement** `registerTouchedOutput`:

```typescript
// server/src/session-output-sweep.ts (partial — the shared handler)
import type Database from "better-sqlite3";
import { classifyOutput } from "./output-classifier.js";
import type { ArtifactService } from "./artifact-service.js";
import type { SessionStore } from "./session-store.js";

export interface Touch { sessionId: string; path: string; role: "create" | "modify" | "read"; whenAt: string; }

export interface SweepDeps {
  db: Database.Database;
  service: ArtifactService;     // registerArtifact (resolves/accepts project_id)
  sessionStore: SessionStore;   // insertArtifactTouch (INSERT OR IGNORE, when_at)
}

/** Register a touched *output* file (if it qualifies) and link it to the
 *  session. Parents the artefact to the session's project_id (space derives via
 *  project). No-op for source/unknown/secret paths. Idempotent (getByPath +
 *  INSERT OR IGNORE link). Read touches do not register (only create/modify),
 *  but a read of an ALREADY-registered output still links. */
export async function registerTouchedOutput(deps: SweepDeps, touch: Touch): Promise<void> {
  const existing = deps.db.prepare("SELECT id FROM artifacts WHERE json_extract(storage_config,'$.path') = ? AND removed_at IS NULL").get(touch.path) as { id: string } | undefined;
  let artifactId = existing?.id;

  if (!artifactId) {
    if (touch.role === "read") return;                 // don't register on read-only
    if (!classifyOutput(touch.path)) return;            // not a useful output
    const projectId = sessionProjectId(deps.db, touch.sessionId);
    const art = await deps.service.registerArtifact(
      { path: touch.path, project_id: projectId, label: basename(touch.path), source_origin: "discovered" },
      [], // trusted: paths come from the user's own session history
    );
    artifactId = art.id;
  }
  deps.sessionStore.insertArtifactTouch({ session_id: touch.sessionId, artifact_id: artifactId, role: touch.role, when_at: touch.whenAt });
}

function sessionProjectId(db: Database.Database, sessionId: string): string | null {
  return (db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId) as { project_id: string | null } | undefined)?.project_id ?? null;
}
```

> `basename` from `node:path`. `registerArtifact` already infers a default id/kind from the path when omitted — confirm and rely on it, or pass `artifact_kind: classifyOutput(touch.path)!` explicitly to avoid a second inference. Prefer passing the kind explicitly (we already computed it).

- [ ] **Step 4: Run** the test → pass. **Commit** — `git commit -m "feat(registration): registerTouchedOutput — register session-touched outputs, parented to the session's project"`

---

## Task 5: Historical sweep + high-water mark

**Files:** Modify `server/src/session-output-sweep.ts` (add `runOutputBackfill`), `server/src/db.ts` (state table); Test `server/test/session-output-sweep.test.ts`

- [ ] **Step 1: Add the state table** (`db.ts`, single-row, `CHECK (id = 1)` idiom like `profile_binding`):

```sql
CREATE TABLE IF NOT EXISTS output_backfill_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  done         INTEGER NOT NULL DEFAULT 0,   -- 1 once the historical sweep finishes
  low_water_id INTEGER NOT NULL DEFAULT 0    -- lowest session_events.id processed so far (sweep goes newest→oldest)
);
INSERT OR IGNORE INTO output_backfill_state (id, done, low_water_id) VALUES (1, 0, 0);
```

- [ ] **Step 2: Write the failing test** — seed `session_events` (with `raw` containing `Write`/`Edit`/`Read` tool_use blocks at known paths, some outputs, some source, some secret) for a session with a project; run `runOutputBackfill`; assert:
  - the right output artefacts registered (parented to the session's project; derived space correct);
  - `session_artifacts` links created with `when_at` derived from the event;
  - `session_events.text` for touch-bearing rows now contains the relative path (FTS: `searchSessions("App.jsx")` returns the session);
  - re-running `runOutputBackfill` is a **no-op** (`done=1`);
  - a source file (`App.tsx`) is searchable (text re-rendered) but NOT registered.

- [ ] **Step 3: Implement `runOutputBackfill`** — one batched pass, newest-first, doing Job A + Job B per event, advancing the high-water mark, idempotent:

```typescript
// server/src/session-output-sweep.ts (add)
import { renderEvent, artifactTouchFromToolUse } from "./watchers/claude-code.js";

const BATCH = 5000;

/** One-time historical pass: for every session_event, re-render text with file
 *  paths (Job A: search) and register/link touched outputs (Job B: chips).
 *  Idempotent via output_backfill_state.done. Safe to run in the background. */
export async function runOutputBackfill(deps: SweepDeps): Promise<{ events: number; registered: number; links: number }> {
  const state = deps.db.prepare("SELECT done FROM output_backfill_state WHERE id = 1").get() as { done: number } | undefined;
  if (state?.done) return { events: 0, registered: 0, links: 0 };

  const sessionCwd = deps.db.prepare("SELECT cwd FROM sessions WHERE id = ?");
  const updateText = deps.db.prepare("UPDATE session_events SET text = ? WHERE id = ?");
  const setLow = deps.db.prepare("UPDATE output_backfill_state SET low_water_id = ? WHERE id = 1");
  let cursor = Number.MAX_SAFE_INTEGER;
  const report = { events: 0, registered: 0, links: 0 };

  for (;;) {
    const rows = deps.db.prepare(
      `SELECT id, session_id, raw FROM session_events
        WHERE id < ? AND raw IS NOT NULL AND role IN ('assistant','tool')
        ORDER BY id DESC LIMIT ?`,
    ).all(cursor, BATCH) as { id: number; session_id: string; raw: string }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      let parsed: any;
      try { parsed = JSON.parse(row.raw); } catch { continue; }
      // Job A: re-render text with paths (cheap UPDATE; FTS triggers re-index).
      const cwd = (sessionCwd.get(row.session_id) as { cwd: string | null } | undefined)?.cwd ?? null;
      const rendered = renderEvent(parsed, cwd);
      if (rendered) { updateText.run(rendered.text, row.id); report.events++; }
      // Job B: register + link touched outputs.
      const content = parsed?.message?.content;
      if (!Array.isArray(content)) continue;
      const whenAt = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
      for (const block of content) {
        const t = artifactTouchFromToolUse(block);
        if (!t) continue;
        const before = countLinks(deps.db);
        await registerTouchedOutput(deps, { sessionId: row.session_id, path: t.path, role: t.role, whenAt });
        if (countLinks(deps.db) > before) report.links++;
      }
    }
    setLow.run(cursor);
  }
  deps.db.prepare("UPDATE output_backfill_state SET done = 1 WHERE id = 1").run();
  return report;
}
function countLinks(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM session_artifacts").get() as { n: number }).n;
}
```

> `parsed.timestamp` — confirm the JSONL event timestamp field name (Claude Code events carry a `timestamp`; verify against a real `raw` row and adjust). The `registered` counter can be derived similarly if needed; links is the meaningful chip count. The `countLinks` per-touch is simple but O(touches) COUNT queries — fine for a one-time background pass; optimise only if measured slow.

- [ ] **Step 4: Run** the test → pass (incl. idempotency + FTS search). **Commit** — `git commit -m "feat(registration): one-time historical sweep (Job A re-render + Job B register/link) with high-water mark"`

---

## Task 6: Live ingestion hook

**Files:** Modify `server/src/watchers/claude-code.ts` (`consumeOnce`); Test extends the sweep test or a new watcher test.

Currently `consumeOnce` ingests new events and (post-v0.10.0) only links touches whose file is *already* a registered artefact. Replace that gate: for each touch in a newly-ingested event, call `registerTouchedOutput` (which registers the output if it qualifies, else no-ops) — so new outputs self-register live, and the search text already carries paths (Task 2 made `renderEvent` embed them on ingest).

- [ ] **Step 1: Write the failing test** — feed a synthetic appended JSONL event that writes `/repo/new-report.md` in a session with project `p`; after `consumeOnce`, assert the artefact is registered (project `p`) and linked. (Mirror the watcher test harness in `server/test/watchers-cwd.test.ts`.)
- [ ] **Step 2: Run, verify fails** (the old gate skips unregistered files).
- [ ] **Step 3: Implement** — in `consumeOnce`'s touch loop (~`claude-code.ts:835`), replace the `getByPath ... continue` gate with a call to `registerTouchedOutput(this.deps.sweepDeps, { sessionId, path: touch.path, role: touch.role, whenAt })`. Thread the `SweepDeps` (service + sessionStore + db) into the watcher's deps (they already hold `artifactStore`; add `service`/`sessionStore` if not present — confirm what the watcher already has). Keep ingestion non-blocking; `registerTouchedOutput` is fast (one getByPath + maybe one insert).
- [ ] **Step 4: Run** + full suite. **Commit** — `git commit -m "feat(registration): live ingestion self-registers touched outputs"`

---

## Task 7: Boot wiring (debounced, background)

**Files:** Modify `server/src/db.ts` or `server/src/index.ts` (wherever post-boot tasks kick off).

- [ ] **Step 1:** After the server is listening (find where other deferred/boot tasks run — e.g. the `cwd_project_backfill_v1` deferred backfill seen in boot logs), schedule `runOutputBackfill(deps)` ~5s after boot, in the background, non-blocking (`setTimeout` + `.catch(logError)`). It self-skips if `done=1`. Log a one-line summary (`[output-backfill] registered N outputs, M links, E events re-rendered`).
- [ ] **Step 2:** Manual/integration check: boot against a COPY of a real DB (never the live one) and confirm the log + that `searchSessions("App.jsx")` returns sessions and chips appear. **No automated test needed beyond Task 5's coverage** (the sweep is unit-tested; this step is wiring).
- [ ] **Step 3: Commit** — `git commit -m "feat(registration): kick the output backfill ~5s after boot (background, one-time)"`

---

## Task 8: Full verification + parity + changelog

- [ ] **Step 1:** `npm --prefix server test` (all green) + `npm --prefix server run build` (tsc clean) + `npm --prefix web run build` (note: web build was already red on `main` for unrelated `string|null` errors in `NewSessionPicker.tsx`/`PublishModal.tsx` — confirm no NEW errors from this work).
- [ ] **Step 2: Parity on a real-DB copy** (safe; never the live DB). Copy `~/Oyster/db/oyster.db` to a temp dir, run `runOutputBackfill`, assert registered-output and link counts land near the spec's measured figures (**~374 artefacts / ~882 links** on the main DB) within tolerance — guards against silent classifier/regression drift.
- [ ] **Step 3: CHANGELOG** — this IS user-visible (chips populate; search finds files). Add under `[Unreleased]`:
  - `### Added` — "**Sessions show what you made.** Each session now lists the documents, decks, and apps it produced, and Spotlight finds any file your agent touched by name."
  Run `npm run build:changelog`.
- [ ] **Step 4: Commit** — `git commit -m "docs(changelog): session output chips + file-name search"`

---

## Notes for the implementer

- **Every commit stays green.** Tasks 1–3 are independent foundations; Task 4 depends on 3 (linking) and the classifier (1); Task 5 depends on 2+4; Task 6 depends on 4; Task 7 depends on 5.
- **Parent to the session's project, never a space** — `registerArtifact` takes `project_id` (v0.10.0). A session with no project → orphan artefact (unsorted) — acceptable.
- **Don't build** a disk crawler, a rescan loop, a soft-delete sweep, a `session_file_touches` table, image support, or grid-filter UI — all explicit non-goals (see spec).
- **Verify the JSONL `timestamp` field name** and the watcher's available deps before Task 5/6.
- **`renderEvent` is exported and pure** — Task 2's change is safe to unit-test directly; the historical re-render reuses it.

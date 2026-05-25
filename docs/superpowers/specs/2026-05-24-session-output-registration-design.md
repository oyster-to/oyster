# Reactive session-output registration + path-indexed search

**Date:** 2026-05-24 (amended 2026-05-25, after the prerequisite model fix shipped)
**Status:** Draft — prerequisite landed (v0.10.0); ready for implementation planning
**Author:** Matthew Slight + Claude
**Driver:** Sessions-first 1.0 (#551) shipped FULL-view artifact chips that render empty for ~75% of an active user's sessions and 100% of a new user's. Diagnostic + design session 2026-05-24.

> **Naming note:** branch is `session-output-registration`. There is **no disk scanner** in this design — registration is reactive (driven by session history), not a filesystem crawl.

---

## Context & lineage — why this exists, and the detour that preceded it

**Why it came about.** Sessions-first 1.0 (#551) gave each session a FULL view with an artifact **chip** line — "these are the docs we produced." Dogfooding showed the chips render empty for ~75% of an active user's sessions and **100% of a brand-new user's**, because artifact registration depends on a dormant path: files an agent writes are never auto-registered, so the watcher's session→artefact linking almost never fires, and search can't find a touched file by name.

**Purpose.** Make artefacts **populate themselves** from what the agent actually did — so the surface feels alive on day one — without polluting the curated grid or making the user register anything by hand.

**Goal — three distinct layers** (conflating them caused earlier over-building):
1. **Chips** = curated *useful outputs* only (reports, decks, apps, invoices, notable `.md`/`.html`). Not `.ts`/`.js` churn.
2. **Search** finds any source file the agent touched, by name (e.g. `App.jsx`), even though it's never a chip.
3. **Grid** stays clean — source files are never artefacts.

Guiding line: **record everything for search, present only useful outputs as artefacts.**

**The last deviation — the prerequisite, now shipped as v0.10.0.** Planning this feature surfaced a hard blocker: a brand-new user has **zero spaces**, but `artifacts.space_id` was `NOT NULL` — so reactive registration literally *could not create an artefact* for the very user it targets. Root cause was a 0.4/0.5-era model where an artefact's parent was its **space**. We paused this work and fixed the model first:

> **An artefact's home is now its `project`; its space is *derived* via `artifact → project → space`.** The `space_id` column was dropped, a boot migration backfills `project_id` (longest-prefix `project_paths`; native workspace folders became projects bound to their space), and all readers derive space at the store boundary.

That landed as **PR #581 → released in v0.10.0 (2026-05-25)**, verified on the live DB (325 artefacts backfilled, 0 orphaned, model corrections applied). **Net effect for this spec:** reactive outputs are parented to a **project**, never a space — and a fresh user with no spaces is no longer a blocker. See *Job B → Registration* below for the one concrete change this imposes.

---

## Product principle

The requirement is three distinct layers. Conflating them caused the previous session to over-build. They are separate:

| Layer | What the user wants | Engineering answer |
|---|---|---|
| **Session chips** | "These are the docs we produced / things we were working on" — `report.md`, `invoice.html`, the app we built. **Not** `.ts`/`.js` churn. | Curated **output** artefacts only, linked to the sessions that touched them. |
| **Search by source file** | Search `App.jsx`, surface the sessions that edited it — even though it's never a chip. | Embed tool file paths in `session_events.text` so the existing FTS index finds them. |
| **Artefact grid** | Stays clean and meaningful. | Source files are **never** registered as artefacts. |

The guiding line: **record everything for search, present only useful outputs as artefacts.**

## Why now — the diagnostic

Measured on the two real databases (read-only extraction of the actual touch logic, 2026-05-24):

| | Main DB (power user) | Fresh `/tmp` DB |
|---|---|---|
| `session_events` rows | 1,885,834 | ~315k scanned |
| Total file touches in history | 249,231 | 70,108 |
| **Distinct OUTPUT artefacts (allow-list + deny-list)** | **374** | **346** |
| — by kind | 233 notes, 141 wireframe | 214 notes, 132 wireframe |
| **Session→output links (chips)** | **882** | **765** |
| One-pass read+parse time | 38.3 s | 9.0 s |

(A looser deny-list-only filter yielded 642/1,400 by also admitting images and stray extensions; the allow-list trims it to the cleaner figures above. In dogfooding history only `notes` and `.html` outputs actually appear — `.csv`/`.pdf`/`.pptx`/`.ipynb` are supported by the classifier but unused so far.)

Two facts drive the design:

1. **Chips are empty because registration is gated on prior registration.** The watcher only records a `session_artifacts` row when the touched file is *already* a registered artefact at tool_use time (`server/src/watchers/claude-code.ts:484`, `:835` — `if (!artifactStore.getByPath(path)) continue`). Files Claude writes are never auto-registered, so the gate is almost never satisfied.
2. **Search can't find touched files.** `renderEvent` (`claude-code.ts:1077-1090`) renders a `Write`/`Edit`/`Read` tool_use down to `[Write]` and **discards the `file_path`**. The FTS index (`session_events_fts`) indexes only the rendered `text` column, not `raw`. So searching `App.jsx` only hits sessions where the path appeared in prose — not sessions that touched it via a tool call.

The filtering collapses 249,231 touches → **374 output artefacts**. That is the clean grid, proven on the heaviest possible DB.

---

## Architecture

Registration is **reactive**: it is driven by file touches observed in session history, not by crawling the disk.

A **single pass over `session_events`** (newest-first, debounced ~5s after boot, background, non-blocking) parses each event's `raw` **once** and does two jobs:

- **Job A — Search:** re-render `text` to embed the tool's file path (`[Write]` → `[Write src/App.jsx]`). The existing FTS triggers re-index it; historical sessions become searchable by filename.
- **Job B — Chips:** if the touched path is a *useful output*, register it as an artefact (or reuse the existing one via `getByPath`) and insert a `session_artifacts` link with the real touch timestamp.

A **high-water mark** (last processed `session_events.id`) makes the historical pass one-time. After it completes, live ingestion does both jobs inline as new events arrive — near-zero marginal cost, because ingestion already parses every event.

```
Boot → watcher ingests JSONL → session_events
                                     │
        (debounced ~5s, background, recent-first, id > high_water_mark)
                                     ▼
              ┌──────── single pass: parse raw once ────────┐
              │                                             │
        Job A: re-render text                        Job B: extract touch
        with relative path                           ├ allow-list output type?
        → UPDATE session_events.text                 ├ NOT secret/noise/vendor?
        → FTS triggers re-index                      └ register output + link session
              │                                             │
        search finds App.jsx                          chips show report.md
```

### Why reactive, not a disk scanner

A disk crawl was the handover's original direction. Rejected because:

- The chip story is "what your agent did" — session history is the correct source, and the watcher already ingests it on boot. A disk crawl answers a different question ("what files exist in my folders") and adds a 15-min rescan cadence + soft-delete-on-missing machinery for no chip-story benefit.
- Reactive folds into the boot ingestion a fresh user already pays. The measured 38 s / 9 s is the cost of re-processing **already-ingested** events (existing dogfood DBs + the historical re-render). For a genuinely new user, Job A and Job B ride the ingestion pass that creates their sessions in the first place.
- It satisfies all three layers and drops three subsystems (crawler, cadence, soft-delete sweep).

The one thing reactive cannot show: an output file sitting on disk that no tracked session ever touched. For "your agent's work," that is correctly excluded.

---

## Job A — Path-indexed search

### `renderEvent` embeds relative file paths

`renderEvent` (`claude-code.ts:1041`) gains access to the session `cwd` (already known to the watcher as `meta.cwd` / `tracker.cwd`) and renders tool_use file paths into the text:

- `[Write]` → `[Write src/App.jsx]`
- Covers `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
- **Relative path** to the session project root (`cwd`) when the file is under it; otherwise `~`-collapsed absolute (e.g. `~/.claude/settings.json`). **Never** store or display a full local absolute path when avoidable.

This improves the inspector timeline too — tool turns show *what* was touched, not just `[Write]`. **User-visible → CHANGELOG entry required.**

### Historical re-index migration

Old events already have `text` without paths. A one-time, batched, background migration re-renders `text` from `raw` for touch-bearing events and `UPDATE`s the row; the existing FTS `UPDATE` triggers (`db.ts:771-779`) propagate to the index.

- Bounded to events that carry a tool_use `file_path` (~249k on the main DB) — no point rewriting prose turns.
- This is the **write-heaviest** part of the work (UPDATE + trigger per row), heavier than the 38 s read measurement. Batch it (~20k rows), run in background, share the high-water mark with Job B so both jobs advance together in one sweep.
- Events with `raw IS NULL` keep their existing text (can't be re-rendered) — acceptable.

---

## Job B — Output registration + linking

### What counts as a "useful output": allow-list, then deny-list

**Step 1 — allow-list by extension → artefact kind.** Register only known output types:

| Kind | Extensions / names |
|---|---|
| `notes` | `.md`, `.markdown`, `.txt`, `.rst`, `.rtf`, `.docx`, `.doc`, `.pages`, `.odt` |
| `table` | `.csv`, `.tsv`, `.xlsx`, `.xls`, `.ods`, `.numbers`, `.parquet` |
| `deck` | `.pdf`, `.pptx`, `.key`, `.odp` |
| `diagram` | `.mmd`, `.mermaid`, `.dot`, `.drawio`, `.excalidraw` |
| `wireframe` | `.html`, `.htm` |
| `notebook` | `.ipynb` |
| `app` | directory with `package.json` + a `dev`/`start` script (reuse `artifact-detector.ts`) |

Anything not on the allow-list (source code, config, unknown extensions) is **not registered** — but remains **searchable** via Job A. Images (`.png/.jpg/.svg/...`) are **deferred to v2** — too many icons/logos/screenshots/assets to keep v1 clean.

**Step 2 — hard secret/noise deny-list (applied on top, defense-in-depth).** Even an allowed extension is **skipped** if the path/name matches. Allowed types like `.txt`/`.md`/`.html`/`.ipynb` can still hold sensitive or junk content, so the deny-list wins:

- **Secret:** `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_dsa`, `*.p12`, `*.pfx`, `*.keystore`, `credentials*`, `.npmrc`, `.netrc`, anything under `.ssh/` or `.aws/`, path segment `secrets`
- **Dependency / vendor:** `node_modules/`, `vendor/`, `bower_components/`, `.pnpm-store/`, `.venv/`, `venv/`
- **Cache:** `.cache/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`
- **Build:** `dist/`, `build/`, `target/`, `.next/`, `.nuxt/`, `out/`, `coverage/`
- **Temp / VCS / hidden:** `/tmp/`, `*.tmp`, `*.temp`, `*~`, `*.swp`, `.DS_Store`, `.git/`, and any path with a directory segment beginning `.`

The rule, stated once: **register only known useful output types, unless the path/name matches a secret, dependency, cache, build, temp, or vendor pattern.**

### Registration is idempotent via `getByPath`

For each qualifying touch: `getByPath(absPath)` — reuse the existing artefact if present (including the legacy `'discovered'` ones still on disk), else `insert` a new one with:

- **`project_id`: the touching session's `project_id`** — the post-v0.10.0 model. The output was produced in that session's project, so that is its home; its **space derives** from the project (`artifact → project → space`). There is **no `space_id` to set** — `registerArtifact` no longer accepts one (it takes `project_id`, resolving from the file path via `lookupProject` when not supplied). If the session has no project, the artefact is parented to none and shows *unsorted* until that project is organised into a space — consistent with how the model fix already treats space-less projects. (This bullet is the single change v0.10.0 imposes on the original design.)
- `source_origin: 'discovered'` (reuse existing enum value; no migration. A semantically-purer `'session'` value is deferred unless the UI needs to distinguish them.)
- `label`: filename stem (the inferred default; a richer label is a later UX concern, out of scope).
- `artifact_kind`: from the allow-list table.
- `storage_kind: 'filesystem'`, `runtime_kind: 'static_file'`.

### Linking — and killing the dup bug (prerequisite migration)

`session_artifacts` currently has **no UNIQUE constraint** (`db.ts:307-318`), so the watcher and backfill can each insert a row for the same touch. Under reactive registration this becomes systematic duplication. **In scope, prerequisite:**

- Migration: `UNIQUE(session_id, artifact_id, role)` on `session_artifacts`. Inserts become `INSERT OR IGNORE`.
- The link's `when_at` is set from the **event timestamp**, not boot-time `now()` (the current backfill omits `when_at`, defaulting to `now()` — wrong for sorting). With recent-first processing, the latest touch is processed first and wins the `OR IGNORE`, so the row carries the most recent touch time. Chips sort correctly by `whenAt DESC`.
- Backfill existing duplicate rows as part of the migration (de-dup, keep newest `when_at`).

This replaces the per-artefact `backfillTouchesForNewArtefact` scan (`artifact-service.ts:407`), whose `O(N artefacts × M events)` non-sargable `instr()` design would be a boot cliff if called in a registration loop. The single-pass sweep does the linking in `O(M events)` once.

---

## Data model changes

1. `session_artifacts`: add `UNIQUE(session_id, artifact_id, role)`; switch inserts to `INSERT OR IGNORE`; set `when_at` from event timestamp. One-time de-dup of existing rows.
2. High-water mark storage: a single scalar (e.g. a `meta`/`kv` row, or reuse an existing settings table) holding the last processed `session_events.id`. Read on boot; advanced as the sweep progresses; persisted so the sweep is resumable and one-time.
3. No new tables. **No `session_file_touches`** — FTS is sufficient for "find sessions touching App.jsx." A structured per-touch table is deferred unless exact structured queries ("every session that edited this precise path, with timestamps and role") become a real product requirement.

---

## Error handling & edge cases

- **Parse failures:** `JSON.parse(raw)` failures are skipped (measured: 0 parse errors across 1.4M events, but guard anyway).
- **Path outside cwd:** `~`-collapsed absolute; if not under `~` either, store the absolute path (rare; e.g. system files).
- **Deleted sessions:** `INSERT OR IGNORE` + FK to `sessions` — a link to a vanished session fails silently (existing behaviour at `artifact-service.ts:445`).
- **Missing files on disk:** a registered output whose file was later deleted is handled gracefully at open-time (existing artefact-open error path). **No active soft-delete sweep** in this spec.
- **Sweep interruption:** high-water mark is advanced only after a batch commits, so a crash mid-sweep resumes from the last committed batch.

---

## Testing

Per project preference (prove before/after with **parity tests, not timing assertions**):

- **Unit — classification:** allow-list × deny-list matrix. `report.md` → registered `notes`; `src/App.tsx` → not registered; `.env` → not registered even though… (no allowed ext, but assert a `.env.md`-style trap is denied); `node_modules/foo/readme.md` → denied (vendor); `~/.ssh/config` → denied.
- **Unit — `renderEvent`:** `Write src/App.jsx` under cwd → `[Write src/App.jsx]`; file outside cwd → `[Write ~/.claude/x]`; `MultiEdit`/`NotebookEdit` covered.
- **Unit — relative path:** under cwd → relative; under `~` → `~`-collapsed; else absolute.
- **Integration — single pass on a fixture DB:** seed `session_events` with known touches; run the sweep; assert (a) the right N output artefacts registered, (b) the right session_artifacts links with correct `when_at`, (c) no duplicate links, (d) FTS `MATCH` finds a touched source file by name.
- **Integration — idempotency:** run the sweep twice; assert no new rows the second time (high-water mark + `INSERT OR IGNORE`).
- **Parity — counts:** against a copy of the real main DB, assert registered-output count and link count match the measured extraction (~374 artefacts / ~882 links) within tolerance, so refactors don't silently change behaviour.

---

## Non-goals (explicit scope fence)

- **No disk crawl.** Registration is session-history-driven only.
- **No rescan loop / cadence.** One historical pass + incremental live ingestion.
- **No soft-delete sweep.** Missing files handled at open-time.
- **No source files as artefacts.** Ever.
- **No `session_file_touches` table.** FTS is enough for v1.
- **No grid presentation / filtering work.** How discovered outputs appear/filter in the grid is a separable follow-up. This spec is registration, linking, and search-indexing only.
- **No images** (v2).
- **No richer labels** than filename stem (later UX).

## Follow-ups (noted, not in scope)

- Legacy 506 `'discovered'` artefacts on the main DB (from the dead old scanner): reconcile/clean up stale ones whose files are gone.
- Grid presentation of discovered outputs (default view, origin filter).
- A `'session'` `source_origin` value if the UI needs to distinguish reactive-registered from legacy discovered.
- `session_file_touches` if structured per-touch history becomes a product need.

## Key files

> Line numbers below predate **v0.10.0** (which reworked `artifact-store`/`artifact-service`/`db.ts`); re-confirm them when writing the implementation plan. `claude-code.ts` was not touched by v0.10.0, so its references should still hold.

- `server/src/watchers/claude-code.ts` — `renderEvent` (`~:1041`), `artifactTouchFromToolUse` (`~:1106`), ingestion loops (`backfillRange`, `consumeOnce`). Job A + Job B hook here.
- `server/src/artifact-service.ts` — `registerArtifact` **now takes `project_id` (not `space_id`)** and resolves it via `lookupProject(dirname(path))` when absent (v0.10.0); reactive registration passes the **session's** `project_id`. Retire/replace `backfillTouchesForNewArtefact`.
- `server/src/native-project.ts` (new in v0.10.0) — `ensureNativeProject`; relevant if a touched output lives under `~/Oyster/spaces/<id>/`.
- `server/src/db.ts` — `session_artifacts` schema + the still-needed `UNIQUE(session_id, artifact_id, role)` migration; FTS triggers; the v0.10.0 migration block is the model for where the historical sweep + high-water mark wire in.
- `server/src/session-store.ts` — `searchSessions`/`searchEvents` — no change needed; they read FTS.
- `shared/types.ts` — `Artifact.spaceId` is now **derived** (via project), not stored; `ArtifactSourceOrigin` unchanged.
- `web/src/components/Home/SessionRow.tsx` — chip rendering, already wired; no change.

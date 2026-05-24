# Sessions-first 1.0 → Artifact scanner — handover

**For:** the next session, where Matthew picks up the artifact-attribution problem that the sessions-first 1.0 shipping surfaced.

**TL;DR:** 1.0 shipped (#551). The FULL view chip line works end-to-end *as code* but renders empty for ~75% of an active user's sessions and 100% of a new user's, because artifact registration depends on a path that's now dormant. The next piece of work is to resurrect + extend the auto-discovery so artifacts populate themselves on every install.

---

## What shipped yesterday

**PR #551 — Sessions-first 1.0** (squash-merged). Net **−1,760 lines** vs main.

- **No more boot gate.** `oyster` opens straight to the surface; no provider login prompt, no "Set up Oyster" wizard. Setup affordances appear only when something is genuinely missing.
- **Home v1 redesign.**
  - Project tiles with `+ New session` CTA
  - Top-8 by relevance (live → waiting → recent → total); `Show all (N)` expands
  - Sessions section: FULL/COMPACT toggle (FULL = default). FULL view bumps title to 14.5px and reserves an optional indented chip line below the row for artifact attribution.
  - "Organise into spaces" CTA in the projects header
- **Orphan projects.** Dropped `NOT NULL` on `projects.space_id`; sessions can now live in projects with no space. `lookup-project.ts` no longer vacuums descendant cwds into a parent orphan.
- **Setup proposal.** `POST /api/setup/scan` returns AI-suggested groupings; ghost folders included with a "no folder" indicator.
- **SessionRow unify.** Collapsed FULL into the same `.home-row` grid as COMPACT — minimum-deviation. Only deviation: bigger title + optional `.sr-extra` line.
- **`recentArtifacts` spike.** `GET /api/sessions` now returns top-3 create/modify touches per local session, deduped server-side by `artifact_id` (prefer `create` over `modify`), ordered by `whenAt DESC`.

**Plus PR #571 (in flight)** — drops the dead `POST /api/projects/:id/claim` route + its test. ~−42 lines.

---

## The diagnostic that drives the next session

While dogfooding the FULL view chips on Matthew's main `~/Oyster` DB and a fresh `/tmp/oyster-fresh` userland, we found:

| | Main (552 artifacts) | Fresh (0 artifacts) |
|---|---|---|
| Sessions | 134 | 109 |
| Sessions with any attribution | **33 (25%)** | **0 (0%)** |
| Sessions with create/modify (not just read) | 22 (16%) | 0 |

**Why so sparse:**

1. The watcher's *live* touch-detection only fires when an artifact is **already registered at tool_use time**.
2. The *backfill* (in `artifact-service.ts:backfillTouchesForNewArtefact`) only runs when a new artifact is registered, and scans only the last 30 days of `session_events`.
3. Files Claude writes are **not** auto-registered as artifacts.

So FULL view chips only appear for sessions that touched manually-registered artifacts. On the user's main account, ~92% of registered artifacts (506 of 552) have `source_origin: 'discovered'` — but searching the current codebase, **no active code writes that origin**. They're remnants of a previous repo scanner that no longer runs.

That's the bottleneck. Fix that and the FULL view chips, the artifact grid, the "Oyster looks alive" UX — all of it works for new users on day one.

---

## What the scanner should do (design direction, not prescription)

This was the shape Matthew and I aligned on yesterday. Treat this as a starting point, not a spec.

**Cadence:**
- Boot scan (debounced ~5s after start so it doesn't block UI)
- Every ~15 min for changed folders
- On `attachFolder` for newly-attached folders
- Soft-delete artifacts whose `source_ref` no longer exists on disk

**File-type strategy: deny-list, not allow-list.**

Skip:
- `node_modules/`, `.git/`, `dist/`, `build/`, `target/`, `__pycache__/`, `.next/`, `.venv/`, `venv/`, `.cache/`
- Hidden folders (`.foo/`)
- Source code extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`
- Lock files (`*.lock`), logs (`*.log`)
- Files > 25 MB

Honour the repo's `.gitignore`.

**Register everything else** as an artifact, classified by extension:

| Kind | Extensions |
|---|---|
| `notes` | `.md`, `.markdown`, `.rst`, `.txt`, `.rtf`, `.docx`, `.doc`, `.pages`, `.odt`, `README*`, `CHANGELOG*` |
| `table` | `.csv`, `.tsv`, `.xlsx`, `.xls`, `.numbers`, `.ods`, `.parquet` |
| `deck` | `.pptx`, `.key`, `.odp`, `.pdf` |
| `diagram` | `.mmd`, `.mermaid`, `.dot`, `.drawio`, `.excalidraw` |
| `wireframe` | `.html`, `.htm` |
| `notebook` | `.ipynb` |
| `image` | `.png`, `.jpg`, `.svg`, `.gif`, `.webp` *(optional for v1)* |
| `app` | directories with `package.json` + `dev`/`start` script |

The classifier exists in skeleton form already at `server/src/mcp-server.ts:gatherRepoContext` (lines ~83–104). It's tuned for context-bundling, not registration, but the heuristics carry over.

---

## Open architectural question (worth re-litigating in the new session)

We almost pivoted yesterday to a separate `session_file_touches` table that tracks **every** Write/Edit/Read tool_use the watcher sees, independent of artifact registration. Matthew's call was: keep one concept (artifacts), register every touched file, filter at the UI.

Worth re-examining tomorrow because:

- **Pollution concern:** Claude touches 30+ files in a typical session. Auto-registering all of them bloats the curated artifact grid into a file-watcher log. The artifact filter UI would need significant work.
- **Vs separate table:** `session_file_touches` keeps `artifacts` curated. Costs: more schema, two query paths, two mental models.

If we go "register everything", we'll need:
- Stronger artifact-grid filtering (default hide auto-registered)
- Probably a new `source_origin` value like `'touched'` to mark them
- Confidence that artifact-publication, sharing, pinning etc. degrade gracefully on auto-registered items

Worth a 15-minute talk before we start coding.

---

## Existing data bugs surfaced (worth a follow-up PR)

1. **`session_artifacts` has no UNIQUE constraint.** Same `(session_id, artifact_id, role)` can be inserted multiple times at the exact same timestamp — confirmed in Matthew's DB. Looks like the live watcher and the on-register backfill both insert for the same tool_use event. Easy fix: add `PRIMARY KEY (session_id, artifact_id, role, when_at)` or `UNIQUE` index. Backfill the existing dupes if we care.
2. **`displayReason` empty for old dormant sessions.** Not the scanner's problem, but worth noting — sessions ingested before #548's state machine don't have `explicit_exit_seen` / `clean_process_exit` populated, so `deriveReason` returns `""`. Deferred per Matthew unless it bites in dogfooding.

---

## Pointers

**Code that already exists and works:**
- `server/src/routes/sessions.ts:254-296` — the `recentArtifacts` query block. Once `session_artifacts` populates broadly, chips appear for free.
- `web/src/components/Home/SessionRow.tsx` — chip-rendering is already wired; needs no changes when data arrives.
- `web/src/components/Home/Home.css` — `.sr-card`, `.sr-extra`, `.sr-artifact-chip` rules in place.

**Scanner-relevant files:**
- `server/src/artifact-detector.ts` — existing detector for **app bundles** (manifest.json + src/). Narrower than what we need; useful as scaffolding.
- `server/src/mcp-server.ts:gatherRepoContext` (lines ~53–110) — the type-classifier heuristics live here.
- `server/src/artifact-service.ts:backfillTouchesForNewArtefact` — the existing backfill we'd want to reuse / generalise once scanner registers things.
- `server/src/space-store.ts` — already has `scan_status`, `last_scanned_at`, `last_scan_summary` columns designed for exactly this use. Scanner can write to them.

**Spec + mockups (1.0 sessions-first, for reference):**
- `docs/superpowers/specs/2026-05-22-sessions-first-design.md`
- `docs/mockups/home-sessions-unified-v2.html` — the FULL/COMPACT mock you can `open` to remember the visual target

**Working pattern (Matthew's preference):**
- Worktree: `~/Dev/oyster.worktrees/<branch>`
- Subagent-driven implementation when the work spans multiple files; punch-list audit + targeted implementer for review-comment fixes
- Squash-merge PRs

---

## First moves when you start

1. Fresh worktree off latest `main` — e.g. `~/Dev/oyster.worktrees/artifact-scanner`.

2. **Code audit BEFORE the architecture discussion.** The previous session made architectural calls without code grounding and had to backtrack. Don't repeat that. Dispatch a code-explorer subagent (or read directly) to map the current state and bring findings back to the main thread *before* tackling the open question. The audit should answer:

   - **Watcher → `session_artifacts` write path.** In `server/src/watchers/claude-code.ts`, trace every place `insertArtifactTouch` (or the underlying SQL) is called. What's the exact event flow? Where would a *new* "every-touch" path hook in?
   - **Backfill path.** `server/src/artifact-service.ts:backfillTouchesForNewArtefact` — what does it scan, what bounds it (30 days?), what's its idempotency story?
   - **`Artifact` registry shape.** `shared/types.ts:20` — what does the curated `Artifact` interface promise that an auto-registered file might violate (publication state, sharing, pinning, manual labels)? Worth mapping before deciding whether to overload or split.
   - **The dormant scanner.** Search the repo + git history for the code that *used* to write `source_origin: 'discovered'` (the 506 artifacts on Matthew's DB). It's gone from the current tree but the migration trail might tell us why it was removed. Useful prior art either way.
   - **Existing scan scaffolding.** `space-store.ts` already has `scan_status`, `last_scanned_at`, `last_scan_summary` columns. Are there any partial scanner remnants (functions, MCP handlers, UI hooks) that point at those columns? Reuse > rebuild.
   - **The dedup/UNIQUE problem** in `session_artifacts`. Confirm the bug from this handover by checking the schema (`server/src/db.ts:307+`) and the live insert paths. The fix is a schema migration; in scope or not depends on the chosen path.

   **Cap the audit at ~600 words back to the main thread.** Findings should be specific (file:line, current behaviour, what's missing) — not vibes.

3. **Then settle the open question** with code in hand. Are we registering everything as an artifact (filter at UI), or splitting into `session_file_touches`? Don't write code until that's settled.

4. **Then brainstorm the spec** — there's enough in this handover to start, but the audit + the answered question shape it into a real plan.

5. **Verify on `/tmp/oyster-fresh` first.** That's the canary. If a fresh user gets meaningful chips on their first session, the work is done.

Sleep well. This will feel obvious in the morning.

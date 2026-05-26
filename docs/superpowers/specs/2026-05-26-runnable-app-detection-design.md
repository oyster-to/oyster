# Design — Project-derived runnable-app detection (v1)

Date: 2026-05-26
Branch: `runnable-app-detection`
Supersedes the framing in `~/Dev/project-notes/oyster/handover-2026-05-26-app-chips.md`
(see "Relationship to the handover" below).

## Goal (one line)

Detect the **runnable web app** inside a project — automatically, from `package.json` —
and surface it in two places: as an **app artefact** on the desktop (with the existing
launch + preview) and as a **chip on the project tile** that opens it.

## What "runnable app" means in v1

A project whose `package.json` `dev` script is a **recognized single launcher**:

- **Vite** — the `dev` script's leading command is `vite`.
- **Next.js** — the `dev` script's leading command is `next dev` (any trailing flags,
  e.g. `--turbopack`).

Detection is **conservative**: match the leading executable + subcommand, not a substring.
`vite build`, `next build`, and `concurrently … vite …` do **not** match. False positives
(claiming something is a launchable app when it isn't) are worse than false negatives.

Everything else — `concurrently`/`npm-run-all` orchestrators, custom scripts, no `dev`
script — is **not** surfaced as a launchable app in v1. See "Explicitly deferred".

## Decisions (locked in brainstorm)

1. **Eventual goal is launch + preview**; the launch/preview machinery already exists
   (`local_process` runtime kind + `/api/apps/:id/start|stop` + popup preview). This work
   is the **detection + registration** that feeds it.
2. **Derived, in-memory — no DB row, no on-disk marker.** A detected app is a pure function
   of what's on disk, exactly like `isGitRepo`/`hasLivePath` in `detectPathState`. It is
   registered through the in-memory generated-artefact path, never persisted. (Persistence
   would only be earned by *user-authored state* — a custom command/port, a pin — which is
   out of v1 scope.)
3. **Vite + Next only** for v1. Audited fleet: 4 plain-Vite, 2 Next, 2 `concurrently`
   monorepo roots. Vite + Next covers all 6 single-app projects; both inject a port flag,
   so no env-var / port-discovery machinery is needed.
4. **Surfaces: artefact card + tile chip** — one derived thing, two entry points.

## Architecture

### Single resolver (the spine)

One function is the **sole** source of a detected app's identity and launch config. The
tile chip, the artefact card, and the start/stop routes all consume it — nothing invents
its own id/label/config independently.

```
resolveRunnableApp(project): RunnableApp | null

RunnableApp = {
  id:        `app:${project.id}`,   // stable, unique, rename-proof (UUID-based)
  label:     string,                // project name (e.g. "tokinvest-website")
  cwd:       string,                // project.recentPath
  framework: "vite" | "next",
  argv:      string[],              // how to launch, with a {PORT} placeholder slot
}
```

- **`id` = `app:<projectId>`.** Not `app:<name>` — package/folder names collide across
  projects; the project UUID does not and survives renames.
- Reads `package.json` at `project.recentPath`, parses the `dev` script's leading command
  conservatively, returns `null` if not a recognized launcher.
- `argv` is the launch command (see "Launch lifecycle"); the concrete port is filled in at
  **start time**, not here.

### Surface 1 — tile chip

- `project-service` calls `resolveRunnableApp` inside the existing per-project derivation
  pass (alongside `detectPathState`) and adds a derived field to `Project`:
  ```
  app?: { id: string; label: string }   // absent when not runnable
  ```
  Read-time, never stored — same grain as `isGitRepo`.
- `web/src/data/projects-api.ts` mirrors the `app?` field on the client `Project` type.
- `ProjectTile.tsx` renders a small chip (next to the `<GitBranch>` signal) when
  `project.app` is present. **The chip is narrow:** clicking it opens/focuses the artefact
  card via the same handler the card uses — it does **not** own a second launch path.

### Surface 2 — artefact card + preview

- `getAllArtifacts` (`artifact-service.ts:115`) already appends derived entries (it does
  this for cloud publications). Add a step that walks projects, calls `resolveRunnableApp`,
  and for each runnable project appends an in-memory `local_process` `app` artefact shaped
  exactly like `rowToArtifact`'s `local_process` branch (`artifact-service.ts:712`):
  - `id: app:<projectId>`, `artifactKind: "app"`, `runtimeKind: "local_process"`
  - `sourceOrigin: "discovered"`, `projectId` set, `spaceId` = project's space
  - `status` + `url` derived from **process-manager runtime state** (see below)
- **No `filePath`** on these entries → the boot reconcile
  (`index.ts:704`, condition `entry.filePath && status === "ready"`) never writes them to
  the DB. They stay in-memory by construction. This is the mechanism that enforces
  "no DB row" — not a convention we have to remember.
- **Dedupe by `id`** before returning, guarding against collision with existing
  generated/DB artefacts.

### Launch lifecycle (process-manager owns runtime state)

The current `startApp` (`process-manager.ts:110`) hardcodes Vite's `--port N --strictPort`
and string-splits the command. Two changes:

1. **`startApp` takes explicit argv** instead of a command string + hardcoded flags. The
   resolver supplies the exact invocation, so npm passthrough is correct:
   - Vite: `npm run dev -- --port <PORT> --strictPort`
   - Next: `npm run dev -- -p <PORT>`
   The `--` separator is required for npm to pass flags through to the underlying tool.
   **Assumption: npm.** The audited fleet and oyster itself use npm. pnpm/yarn passthrough
   differs; out of scope for v1 (record as assumption, revisit if needed).

2. **Process-manager owns `{ appId → { port, pid, child } }`.** Today it owns `procs`
   (`Map<name, ChildProcess>`); extend it to track the allocated port too.
   - **No port until start.** A GET (listing) never reserves a port or mutates runtime
     state. `start` allocates a free port (scan upward from a base, skipping Oyster's own
     3333/4444), records `{ appId, port, pid }`, spawns, `waitForReady(port)`.
   - **Status from process state, not blind port probe.** `isPortOpen(port)` alone can lie
     (an unrelated process may later bind the port). Derived-app status is computed from
     whether *our* child for `appId` is alive (port probe is a fallback only):
     - child alive + port open → `online` (url `http://localhost:<port>`)
     - starting → `starting`
     - otherwise → `offline` (no url yet)
   - The existing **DB** `local_process` path keeps using `isPortOpen` (its current
     behaviour); we do not refactor it. Scope stays surgical.

### Routes (start/stop symmetry)

- `getAppConfig` (`artifact-service.ts:277`) currently reads the DB store only. Extend the
  **start route** to resolve a derived app's launch config via `resolveRunnableApp` +
  process-manager (keyed by `appId`) when the id isn't a DB row.
- **`stop` must follow the same resolution path** — otherwise an app can be started but not
  reliably stopped. Both routes resolve `appId` → config/runtime through one path.

### Intent / safety

- Detection and listing are **side-effect-free** — they never spawn a process. Verified:
  only an explicit click → `startAppApi` spawns (`App.tsx:441`). So there is no silent
  auto-run on surface render.
- Because starting executes the project's own `dev` script (running project code), the
  card's affordance is labelled **"Start app"** to make the action explicit.

## Relationship to the handover

The handover framed this as a "project-derived **chip**, no artefact row." The chip remains
(Surface 1), and "no row" is **strengthened** (the no-`filePath` mechanism guarantees it).
What changed: the eventual goal is launch + preview, which reuses the existing
`local_process` pipeline — so the detected app *also* appears as an artefact (Surface 2),
which the handover hadn't anticipated. The "no on-disk marker" constraint is fully intact.

## Testing

Parity / behaviour tests (no timing assertions):

- `resolveRunnableApp`:
  - Vite `dev: "vite"` → runnable, framework vite, argv with `--port`/`--strictPort` slot.
  - Next `dev: "next dev --turbopack"` → runnable, framework next, argv with `-p` slot.
  - `concurrently …` → `null`.
  - `vite build` / `next build` → `null` (conservative leading-command match).
  - no `dev` script / missing `package.json` → `null`.
  - id is `app:<projectId>` and identical across the chip and card derivations.
- `getAllArtifacts` dedupes derived app ids; derived app has no `filePath` (so reconcile
  skips it — assert it is absent from the DB after a list).
- Start route resolves a derived app's config (not a DB row) and stop resolves the same id.
- Status reflects process-manager state: offline when no child, online after start records
  a live child + open port.

## CHANGELOG

One user-facing entry under **Added** (consumer-facing core UI — gets an entry, unlike
arcade/website work). Outcome phrasing, e.g.:

> **Runnable apps, detected automatically.** Projects that run a Vite or Next dev server are
> recognised on sight — launch and preview them straight from the surface, and jump to them
> from the project tile.

## Explicitly deferred (recorded so they aren't reported as bugs)

- **Orchestrator launch (concurrently / npm-run-all).** v1 detects these as *not*
  launchable; no chip/card. The future mechanism is the runtime port-probe (run verbatim,
  diff opened listeners against our process group, preview the port serving HTML) — a
  separate subsystem, not a small increment, so deferred. **oyster-os and blunderfixer
  roots will not show an app card; this is intended.**
- **Agent-inferred launch config** for the orchestrator/ambiguous tail.
- **Persisted user override** (custom command / preview port / pin) — the first thing that
  would earn a DB row.
- **Non-npm package managers** (pnpm/yarn) — argv passthrough differs.

## Known limitations

- **Monorepo / root-only scan.** Resolution reads `project.recentPath`. A runnable sub-app
  surfaces only if that subfolder is the project's recent path or is itself an attached
  project (e.g. `blunderfixer/apps/web` is attached, so it surfaces; the `blunderfixer`
  root, a `concurrently` orchestrator, does not). We do not walk into repos.
- **npm assumed** (see Launch lifecycle).

## Files touched

- `server/src/project-service.ts` — call `resolveRunnableApp` in the derivation pass; add
  `app?` to `Project`. (Resolver itself may live here or in a small dedicated module.)
- `server/src/artifact-service.ts` — `getAllArtifacts` appends derived app artefacts
  (dedup); start/stop config resolution via the resolver + process-manager.
- `server/src/process-manager.ts` — `startApp` takes explicit argv; own `{ appId → port,
  pid, child }`; free-port helper; status helper.
- `server/src/routes/static.ts` — start/stop routes resolve derived apps.
- `web/src/data/projects-api.ts` — `Project.app?` type.
- `web/src/components/Home/ProjectTile.tsx` — render the chip (opens the card).
- Tests + `CHANGELOG.md`.
</content>
</invoke>

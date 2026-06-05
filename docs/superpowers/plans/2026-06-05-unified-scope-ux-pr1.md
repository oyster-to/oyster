# Unified Scope UX — PR 1 (Structural Unification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page shape with scope: the Sessions/Artefacts/Memories sections become tabs scoped by space pill + project card selection; the sessions table names the repo (never the space); Vault and orphan folders join the Home project grid; the Unassigned pill and Elsewhere view retire; project scope becomes URL-addressable.

**Architecture:** All UI work. `Home/index.tsx` is the single always-mounted surface (Desktop already renders *inside* its Artefacts section — there is no separate Desktop route to retire). We restructure Home's three stacked sections into a tab panel, fix the session project label, widen the Home grid to all projects + Vault + orphan-cwd tiles, delete the Elsewhere/Unassigned code paths, and lift `selectedProjectId` to App for `/s/<space>/p/<project>` routing. No server or schema changes. ChatBar untouched.

**Tech Stack:** React 18 + TypeScript (web/), Vite. **No web test runner exists** (server has vitest; web has only `tsc -b` + `eslint`). Per codebase convention, verification is: typecheck + lint + build + explicit manual browser checks listed in each task. Do not introduce a test framework in this PR.

**Spec:** `docs/superpowers/specs/2026-06-05-unified-scope-ux-design.md`

**Branch / worktree:** Branch `unified-scope-ux` exists (holds the spec). Per user preference, execute in a worktree: `git worktree add ~/Dev/oyster.worktrees/unified-scope-ux unified-scope-ux`, copy `.env` into it, run `npm install` in `web/` and `server/` (or symlink node_modules — Vite may glitch on first load with symlinks). Dev/installed servers share `~/Oyster` — if the dev server won't start, check for a stale `~/Oyster/.oyster.lock`.

**Manual-check harness:** `npm run dev` at the repo root → web at `http://localhost:7337`, server at 3333. All manual steps below assume this is running.

---

### Task 1: Session rows name the repo, never the space

The PROJECT column currently shows the *space* displayName whenever `session.spaceId` is set (`spaceLabel ?? cwdBasename`), which makes two repos in one space indistinguishable. Show the project (repo) name via the projects registry, falling back to the cwd basename. Also hide the column entirely when a project is selected (the scope already says it).

**Files:**
- Modify: `web/src/components/Home/SessionRow.tsx` (label logic ~lines 56–68, render ~line 107, props interface near top)
- Modify: `web/src/components/Home/index.tsx` (allProjects fetch ~line 195–202, new memo, SessionRow callsite ~line 1274–1288, table header ~line 1264–1273)
- Modify: `web/src/components/Home/Home.css` (no-project grid variant, after the `.home-row` block ~line 513)

- [ ] **Step 1: Always fetch allProjects**

In `web/src/components/Home/index.tsx`, the `useFetched(fetchAllProjects, …)` call is gated `enabled: isMetaScope`. Session-row labels now need the registry in every scope. Change:

```ts
    { enabled: isMetaScope, ssEvent: "session_changed" },
```

to:

```ts
    // Always fetched: feeds session-row project labels in every scope,
    // plus the Home tile strip.
    { enabled: true, ssEvent: "session_changed" },
```

Also update the comment above the hook (it says "Only fetched when on Home").

- [ ] **Step 2: Add the projectNameById memo**

In `index.tsx`, immediately after the `useFetched` block for `allProjects`:

```ts
  // Repo names for session-row labels — never the space displayName
  // (scope already says the space; two repos in one space must stay
  // distinguishable). Falls back to cwd basename inside SessionRow.
  const projectNameById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of allProjects) out[p.id] = p.name;
    return out;
  }, [allProjects]);
```

- [ ] **Step 3: Rework SessionRow's label**

In `web/src/components/Home/SessionRow.tsx`:

(a) Add to the `SessionRowProps` interface (it's the type the component destructures from — near the top of the file):

```ts
  /** Repo name from the projects registry; null/undefined = unknown. */
  projectName?: string | null;
  /** Project scope is active — the column is redundant, hide it. */
  hideProject?: boolean;
```

(b) Add `projectName` and `hideProject` to the destructured params.

(c) Replace the label block:

```ts
  // Prefer space label when the session belongs to a registered space.
  const spaceLabel = session.spaceId
    ? (spaces.find((s) => s.id === session.spaceId)?.displayName ?? null)
    : null;
  const projectLabel = (spaceLabel ?? cwdBasename) || "—";
```

with:

```ts
  // Repo name via the projects registry; cwd basename for orphans.
  // Never the space name — the scope/space pill already says that.
  const projectLabel = (projectName ?? cwdBasename) || "—";
```

(d) Make the column conditional. Replace:

```tsx
        <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
```

with:

```tsx
        {!hideProject && (
          <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
        )}
```

(e) The `spaces` prop may now be unused in SessionRow — check with eslint (Step 6). If unused, remove it from `SessionRowProps`, the destructure, and the callsite in `index.tsx`. If it's still used elsewhere in the file (e.g. chips), leave it.

- [ ] **Step 4: Thread props at the callsite + conditional header column**

In `index.tsx`, the SessionRow callsite (inside `visibleSessions.slice(0, sessionsLimit).map(…)`), add:

```tsx
                      projectName={session.projectId ? projectNameById[session.projectId] ?? null : null}
                      hideProject={selectedProjectId !== null && selectedProjectId !== VAULT}
```

(Not at VAULT scope: vault sessions are no-project orphans, so the column's cwd-basename fallback is the only signal of where each ran — keep it visible there.)

The table header row above it — make the Project columnheader conditional and add a modifier class to the table. Replace:

```tsx
              <div className="home-table-wrap">
                <div className="home-table">
                  <div className="home-row home-row--header" role="row">
                    <span aria-hidden="true" />
                    <span role="columnheader">Project</span>
```

with:

```tsx
              <div className="home-table-wrap">
                <div className={`home-table${selectedProjectId !== null && selectedProjectId !== VAULT ? " home-table--no-project" : ""}`}>
                  <div className="home-row home-row--header" role="row">
                    <span aria-hidden="true" />
                    {(selectedProjectId === null || selectedProjectId === VAULT) && <span role="columnheader">Project</span>}
```

- [ ] **Step 5: Grid variant in Home.css**

After the `.home-row { … }` block (~line 513, template `18px 130px 1fr 130px 150px 130px`):

```css
/* Project scope active — the project column is hidden (the scope crumb
   names it), so the title takes its track. */
.home-table--no-project .home-row {
  grid-template-columns: 18px 1fr 130px 150px 130px;
}
```

- [ ] **Step 6: Typecheck + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: both clean. If eslint flags `spaces` unused in SessionRow.tsx, remove it per Step 3(e) and re-run.

- [ ] **Step 7: Manual check**

With dev running, on `http://localhost:7337/s/home`: every sessions-table row shows a *repo* name (e.g. `oyster-dev`), not a space name, even for sessions in spaces. Click a project tile: the Project column (and header) disappears and the table re-flows; deselect: it returns.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/Home/SessionRow.tsx web/src/components/Home/index.tsx web/src/components/Home/Home.css
git commit -m "home: session rows name the repo, hide column at project scope"
```

---

### Task 2: Tab strip — Sessions | Artefacts | Memories + scope crumb

The three stacked `<section>`s become one tab panel. Filters/toggles stay inside their tab. A scope crumb on the right of the strip names the active scope and clears project selection.

**Files:**
- Modify: `web/src/components/Home/index.tsx` (new state + memos near the other view state ~line 208; markup around the three sections ~lines 1212–1587)
- Modify: `web/src/components/Home/Home.css` (tab styles)

- [ ] **Step 1: Tab state + counts + crumb**

In `index.tsx`, next to the `sessionsView` sticky state (~line 208), add:

```ts
  const [activeTab, setActiveTab] = useStickyView("oyster.home.activeTab", "sessions", ["sessions", "artefacts", "memories"] as const);
```

After the `projectArtefactCounts` memo (~line 664), add:

```ts
  // Scope-only artefact total for the tab count (source/kind filters are
  // tab-internal and shouldn't change the tab's headline number).
  const scopedArtefactsTotal = useMemo(() => {
    const list = effectiveDesktopProps.artifacts;
    if (selectedProjectId === VAULT) return list.filter((a) => !a.projectId).length;
    if (selectedProjectId) return list.filter((a) => a.projectId === selectedProjectId).length;
    return list.length;
  }, [effectiveDesktopProps.artifacts, selectedProjectId]);
```

(Note: Task 3 renames `effectiveDesktopProps` → `desktopProps`; the replace_all there will update this too.)

After the `activeSpaceRow` / `eyebrow` lines (~line 817), add:

```ts
  const selectedProject = selectedProjectId && selectedProjectId !== VAULT
    ? allProjects.find((p) => p.id === selectedProjectId) ?? null
    : null;
  const scopeCrumb = selectedProjectId === VAULT
    ? "vault"
    : selectedProject
      ? `${selectedProject.spaceId ? (spaces.find((s) => s.id === selectedProject.spaceId)?.displayName ?? selectedProject.spaceId) + " › " : ""}${selectedProject.name}`
      : isArchivedView
        ? "archived"
      : isAllView
        ? "all"
      : scopedSpace
        ? (activeSpaceRow?.displayName ?? scopedSpace)
        : "everything";
```

(Meta views aren't a wider "everything" — Archived in particular is a different dataset; the crumb must say so.)

- [ ] **Step 2: Insert the strip, wrap the sections**

Directly above the Sessions `<section className="home-section">` (~line 1212), insert:

```tsx
        <div className="home-tabs" role="tablist" aria-label="Scoped content">
          {(["sessions", "artefacts", "memories"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={activeTab === t}
              className={`home-tab${activeTab === t ? " active" : ""}`}
              onClick={() => setActiveTab(t)}
            >
              {t === "sessions" ? "Sessions" : t === "artefacts" ? "Artefacts" : "Memories"}
              <span className="home-tab-count">
                {t === "sessions" ? stateCounts.all : t === "artefacts" ? scopedArtefactsTotal : scopedMemories.length}
              </span>
            </button>
          ))}
          <span className="home-tab-scope">
            scope: {scopeCrumb}
            {selectedProjectId !== null && (
              <button
                type="button"
                className="home-tab-scope-clear"
                onClick={() => setSelectedProjectId(null)}
                aria-label="Clear project scope"
              >
                ✕
              </button>
            )}
          </span>
        </div>
```

Then wrap each of the three sections in its tab conditional:
- Sessions section (~1212–1309): `{activeTab === "sessions" && ( <section …> … </section> )}`
- Artefacts section (~1311–1501): `{activeTab === "artefacts" && ( … )}`
- Memories section (~1503–1587): `{activeTab === "memories" && ( … )}`

- [ ] **Step 3: De-duplicate section labels**

The tab is now the label. Inside each wrapped section's `home-section-head`:
- Sessions: delete `<span className="home-section-label">Sessions</span>`
- Artefacts: delete `<span className="home-section-label">Artefacts</span>`
- Memories: delete `<span className="home-section-label">Memories</span>` **and** `<span className="home-artefacts-count">{scopedMemories.length}</span>` (count lives in the tab now)

- [ ] **Step 4: Tab CSS**

In `Home.css`, after the `.home-section-head` block (~line 143):

```css
/* Scoped-content tab strip (Sessions | Artefacts | Memories). */
.home-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 36px;
  border-bottom: 1px solid var(--home-border);
}
.home-tab {
  background: none;
  border: none;
  cursor: pointer;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--text-dim);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.home-tab:hover { color: var(--text); }
.home-tab.active { color: var(--text); border-bottom-color: #7c6bff; font-weight: 600; }
.home-tab-count {
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-dim);
}
.home-tab-scope {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  padding-right: 4px;
}
.home-tab-scope-clear {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 2px;
}
.home-tab-scope-clear:hover { color: var(--text); }
```

(`#7c6bff` is the accent already used by `.home-row:hover`'s rgba(124, 107, 255, …) and App's bolt gradient. If Home.css defines an accent custom property, prefer it.)

- [ ] **Step 5: Typecheck + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: clean. Likely tripwires: `scopedMemories` is declared ~line 500, *before* the crumb memos — the tab strip JSX uses both, which is fine, but `selectedProject` (Step 1) must be declared **after** `allProjects` and **before** the JSX. If tsc complains about use-before-declaration, move the Step 1 blocks below all data memos.

- [ ] **Step 6: Manual check**

On `/s/home`: one tab strip with three tabs + counts; clicking tabs swaps content; filters (live/waiting/done, FULL/COMPACT, source/kind, icon/table) all still work inside their tabs; crumb reads `scope: everything`. Click the `oyster` space pill → crumb shows the space name; select a project tile → crumb shows `space › project` with ✕; ✕ clears. Reload → active tab persists. Click the shield pill → VaultInfo page still renders without the strip.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Home/index.tsx web/src/components/Home/Home.css
git commit -m "home: sessions/artefacts/memories become scoped tabs with scope crumb"
```

---

### Task 3: Home grid = all projects + Vault card + orphan folders; retire Unassigned/Elsewhere

Unassigned projects join the main Home grid (no more negative-space pill); the Vault tile (today space-view-only, in ProjectTileGrid) gets a Home twin; orphan-cwd tiles move from Elsewhere onto Home; the `showElsewhere` state and every branch of it is deleted.

**Files:**
- Modify: `web/src/components/Home/index.tsx` (grid sections ~lines 1002–1143, pill block ~lines 940–967, state + memos throughout)

- [ ] **Step 1: All projects in the Home sort**

In the `sortedProjects` memo (~line 644), replace:

```ts
    // Filed projects only — those detached from every space (space_id null)
    // live under the Unassigned pill, mirroring how orphan sessions are
    // segregated out of the Home view.
    return allProjects.filter((p) => p.spaceId != null).sort((a, b) => {
```

with:

```ts
    // Every project — assigned or not. Unassigned projects are ordinary
    // cards on Home now; the Unassigned pill is retired.
    return [...allProjects].sort((a, b) => {
```

- [ ] **Step 2: Orphan-cwd tiles compute on Home unconditionally**

In the `orphanCwdGroups` memo (~line 432), replace `if (!showElsewhere || !isHomeView) return [];` with `if (!isHomeView) return [];` and remove `showElsewhere` from its dep array.

Also fix a duplicate-tile bug this surfaces: a session in an *unassigned project* has `spaceId === null` but a real `projectId` — its project renders as a normal card now, so it must not also spawn an orphan-folder tile for the same directory. In the same memo, replace the skip condition:

```ts
      if (s.spaceId !== null || !s.cwd) continue;
```

with:

```ts
      // Project-bound sessions render via their project card — only truly
      // unclaimed folders (no project, no space) get an orphan tile.
      if (s.projectId || s.spaceId !== null || !s.cwd) continue;
```

- [ ] **Step 3: Vault tile + orphan tiles inside the Home projects grid**

In the Home projects section (~line 1002), the gate and grid become:

```tsx
        {isHomeView && (sortedProjects.length > 0 || orphanCwdGroups.length > 0 || (projectArtefactCounts[VAULT] ?? 0) > 0) && (
```

Inside `<div className="home-projects-grid" ref={projectsGridRef}>`, **before** `{visibleProjects.map(…)}`, add the Vault card (Shield is already imported):

```tsx
              {(projectArtefactCounts[VAULT] ?? 0) > 0 && (
                <div className={`home-projects-strip-tile home-project-tile--vault${selectedProjectId === VAULT ? " selected" : ""}`}>
                  <button
                    type="button"
                    className="home-projects-strip-tile-body"
                    onClick={() => setSelectedProjectId(selectedProjectId === VAULT ? null : VAULT)}
                    title="Artefacts created in Oyster itself — not tied to a repo"
                  >
                    <div className="home-projects-strip-name">
                      <Shield size={14} strokeWidth={1.75} aria-hidden="true" />
                      <span>Vault</span>
                    </div>
                    <div className="home-projects-strip-counts">
                      <span className="signal"><span className="pip pip-dim" />{projectArtefactCounts[VAULT]} {(projectArtefactCounts[VAULT] ?? 0) === 1 ? "artefact" : "artefacts"}</span>
                    </div>
                  </button>
                </div>
              )}
```

Then move the orphan-cwd tiles: take the entire `{orphanCwdGroups.map((p) => { … })}` block out of the `isHomeView && showElsewhere && orphanCwdGroups.length > 0` section (~lines 1086–1143) and paste it **after** `{visibleProjects.map(…)}` inside the main grid. Delete the now-empty Elsewhere orphan section wrapper.

- [ ] **Step 4: Delete the Elsewhere/Unassigned code paths**

In `index.tsx`, remove in this order (each removal unblocks the next lint pass):

1. The Unassigned breadcrumb pill block (`{(orphanCounts.total > 0 || unassignedProjects.length > 0) && realSpaces.length > 0 && ( <button … Unassigned … /> )}`, ~lines 940–967).
2. The `isHomeView && showElsewhere && unassignedProjects.length > 0` projects section (~lines 1062–1084) — those projects render in the main grid now.
3. The `unassignedProjects` memo (~line 523).
4. The `showElsewhere` state (~line 217) and every remaining read/write:
   - the reset effect (~line 286–291) keeps only `setShowVault(false)`,
   - `scopedSessions` (~line 328) becomes `return scopedSpace ? sessions.filter((s) => s.spaceId === scopedSpace) : sessions;`,
   - `scopedMemories` (~line 500) drops its Elsewhere branch (keep the rest — Task 4 reworks it),
   - `effectiveDesktopProps` (~line 527): delete the memo entirely and replace every `effectiveDesktopProps` usage with `desktopProps` (replace-all; ~5 usages incl. Task 2's `scopedArtefactsTotal`),
   - the scope-reset effect dep array (~line 316) drops `showElsewhere`,
   - the `eyebrow` line (~818) becomes `const eyebrow = isHomeView ? "Home" : isAllView ? "All" : isArchivedView ? "Archived" : activeSpaceRow?.displayName ?? scopedSpace ?? "";`,
   - the `<h1>` (~992) becomes `{isHomeView ? "Your work." : eyebrow}` (Task 4 finishes it),
   - Home/Vault pill onClick handlers drop `setShowElsewhere(false)`,
   - the sessions empty-state conditions (~1260, ~1301) drop `&& !showElsewhere`.
5. `realSpaceIds` memo (~line 514) if now unused (it fed `effectiveDesktopProps`); eslint will confirm.
6. In the space-delete ConfirmModal copy (~lines 1680–1682), replace the two "→ Elsewhere" strings with "→ Home" (sessions/memories unbound from a deleted space surface on Home now).

- [ ] **Step 5: Typecheck + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: clean — in particular zero remaining references to `showElsewhere`, `unassignedProjects`, `effectiveDesktopProps`. `orphanCounts` is still used (Home pill tooltip totals) — leave it.

- [ ] **Step 6: Manual check**

On `/s/home`: unassigned projects (e.g. `Dev`, `sober-o-matic`) now appear as ordinary cards in the grid; a **Vault** card appears iff no-project artefacts exist — clicking it scopes all three tabs (Artefacts = native ones, Sessions = no-project ones, crumb = `vault`); orphan-folder tiles render in the same grid with working FolderPlus → attach popover; the topbar has **no Unassigned pill**; deleting a test space says "→ Home".

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Home/index.tsx
git commit -m "home: all projects + vault + orphan folders in one grid; retire Unassigned/Elsewhere"
```

---

### Task 4: Scope-aware title + memory scoping at project/Vault scope

**Files:**
- Modify: `web/src/components/Home/index.tsx` (h1 ~line 992, `scopedMemories` memo ~line 500)

- [ ] **Step 1: Title reflects project scope**

Replace the `<h1>`:

```tsx
          <h1 className="home-title">{isHomeView ? "Your work." : eyebrow}</h1>
```

with:

```tsx
          <h1 className="home-title">
            {selectedProjectId === VAULT ? "Vault."
              : selectedProject ? selectedProject.name
              : isHomeView ? "Your work."
              : eyebrow}
          </h1>
```

(`selectedProject` is the Task 2 memo. If Task 2's declaration sits below the JSX-needed point, it already had to be moved above — same constraint here.)

- [ ] **Step 2: Memories follow project/Vault scope**

Replace the `scopedMemories` memo (post-Task-3 shape) with:

```ts
  // Memories scope mirrors the server `list(space_id)` semantics: a space
  // includes both its own memories AND globals. There is no project-level
  // memory in the model (yet) — at project scope show the project's space
  // + globals; at Vault scope, globals only.
  const scopedMemories = useMemo(() => {
    if (selectedProjectId === VAULT) return memories.filter((m) => !m.space_id);
    const spaceForScope = selectedProject?.spaceId ?? scopedSpace;
    return spaceForScope
      ? memories.filter((m) => !m.space_id || m.space_id === spaceForScope)
      : memories;
  }, [memories, scopedSpace, selectedProject, selectedProjectId]);
```

Declaration-order constraint: this memo now depends on `selectedProject`, so `selectedProject` (and therefore the `allProjects` fetch) must be declared above it. Move the `selectedProject`/`scopeCrumb` block up next to the other scope derivations if tsc complains.

- [ ] **Step 3: Typecheck + lint + manual check**

Run: `cd web && npx tsc -b && npm run lint` → clean.
Manual: select a project in a space that has space-scoped memories → Memories tab shows that space's + globals, title is the project name; select Vault → globals only, title "Vault."; deselect on Home → all memories, "Your work.".

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Home/index.tsx
git commit -m "home: project-scoped title and memories"
```

---

### Task 5: Project scope in the URL — `/s/<space>/p/<project>`

Lift `selectedProjectId` from Home to App so selection is URL-addressable and survives back/forward.

**Files:**
- Modify: `web/src/App.tsx` (getUrlState ~lines 52–63, state ~line 65, popstate ~lines 247–267, handleSpaceChange ~line 270, reveal/SSE handlers ~lines 183, 201–210, Home props ~line 609)
- Modify: `web/src/components/Home/index.tsx` (Props interface, remove local state, rewire setters)

- [ ] **Step 1: Parse the project URL in App**

In `getUrlState`, add a `projectId` field. Insert the project match **before** the bare-space match and add `projectId: null` to the other returns:

```ts
  const getUrlState = useCallback((): { space: string; artifactId: string | null; groupName: string | null; hash: string; projectId: string | null } => {
    const artifactMatch = window.location.pathname.match(/^\/s\/([^/]+)\/a\/([^/]+)$/);
    if (artifactMatch) {
      return { space: artifactMatch[1], artifactId: artifactMatch[2], groupName: null, hash: window.location.hash || "", projectId: null };
    }
    const groupMatch = window.location.pathname.match(/^\/s\/([^/]+)\/g\/([^/]+)$/);
    if (groupMatch) {
      return { space: groupMatch[1], artifactId: null, groupName: decodeURIComponent(groupMatch[2]), hash: "", projectId: null };
    }
    const projectMatch = window.location.pathname.match(/^\/s\/([^/]+)\/p\/([^/]+)$/);
    if (projectMatch) {
      return { space: projectMatch[1], artifactId: null, groupName: null, hash: "", projectId: decodeURIComponent(projectMatch[2]) };
    }
    const spaceMatch = window.location.pathname.match(/^\/s\/([^/]+?)\/?$/);
    return { space: spaceMatch ? spaceMatch[1] : "home", artifactId: null, groupName: null, hash: "", projectId: null };
  }, []);
```

- [ ] **Step 2: App-level scope state + handler**

After the `activeSpace` state (~line 65):

```ts
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => getUrlState().projectId);

  // Project scope is URL-addressable: /s/<space>/p/<projectId> (VAULT's
  // sentinel "__vault__" rides along unescaped-safe via encodeURIComponent).
  const handleProjectScopeChange = useCallback((projectId: string | null) => {
    setActiveProjectId(projectId);
    const target = projectId
      ? `/s/${activeSpace}/p/${encodeURIComponent(projectId)}`
      : `/s/${activeSpace}`;
    if (window.location.pathname !== target) {
      window.history.pushState(null, "", target);
    }
  }, [activeSpace]);
```

In `handleSpaceChange` (~line 270) add `setActiveProjectId(null);` after `setActiveSpace(space);`.

In `handlePopState` (~line 248), destructure `projectId` from `getUrlState()` and add `setActiveProjectId(projectId);`.

The three handlers that push a space URL directly also clear project scope — add `setActiveProjectId(null);` to: the `pendingReveal` branch (~line 183), the `open_artifact` SSE branch (~line 201), and the `switch_space` SSE branch (~line 208).

- [ ] **Step 3: Pass to Home**

In the `<Home …>` element add:

```tsx
        selectedProjectId={activeProjectId}
        onSelectProject={handleProjectScopeChange}
```

- [ ] **Step 4: Home consumes the lifted state**

In `Home/index.tsx`:

(a) Props interface adds:

```ts
  /** Project scope (a project id or the VAULT sentinel) — owned by App
   *  so it's URL-addressable. */
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
```

(b) Add both to the destructured params. Delete the local state (~line 261):

```ts
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
```

(c) Replace every `setSelectedProjectId(X)` call with `onSelectProject(X)` (grid tiles, Vault tile, scope-crumb ✕, and the `setSelectedProjectId` prop passed to `ProjectTileGrid` becomes `setSelectedProjectId={onSelectProject}`).

(d) The scope-reset effect (~lines 302–316): App now owns clearing project scope on space change, so remove the `selectedProjectId` handling — delete the `pendingFolderSelection` ref (it is never written; dead) and the `if (pendingFolderSelection.current) … else { setSelectedProjectId(null); }` block, keeping the limit/filter resets:

```ts
  useEffect(() => {
    setMemoriesLimit(MEMORIES_PREVIEW);
    setArtefactsLimit(ARTEFACTS_PREVIEW);
    setSessionsLimit(SESSIONS_PREVIEW);
    setArtefactSource("all");
    setArtefactKind("all");
    setSelectedCwd(null);
  }, [scopedSpace, isHomeView]);
```

- [ ] **Step 5: Typecheck + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: clean; no remaining `setSelectedProjectId` identifier in Home (the ProjectTileGrid *prop name* stays — only Home's local setter is gone).

- [ ] **Step 6: Manual check**

Select a project on Home → URL becomes `/s/home/p/<id>`; reload → scope (title, crumb, hidden column) restores; back button → returns to `/s/home` unscoped; click a space pill while project-scoped → project clears; `/s/home/p/__vault__` reloads into Vault scope. Artifact deep-links (`/s/<space>/a/<id>`) and group popups still open.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx web/src/components/Home/index.tsx
git commit -m "app: project scope is URL-addressable (/s/<space>/p/<project>)"
```

---

### Task 6: Changelog + full build

**Files:**
- Modify: `CHANGELOG.md` (top `[Unreleased]` section — read the file head first and match its exact heading style)

- [ ] **Step 1: Changelog entry**

Under `[Unreleased]` (create the section if absent, mirroring the existing release-section format):

```md
### Changed
- **One surface, three tabs** — Sessions, Artefacts and Memories now sit in tabs below your projects, scoped by the selected space and project, with a scope crumb showing where you are.
- **Vault joins the project grid** — artefacts created in Oyster itself appear under a Vault card on Home, alongside your repos.
- **Unassigned pill retired** — projects without a space now appear on Home with everything else.

### Fixed
- **Sessions table names the repo** — the project column shows the repository name instead of the space, and steps aside when a project is selected.
```

- [ ] **Step 2: Full build + lint sweep**

Run from the repo root: `npm run build`
Expected: web tsc + vite build and server tsc all pass.
Run: `cd web && npm run lint` → clean.

- [ ] **Step 3: Final manual sweep**

One pass through: Home unscoped → space pill → project tile → each tab → Vault card → shield page → ⌘K Spotlight → ChatBar message box renders untouched at the bottom → New session pill. Nothing visually broken, no console errors.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "changelog: unified scope tabs, vault card, repo-named sessions"
```

---

## Out of scope (PR 2/3 per spec)

- Ask Oyster slide-over panel; ChatBar demotion/removal.
- SpotlightSearch "ask" row.
- `memories.project_id`, dropping `sessions.space_id`, any server change.

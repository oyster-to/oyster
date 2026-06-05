# Unified scope UX — design

**Status:** Draft for review · 2026-06-05 · branch `unified-scope-ux`

## Goal

One page shape for the whole app. Spaces, projects, and the three content
types (sessions, artefacts, memories) stop being separate worlds and become
**one surface with a scope**: pills scope to a space, cards scope to a
project, a tab strip shows the scoped content.

Interactive prototype from the brainstorm:
`.superpowers/brainstorm/41975-1780637235/content/structure-interactive.html`

## Premises

- Target user already runs agents daily. First-run is data-rich (discovered
  projects, backfilled sessions/artefacts) — there is no empty-state problem.
  Judge the UX by its *transitions* (e.g. organise-into-spaces), not arrival.
- Chat does not take centre stage. "Ask Oyster" is an affordance on the
  surface, not the front door.

## Problem

The schema is project-centric (sessions, artefacts, and paths all hang off
`projects`; spaces merely group them), but the UX is space-centric and
split into two genres:

- Home is a dashboard of four stacked flat lists; a space is a different
  world (the Desktop tile canvas). Project — the hub entity — has no view.
- The sessions table's PROJECT column shows the *space* name once a session
  has a `space_id` (`SessionRow.tsx`: `spaceLabel ?? cwdBasename`), so
  running "Organise into spaces" coarsens the table — two repos in one
  space become indistinguishable exactly when the user gains structure.
- Null relations are promoted to destinations (Unassigned pill) while real
  relations (which repo owns this session) are demoted to tooltips.
- "Vault" names two unconnected surfaces: the Pro/inventory page and the
  no-project-artefacts tile in the projects grid — which are in fact the
  same concept (what lives in `~/Oyster`) at different zoom levels, with
  nothing in the UI connecting them.

## Design

### Structure

```
[ ⌂ Home | <space pills> | + ]                  [+ New session] [shield] [oyster]

  {Scope title}            "Your work." / "<space>." / "<project>  in <space>"

  PROJECTS                 cards: repo projects + Vault card (when non-empty)
  [client-portal] [website] [Vault] …

  [ Sessions | Artefacts | Memories ]     scope: everything ▸ <space> ▸ <project>
  ─────────────────────────────────────
  (active tab's content, scoped)
```

### Scoping rules

- **Space pill click** = scope to space. Cards narrow to its projects,
  tabs narrow to its content, title becomes the space name.
- **Project card click** = scope to project (sets space implicitly from the
  project). Click again, or the ✕ on the scope crumb, to deselect.
- **Selection, not navigation** — but URL-addressable: `/s/<space>` and
  `/s/<space>/p/<project>` map onto scope state. Existing artifact/group
  deep links (`/s/<id>/a/<artifactId>`, `/g/<group>`) keep working.
- **Scope is law.** Every tab shows exactly what the schema places in scope:
  sessions and artefacts via `project_id`, memories via the project's space
  (plus global). Redundant columns disappear when scope implies them — the
  PROJECT column is hidden at project scope.
- Scope derivation is one-directional: Project → Space. The UI never reads
  `sessions.space_id` for display again.

### Tabs

- **Sessions** (default tab) — existing table + filter chips
  (live/waiting/done/all) + FULL/COMPACT toggle, moved inside the tab.
  The project column always shows the *repo* name, never the space.
- **Artefacts** — absorbs the Desktop surface: icon-grid view with groups
  and pins, plus the existing table view and source/kind filters. Pinned
  artefacts float first, groups render as folders, exactly as Desktop does
  today — just scoped and inside a tab.
- **Memories** — existing list with a scope badge per row (`<space>` /
  `global`). At project scope shows the project's space memories + global.
- Tab counts render in the strip. Active tab persists per scope level in
  localStorage (like `oyster.home.sessionsView` today).

### Vault

One concept at two zoom levels — both keep the name:

- **Vault card** in the projects grid (exists today, `ProjectTileGrid.tsx`):
  the *working* zoom — artefacts whose files live in `~/Oyster` rather than
  a repo. Scopes like any project card: native artefacts, orphan sessions,
  global memories. Links to the shield page.
- **Shield page** (Pro teaser + `vault-inventory.ts`): the *system* zoom —
  everything `~/Oyster` holds. Untouched by this redesign.

Every card in the projects grid now answers the same question — "where does
this work live?" — your repos, plus Oyster's own vault.

### Retired

- **Desktop as a route/destination.** Its rendering moves into the Artefacts
  tab; `/s/<spaceId>` now lands on the unified page scoped to the space.
- **Unassigned pill + Elsewhere view.** Unassigned projects are ordinary
  cards at Home scope; orphan sessions are visible at Home scope. Absence of
  a relation is no longer a place.

### Unchanged

- Project cards (`ProjectTile`), `SessionRow`, `ArtefactTable`, `MemoryCard`,
  space pills with status pips, "Organise into spaces ✨" flow, inspector,
  session resume/connect, `+ New session`.
- No SQLite schema changes. `sessions.space_id` stays (flagged for eventual
  cleanup); `memories.project_id` is a noted future enhancement, not built.

## Ask Oyster

**Decision: topbar `✦ Ask` button opening a slide-over panel** (option A of
the placement study). The panel hosts the conversation beside the surface,
inherits the current scope (shown as a chip in its header), and reuses
ChatBar's input/slash-command/streaming logic re-homed. The bottom ChatBar
is removed when the panel ships.

**Later, not now:** the existing ⌘K palette (`SpotlightSearch.tsx`) gains an
"ask" row that opens the panel pre-filled — palette as launcher, panel as
surface. They compose; neither blocks the other.

**Rejected:** keeping a demoted bottom bar — it permanently spends vertical
space, preserves the chat-at-centre signal this design retires, and still
needs the panel to render answers.

## Delivery

Three PRs, each leaving the app fully working:

1. **Structural unification.** Tab strip + scope state, Artefacts tab
   absorbs Desktop, retire Unassigned pill/Elsewhere/Desktop route, project
   labelling fix, Vault card scoping. Bottom ChatBar untouched.
2. **Ask Oyster panel.** Slide-over panel + `✦ Ask` button + scope chip;
   ChatBar guts move in; bottom bar removed. Mostly code-motion.
3. **Palette integration** (when wanted). "Ask" row in SpotlightSearch →
   opens panel pre-filled.

## Out of scope / future

- `memories.project_id` (project-scoped memory).
- Dropping `sessions.space_id`.
- Any change to the shield/Pro page, publishing, sync, or MCP surface.

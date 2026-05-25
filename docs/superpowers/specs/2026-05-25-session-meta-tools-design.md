# Session meta-tools — `list_sessions` + `open_session`

**Date:** 2026-05-25
**Status:** Approved design, pre-implementation
**Branch:** `session-meta-tools`

## Problem

A user can ask the in-app agent meta-questions about past work and get answers
("which session was working with PR 593?" resolves today via `recall_transcripts`).
But the follow-up — "show me this session" — fails: the agent has no lever to
surface a past session in the UI, so it can only offer to search or resume.

The UI to *display* a session already exists (`SessionInspector`). The only
missing piece is an MCP tool the agent can call to open it.

## Goal

Complete the user story **"find the relevant session, then show it"** with two
MCP tools shipped together:

- `list_sessions` — discovery (recency-ordered, optionally space-scoped).
- `open_session` — surface a session in the inspector, optionally focused on a
  specific transcript turn.

Out of scope: richer cross-session analytics, new UI, changes to artifact
opening (`open_artifact` already covers artifacts).

## Existing machinery being reused (no changes)

| Layer | Component | Ref |
|---|---|---|
| Inspector UI | `SessionInspector` (transcript / artefacts / memory tabs) | `web/src/components/SessionInspector/index.tsx` |
| Cross-cutting "open this session" trigger | `window` CustomEvent `oyster:open-session` with `{ id, eventId?, query? }` → sets `activePanel = { kind: "session", … }` | `web/src/components/Home/index.tsx:665` |
| Proven caller of that event | Spotlight click-through | `web/src/components/SpotlightSearch.tsx:267` |
| MCP → UI push | `broadcastUiEvent()` → SSE `/api/ui/events` → `App.tsx` handler | `server/src/index.ts:751`, `web/src/App.tsx:198` |
| Session lookup | `sessionStore.getById(id)` | `server/src/session-store.ts:430` |
| MCP deps already wired | `deps.sessionStore`, `deps.broadcastUiEvent` | `server/src/mcp-server.ts:128,130` |

`UiCommand.command` is a free-form `string` (`shared/types.ts:244`), so no union
needs extending for a new `open_session` command.

## Design

### 1. Store — `server/src/session-store.ts`

Add a recency query (interface + implementation):

```ts
listRecent(opts?: { spaceId?: string; limit?: number }): SessionRow[];
```

SQL:

```sql
SELECT * FROM sessions
[WHERE space_id = ?]
ORDER BY COALESCE(last_event_at, started_at) DESC
LIMIT ?
```

- `COALESCE(last_event_at, started_at)` guards against null/stale `last_event_at`
  on stub sessions.
- An unknown `spaceId` simply yields zero rows — no error (the WHERE clause just
  doesn't match).

### 2. MCP tools — `server/src/mcp-server.ts`

Placed beside `open_artifact`.

**`list_sessions`** — discovery only, never returns transcript text.

- Params: `space_id?: string`, `limit?: number` (default **20**, max **100**).
- Returns slim rows: `{ id, title, space_id, agent, state, started_at, last_event_at, ended_at }`.
- Maps `sessionStore.listRecent({ spaceId: space_id, limit })`.
- Unknown `space_id` → empty array (not an error).

**`open_session`** — dumb broadcaster. Does **not** navigate routes or set space
itself; it only emits the command and lets the web app react.

- Params: `session_id: string` (required), `event_id?: number` (optional).
- Look up `sessionStore.getById(session_id)`. If missing → throw with a hint to
  use `list_sessions` / `recall_transcripts`.
- `event_id` is **best-effort and NOT validated** here — pass it straight
  through. If the event is missing, deleted, or belongs to another session, the
  inspector still opens (falls back to the latest tail); the open never fails on
  a bad `event_id`.
- Broadcast with the **canonical payload shape**:

  ```ts
  deps.broadcastUiEvent({
    version: 1,
    command: "open_session",
    payload: { sessionId: session.id, eventId: event_id },
  });
  ```

- Return `Opened session "<title or id>"`.

### 3. Web handler — `web/src/App.tsx`

In the existing SSE `useEffect` (alongside `open_artifact`, `switch_space`):

```ts
if (event.command === "open_session") {
  const { sessionId, eventId } = event.payload as { sessionId: string; eventId?: number };
  window.dispatchEvent(new CustomEvent("oyster:open-session", {
    detail: { id: sessionId, eventId },
  }));
}
```

Payload→detail mapping is the one rename point: `{ sessionId, eventId }` (wire) →
`{ id, eventId }` (the shape `Home`'s `oyster:open-session` handler already
reads, where `eventId` becomes `focusEventId`). No route push — `Home` is always
mounted, so the event opens the inspector from any space. Mirrors Spotlight
exactly.

### 4. Agent guidance — `.opencode/agents/oyster.md`

- Add `list_sessions` and `open_session` to the tool table.
- Usage bullet: **"'show me / open this session'** → `open_session(session_id)`
  (id from `recall_transcripts` or `list_sessions`); pass `event_id` to land on
  the exact turn." Treat it as an instant navigation command like `open_artifact`.

### 5. Secondary

- **`CHANGELOG.md`** — user-visible entry under Added (the agent can now open a
  past session in the inspector, and list recent sessions). Refresh
  `docs/changelog.html` via `npm run build:changelog`.
- **`CLAUDE.md`** — replace the brittle "the server exposes 21 tools at `/mcp/`
  (17 artifact/space + 4 memory)" count with copy that won't drift, e.g.
  "the server exposes MCP tools for spaces, artefacts, sessions, and memory."

## Data flow

```
user: "show me this session"
  → agent: open_session(session_id, event_id?)
      → sessionStore.getById  (404 if unknown)
      → broadcastUiEvent { command:"open_session", payload:{ sessionId, eventId } }
          → SSE /api/ui/events
              → App.tsx: dispatch CustomEvent "oyster:open-session" { id, eventId }
                  → Home: setActivePanel({ kind:"session", id, focusEventId })
                      → SessionInspector renders (tolerates a missing focusEventId)
```

## Footguns addressed (from review)

1. `open_session` stays dumb — broadcast only, no direct routing.
2. Single canonical payload shape `{ sessionId, eventId }`; web maps to `{ id, eventId }`.
3. `event_id` optional + best-effort; a bad/missing event never fails the open.
4. `list_sessions` is discovery-only — no transcript snippets.
5. `limit` default 20 / max 100 so a client can't dump everything.
6. Ordering uses `COALESCE(last_event_at, started_at)` for null/stale stubs.
7. `space_id` optional; unknown space → empty list, not an error.
8. Tool-count copy reworded to avoid drift.

## Testing

- **Store:** `listRecent` returns recency order, respects `limit`, empty on
  unknown `spaceId`, and sorts a null-`last_event_at` row by its `started_at`.
- **MCP:** `open_session` 404s on unknown id; broadcasts the canonical payload;
  passes `event_id` through untouched and still succeeds when it's bogus.
  `list_sessions` clamps the limit and omits transcript text.
- **Manual:** in the running app, ask the agent "show me this session" after a
  `recall_transcripts` hit → inspector opens on the right session; with an
  `event_id` it lands on the matching turn; with a stale `event_id` it still
  opens.

## Files touched

| File | Change |
|---|---|
| `server/src/session-store.ts` | `+ listRecent` (interface + impl) |
| `server/src/mcp-server.ts` | `+ list_sessions`, `+ open_session` tools |
| `web/src/App.tsx` | `+ open_session` SSE handler |
| `.opencode/agents/oyster.md` | tool table + usage bullet |
| `CHANGELOG.md` / `docs/changelog.html` | Added entry + rebuild |
| `CLAUDE.md` | reword tool-count line |

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
-- Illustrative; bind via better-sqlite3 named params (@spaceId, @limit).
-- @spaceId is null when the caller omits space_id.
SELECT * FROM sessions
WHERE (@spaceId IS NULL OR space_id = @spaceId)
  -- Drop genuine empty stubs: no title AND no transcript events. Keeps every
  -- titled session and every session that has any events.
  AND ( (title IS NOT NULL AND title <> '')
        OR EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = sessions.id) )
ORDER BY COALESCE(last_event_at, started_at) DESC, started_at DESC, id DESC
LIMIT @limit
```

- `last_event_at` is `NOT NULL DEFAULT (datetime('now'))`, so the
  `COALESCE(last_event_at, started_at)` is defensive only (the NULL branch can't
  occur on a local row today) — kept for future-proofing. The real work is the
  `started_at DESC, id DESC` tie-breakers, which stop equal-`last_event_at` rows
  from re-ordering between calls.
- `listRecent` normalises the limit itself — default **20**, hard cap **100**,
  floor **1** — so the cap is unit-tested at the store boundary and no caller
  (MCP tool or otherwise) can dump the whole table.
- Empty-stub filter is **always on** for this tool — `list_sessions` is agent-
  facing discovery, so it should never expose contentless rows. It does **not**
  gate `open_session`, which takes an explicit id and opens any session.
- An unknown `spaceId` simply yields zero rows — no error (the WHERE clause just
  doesn't match).
- The `EXISTS` subquery is correlated but bounded by `LIMIT`; trivial at the
  session-table scale.

### 2. MCP tools — `server/src/mcp-server.ts`

Placed beside `open_artifact`.

**`list_sessions`** — discovery only, never returns transcript text.

- Params: `space_id?: string`, `limit?: number` (zod: positive int, optional —
  the default-20 / cap-100 normalisation lives in `listRecent`).
- Returns slim rows: `{ id, title, space_id, agent, state, started_at, last_event_at, ended_at }`.
- Maps `sessionStore.listRecent({ spaceId: space_id, limit })`, then projects to
  the slim shape (drops `cwd`, `jsonl_path`, exit/terminal facts, etc.).
- Unknown `space_id` → empty array (not an error).

**`open_session`** — dumb broadcaster. Does **not** navigate routes or set space
itself; it only emits the command and lets the web app react.

- Params: `session_id: string` (required), `event_id?: number` (optional),
  `query?: string` (optional).
- Look up `sessionStore.getById(session_id)`. If missing → throw with a hint to
  use `list_sessions` / `recall_transcripts`.
- `event_id` is the **globally-unique `session_events.id`** (`INTEGER PRIMARY
  KEY`) — the exact value `recall_transcripts` returns as `event_id`. It is
  **best-effort and MUST NOT be validated or bounds-checked** here. It is a row
  id, not a within-transcript position. If the event is missing, deleted, or
  belongs to another session, pass it through anyway — the inspector falls back
  to the latest tail and the open never fails on a bad `event_id`.
- `query` is an optional search/highlight string, threaded purely because the
  existing `oyster:open-session` event already accepts it (`{ id, eventId?,
  query? }`). When `recall_transcripts` matched a session on, say, "PR 593", the
  agent can pass that text so the inspector pre-fills its find bar. Optional and
  best-effort; unused-but-present is fine and keeps the wire shape aligned with
  the event the web side already consumes.
- Broadcast with the **canonical payload shape**:

  ```ts
  deps.broadcastUiEvent({
    version: 1,
    command: "open_session",
    payload: { sessionId: session.id, eventId: event_id, query },
  });
  ```

- Return `Opened session "<title or id>"`.

### 3. Web handler — `web/src/App.tsx`

In the existing SSE `useEffect` (alongside `open_artifact`, `switch_space`):

```ts
if (event.command === "open_session") {
  const { sessionId, eventId, query } = event.payload as {
    sessionId: string; eventId?: number; query?: string;
  };
  window.dispatchEvent(new CustomEvent("oyster:open-session", {
    detail: { id: sessionId, eventId, query },
  }));
}
```

Payload→detail mapping is the one rename point: `{ sessionId, eventId, query }`
(wire) → `{ id, eventId, query }` (the shape `Home`'s `oyster:open-session`
handler already reads, where `eventId` becomes `focusEventId` and `query`
becomes `initialSearchQuery`). No route push — `Home` is always mounted
(`App.tsx:597`, base surface layer), so the event opens the inspector from any
space. Mirrors Spotlight exactly.

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
  → agent: open_session(session_id, event_id?, query?)
      → sessionStore.getById  (404 if unknown)
      → broadcastUiEvent { command:"open_session", payload:{ sessionId, eventId, query } }
          → SSE /api/ui/events
              → App.tsx: dispatch CustomEvent "oyster:open-session" { id, eventId, query }
                  → Home: setActivePanel({ kind:"session", id, focusEventId, initialSearchQuery })
                      → SessionInspector renders (tolerates a missing focusEventId)
```

## Footguns addressed (from review)

1. `open_session` stays dumb — broadcast only, no direct routing.
2. Single canonical payload shape `{ sessionId, eventId, query }`; web maps to `{ id, eventId, query }`.
3. `event_id` optional + best-effort; a bad/missing event never fails the open.
   It is the global `session_events.id` row id, **not** a transcript position —
   the spec forbids bounds-validating it to prevent a future "hardening" regression.
4. `query?` threaded now to match the existing event shape `{ id, eventId?, query? }`,
   so transcript-match highlight works without a later wire change.
5. `list_sessions` is discovery-only — no transcript snippets.
6. `limit` default 20 / max 100 so a client can't dump everything.
7. Ordering `COALESCE(last_event_at, started_at) DESC, started_at DESC, id DESC` —
   the tie-breakers stop equal-timestamp stub rows from jumping between calls.
8. `space_id` optional; unknown space → empty list, not an error.
9. Empty-stub filter (no title AND no events) keeps session-store mess out of
   the agent-facing list; `open_session` is unaffected (explicit id).
10. Tool-count copy reworded to avoid drift.

## Testing

- **Store:** `listRecent` returns recency order, applies the default-20 / cap-100
  limit, returns empty on an unknown `spaceId`, orders equal-`last_event_at` rows
  by `started_at DESC` then `id DESC`, and excludes a no-title / no-event stub
  while keeping a titled-but-eventless row and an untitled-but-has-events row.
- **MCP:** `open_session` 404s on unknown id; broadcasts the canonical payload
  `{ sessionId, eventId, query }`; passes `event_id` through untouched and still
  succeeds when it's bogus (no validation). `list_sessions` clamps the limit to
  100, defaults to 20, and omits transcript text.
- **Manual — happy path:** in the running app, ask the agent "show me this
  session" after a `recall_transcripts` hit → inspector opens on the right
  session; with an `event_id` it lands on the matching turn; with a stale
  `event_id` it still opens.
- **Manual — protect the "Home always mounted" assumption:** trigger
  `open_session` while the surface is on a non-default route/view (e.g. an
  artifact viewer open, or a deep-linked `/s/<space>/a/<id>` URL) and confirm the
  inspector still opens. If a future refactor unmounts `Home` behind another
  view, this is where it breaks — the test makes that regression visible.

## Files touched

| File | Change |
|---|---|
| `server/src/session-store.ts` | `+ listRecent` (interface + impl) |
| `server/src/mcp-server.ts` | `+ list_sessions`, `+ open_session` tools |
| `web/src/App.tsx` | `+ open_session` SSE handler |
| `.opencode/agents/oyster.md` | tool table + usage bullet |
| `CHANGELOG.md` / `docs/changelog.html` | Added entry + rebuild |
| `CLAUDE.md` | reword tool-count line |

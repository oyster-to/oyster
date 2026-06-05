# One SSE stream per tab — design

**Status:** Approved · 2026-06-05 · branch `sse-single-stream`

## Problem

Chrome caps HTTP/1.1 at 6 connections per origin, shared across all tabs.
Every Oyster tab held two permanent SSE streams (`/api/ui/events` +
`/api/chat/events` via the always-mounted Ask panel; three during the
viewer's fix-error flow) — so **three open Oyster tabs saturated the pool
and every further fetch stalled forever**: no error, no banner, an
eternally empty UI. Affects dev (7337) and the installed app (4444 is also
HTTP/1.1). Diagnosed 2026-06-05 via `lsof` while testing #621.

## Fix

Chat events ride the existing `/api/ui/events` stream as a
`{command: "chat", payload: <opencode event>}` envelope:

- The server already held a **single internal subscription** to opencode's
  `/global/event` (opencode-manager) and fanned out to a dedicated browser
  client set. That set is deleted; `emitChatEvent()` now feeds
  `broadcastUiEvent` through an injected sink (no circular import).
- `broadcastUiEvent` gains the per-client buffer cap (1 MB) that the chat
  broadcaster had — chat deltas are high-frequency and a stalled tab must
  not grow Node's writable buffer unboundedly.
- Client: `subscribeToEvents` (chat-api) delegates to the `ui-events`
  singleton, filtering on `command === "chat"` — `useChatEvents` and
  ViewerWindow keep their exact contracts. Chat inherits the singleton's
  heartbeat-protected, visibility-aware reconnect (the old chat stream had
  neither).
- `/api/chat/events` route removed (UI and server ship together — no
  version skew). The ui-events route carries the same local-origin gate,
  so assistant output stays unreadable cross-origin.

**Result:** one SSE per tab. Stall threshold moves from 3 tabs to 6+, with
fetch headroom at every realistic count.

## Rejected

- **HTTP/2** — browsers refuse cleartext h2; localhost apps can't use it.
- **BroadcastChannel leader election** (one stream per origin, any tab
  count) — solves harder but adds failover complexity; revisit only if
  6+ simultaneous tabs becomes a real pattern.
- **Close streams on hidden tabs** — subsumed; the singleton already
  handles visibility, and one stream per tab makes it unnecessary.

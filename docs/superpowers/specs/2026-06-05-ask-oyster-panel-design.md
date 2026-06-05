# Ask Oyster panel — design (PR 2 of unified scope UX)

**Status:** Approved · 2026-06-05 · branch `ask-oyster-panel`

## Goal

Chat stops taking centre stage. The bottom ChatBar is removed; its input,
slash commands, and message thread move into a right-hand **slide-over
panel** opened from a `✦ Ask` button in the topbar. The panel inherits the
user's current scope and tells the agent about it.

Parent spec: `2026-06-05-unified-scope-ux-design.md` ("Ask Oyster" section —
option A, panel now, palette launcher later).

## Current state (verified)

- `web/src/components/ChatBar.tsx` already renders the full conversation
  inside itself (expands upward): bubbles, markdown (marked + DOMPurify),
  tool/reasoning blocks, question options, copy button, slash autocomplete.
  This PR is relocation, not a new chat UI.
- Slash commands: `/s` switch space, `/o` open artifact, `/p` publish,
  `/u` unpublish, `#space` quick-switch (+ positional `#N` variants).
- Chat sessions are **unscoped**: `createSession()`/`sendMessage()` carry no
  space/project; the agent doesn't know where the user is.
- App couplings: global "any printable key focuses chat" handler
  (`chatInputRef`), `onOpenTerminal` → hardcore-gate modal, `onAiError`
  banner, provider-status fallback, OnboardingDock's `oyster:send-prompt`
  event, `/session/<id>` URL push on first message (`useChatSession`).

## Design

### AskPanel

New `web/src/components/AskPanel/` slide-over, right-hand side:

- **Header:** `✦ Ask Oyster` · scope chip · ✕ close.
- **Body:** ChatBar's message feed, moved (markdown, tool/reasoning blocks,
  question options, copy chat, auto-scroll).
- **Footer:** ChatBar's input, moved (slash commands, autocomplete,
  keyboard navigation, placeholder rotation, provider-status fallback).
- Conversation state survives close/reopen within the session (panel
  unmount must not drop the thread — state lives in the panel's hook or
  is lifted, decided at plan time).

### Entry point

One `✦ Ask` button in the topbar cluster next to `+ New session`. The only
way in. Toggles the panel.

### Scope inheritance (real)

- Chip in the panel header reuses the unified-scope crumb shapes
  (`everything` / space / `space › project` / `vault`).
- Each sent message gets a client-side context prefix, e.g.
  `[Scope: space "tokinvest", project "tokinvest-client-portal" at ~/Dev/tokinvest-client-portal]`
  so the agent's MCP tools act in context. Omitted at `everything` scope.
- No server or chat-API changes.

### Removed

- The bottom ChatBar render in App + ChatBar-specific fixed-bottom CSS
  (~140 lines in App.css). Pages reclaim the bottom space.
- The global "any printable key focuses chat" handler.
- The ⚡ terminal button. If the hardcore-gate modal then has no caller,
  it and `handleOpenTerminal`/`confirmHardcore` are deleted too (plan
  verifies no other entry point exists).

### Kept working

- OnboardingDock's `oyster:send-prompt` → opens the panel and sends there.
- AI-error surfacing and provider-status fallback move into the panel.
- `/session/<id>` URL push on first message — unchanged behaviour, new home.
- ViewerWindow's fix-error flow (uses chat-api directly; unaffected).

## Out of scope

- PR 3: "ask" row in SpotlightSearch (⌘K) opening the panel pre-filled.
- Server-side session scoping (API-level spaceId/projectId).
- VAULT-sentinel scope type and `selectedCwd`-in-URL seams (deferred from
  PR 1 reviews; revisit when scope grows another consumer).

## Decisions log

- Type-anywhere-focuses-chat: **retired** (Matthew, 2026-06-05).
- ⚡ terminal escape hatch: **removed** (Matthew, 2026-06-05).
- Scope inheritance depth: **context prefix**, not display-only and not
  API-level (Matthew, 2026-06-05).

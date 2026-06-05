# Cloud Remote View — Design

**Date:** 2026-06-05
**Status:** Approved (brainstorm complete; implementation plan to follow)
**Branch:** `cloud-remote-view`

## What

A mobile-first web view at `https://oyster.to/app` (later `app.oyster.to`) where a signed-in Pro user can browse their cloud-synced session transcripts (including live tail of in-flight sessions), see and lightly manage their published artifacts, and see which device each session ran on. It mirrors the existing local web UI rather than introducing a new one — the same components, made responsive, fed by cloud data. Long-term this surface is the seed of a phone app; v1 is a dogfood tool for the author.

## Why

Session transcripts are already pushed to Cloudflare (encrypted chunks in R2, metadata in D1) and published artifacts are already served from `share.oyster.to` — but there is no way to *see* any of it without a running local Oyster. The plumbing is ~90% there; this is primarily a front-end project.

## Decisions made during brainstorm

- **v1 capability:** read + live tail + light publish actions (unpublish, change access mode). No chat, no session control.
- **Audience:** dogfood first — built on the real auth/tier path, no onboarding polish.
- **Renderer:** mirror the existing `web/` UI and make it responsive — *not* a separate mobile digest component tree. Desktop gets full fidelity free; mobile is a CSS/layout problem.
- **UI surface:** the post-`unified-scope-ux` Home shape — project grid + Sessions | Artefacts | Memories tabs + scope crumb — minus ChatBar and all local-only actions.
- **Sequencing:** backend (parser extraction, worker endpoints, cookie check) proceeds now in parallel with the in-flight `unified-scope-ux` work; all `web/` work waits until that PR1 lands (it restructures `Home/index.tsx` and `App.tsx` wholesale — the conflict zone is total).
- **Devices:** v1 shows device as a filter chip + row/header label (from `device_label`, already in synced metadata). A dedicated Devices view and desktop-app-views-other-devices are deferred.

## Architecture

```
Phone/desktop browser → https://oyster.to/app  (apex cookie already valid, #397)
                            |
                  oyster-cloud Worker (infra/oyster-cloud)
                   - serves cloud-mode web build (static assets, same origin)
                   - /app/api/* → /api/* rewrite (same-origin API calls)
                   - GET /api/sessions/metadata   (exists: incl. device_id/label)
                   - GET /api/sessions/:id/events (NEW: R2 chunk → decrypt → parse → paged turns)
                   - D1 oyster-auth + R2 oyster-session-bytes (existing bindings)
                   (publish admin = oyster.to/api/publish/* — already same-origin, no proxy)
```

Key existing facts this design leans on:

- Transcript chunk encryption is **server-side** (worker holds `SESSIONS_ENCRYPTION_KEY`; the chunk GET already returns decrypted plaintext to an authenticated cookie). No key-distribution problem in the browser.
- `GET /api/sessions/metadata` already returns per-session `device_id`, `device_label`, `state`, `cwd`, byte totals — the session list needs no new sync work.
- Memories sync to the same D1 as an **event log** (`created`/`forgotten`/`purged` via `/api/memories/events`) — there is no materialized read API. The Memories tab folds events into current state client-side (~30 lines); if tombstone edge cases snowball, cut the tab from v1.
- `oyster-publish` already has list/unpublish/update-share endpoints; the local server uses them today.

### Shared transcript parser

The JSONL→events parsing logic is extracted from the local server's ingest path into a shared module (top-level `shared/`, same pattern as the arcade's shared code) consumed by both `server/src` and `infra/oyster-cloud`. One parser, two runtimes — local and cloud rendering cannot diverge. Must handle both Claude Code and OpenCode transcript formats.

### Events endpoint

`GET /api/sessions/:id/events?before=<cursor>&limit=<n>` (and `?after=<cursor>` for live tail) — **tail-first**: the worker reads the chunk manifest (which has plaintext byte offsets per chunk), fetches the *last* chunk from R2, decrypts, parses, and returns the newest N turns plus a cursor. Paging backwards walks chunks toward the head.

Known cost, accepted for v1: AES-GCM cannot be range-read, so reading a chunk's tail means decrypting the whole chunk (≤25 MB). Worker-side caching of the parsed tail is a follow-on if polling makes this hot.

### Same-origin serving

The cloud-mode web build is served *by* the oyster-cloud worker, so the app keeps calling relative `/api/...` paths exactly as it does locally — no CORS on the read path, and the `oyster_session` cookie rides along automatically. The worker implements only the subset of local API routes the cloud UI actually uses; everything else is hidden by the mode flag, not stubbed.

### Auth: serve from the apex (decision, revised)

The cookie is **deliberately** host-only on the apex (`oyster_session=…; HttpOnly; Secure; SameSite=Lax`, no `Domain` — auth-worker worker.ts:138-149, issue #397: it must not leak to share.oyster.to, where untrusted published content runs). Widening it is therefore off the table.

**v1: the remote view lives at `oyster.to/app/*`**, routed to the oyster-cloud worker (path-scoped apex routes are the house style — `/auth/*`, `/api/publish/*`, `/p/*`). The cookie is already there; zero auth-worker changes. The shell's API calls are same-origin via an `/app/api/*` → `/api/*` rewrite inside the worker. Productization step: move to `app.oyster.to` with a one-time-code handshake (shared-D1 exchange) so it sets its own host-only cookie.

Regardless: share.oyster.to is *same-site* with the apex, so SameSite=Lax does not stop credentialed fetches from published HTML — all mutating `/api/*` routes on oyster-cloud and oyster-publish get Origin checks (absent Origin = non-browser client, allowed; foreign Origin = 403). This closes a pre-existing gap, not just a new one. The `/p/:token` password-unlock POST is exempt (legitimately posted from share.oyster.to).

Unauthenticated visits to oyster.to/app get a sign-in link to the existing `oyster.to/auth` flow.

### Publish actions

Already same-origin: the publish admin endpoints live at `oyster.to/api/publish/*`, the same origin as `/app`. The cloud UI calls them directly — no proxy, no CORS.

## UI

**Cloud mode is a build flag, not a fork.** Same `web/` codebase; a `VITE_OYSTER_MODE=cloud` build (or second Vite entry) deployed to the worker's static assets. The flag gates what doesn't exist in the cloud:

- **Hidden:** ChatBar, new-session pill, resume/terminal actions, archive/pin writes, space management, Spotlight action rows — anything needing a live local agent or local filesystem.
- **Kept:** the post-PR1 Home surface — project grid, space pills, Sessions | Artefacts | Memories tabs, scope crumb, URL routing (`/s/<space>/p/<project>`), SessionInspector.

**Tabs, fed by cloud data:**

- **Sessions** — list from session metadata. Cloud-mode addition: a **device** filter chip (from `device_label`) alongside the state filters; device label shown on rows and the inspector header. Rows name the repo via `cwd` basename (PR1's label logic already falls back to cwd basename when the projects registry has no entry — cloud has no registry, so the fallback is the path). Tapping a row opens SessionInspector backed by the events endpoint, newest-first.
- **Artefacts** — published artifacts as tiles; tap opens `share.oyster.to/p/{token}`; ⋯/long-press menu exposes unpublish and access-mode change.
- **Memories** — read-only list from synced memory data.

**Responsive:** one CSS pass over the existing surface (no separate mobile components), which the local UI inherits too. Expected collapses, to be validated on a real phone rather than over-designed up front:

- Project grid → single column / 2-up cards
- Tab strip → full width; scope crumb wraps below
- Sessions table → grid-template collapses to a two-line card per row (title + state / repo + time)
- SessionInspector → full-screen takeover with sticky back header

**Auth UX:** signed out → bounce to oyster.to sign-in → return. Pro-gated, same as sync itself.

## Live tail

When an open session's metadata says it's live, the inspector polls `GET /api/sessions/:id/events?after=<cursor>` every ~5 s (visible tab only; paused in background). The worker compares the cursor to the manifest's total size: nothing new → cheap empty response, no R2 read; new bytes → decrypt tail chunk, return only new turns. The session list refreshes on the same cadence so state pips flip live→done without reload. Plain polling — no SSE on the worker for v1; revisit only if it feels laggy in practice.

## Error handling

- Token expired / tier lapsed → single signed-out state with a sign-in link (no partial renders).
- Chunk fetch/decrypt failure → inline "couldn't load this part" with retry; rest of the transcript stays.
- Generation bump mid-read (session reset while viewing) → refetch manifest once, then surface the error.

## Testing

- **Parser extraction (riskiest move, real coverage):** vitest parity tests asserting the shared parser produces identical events to the current ingest path, against fixture JSONL from real sessions in both Claude Code and OpenCode formats.
- **Worker events endpoint:** request-level tests against fixture chunks (paging, after-cursor, generation bump).
- **UI:** manual browser checks per repo convention — including on an actual phone.

## Out of scope (v1)

- Chat / Ask-Oyster from the cloud (needs a relay to a running device — separate design)
- Desktop app viewing other devices' sessions (later: local UI points its session list at the same cloud API)
- Dedicated Devices view (per-device landing card — natural follow-on after the two-device test)
- Transcript search
- Worker-side caching of parsed chunks
- Native app packaging
- Onboarding/marketing surface; productization for all Pro users

## Guardrails (from design review)

- **Shared parser is JSONL → turn events only.** Display-state and output classification stay local; if extraction starts dragging those into `shared/`, stop. The protocol-artifact *predicate* (`isClaudeProtocolArtifact`) is the one deliberate exception — both runtimes need it and each applies the filtering at its own call site. Parity tests assert at the rendered-turn level, not DB-row level.
- **Don't fake the local events API contract.** Local pages by event-id windowing; cloud pages by byte cursor. A thin client-side adapter in cloud mode is the seam — don't contort the worker.
- **One capabilities object** (`caps.canChat`, `caps.canWrite`, …) set once per build — no scattered `mode === 'cloud'` conditionals through Home/index.tsx.
- **Live-tail cursor is byte-offset-based** — polls decrypt only chunks newer than the cursor (delta chunks are small); never re-decrypt the full tail chunk per poll.
- New wrangler routes are additive (`oyster.to/app*`); `cloud.oyster.to/api/*` is untouched, so the local sync clients see no change.
- Old sessions may have null `device_label` — the device filter tolerates it.

## Implementation notes

- All work in worktrees under `~/Dev/oyster.worktrees/` (this branch: `cloud-remote-view`).
- Backend slice (shared parser + worker endpoints + cookie pre-flight) has zero file overlap with `unified-scope-ux` (which is web-only) and can start immediately.
- UI slice starts only after `unified-scope-ux` PR1 lands; ideally after PR2 (ChatBar demotion) too, since that reduces cloud-mode divergence further.

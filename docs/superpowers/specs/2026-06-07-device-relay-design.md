# Device Relay — Design

**Date:** 2026-06-07
**Status:** Draft for review
**Depends on:** cloud remote view (#627), transcripts in cloud (#643), artefact registry mirror (#644)

## Problem

app.oyster.to is a truthful mirror: it shows that sessions and artefacts *exist*, but anything whose content lives on a device is inert. Opening an artefact's file, searching transcripts with ⌘K, talking to the agent, or attaching to a running terminal all require the local server — which sits behind NAT on a laptop.

The relay lets the cloud UI reach a user's online devices **live**, falling back to the mirror when they're offline. It is the seed of "/remote-session" (steer a running agent from a phone) and of the phone app.

## Decisions already made

| Decision | Choice |
|---|---|
| v1 scope | **Read-only**: file viewer, live session list/detail, ⌘K search. No keystrokes flow toward the device. |
| Enablement | **Auto-on for read-only** when a pro device is signed in. Interactive tiers (chat/resume, PTY) each require explicit per-device opt-in in later slices. |
| Multi-device routing | **Route by owning device.** Content requests go to the device that owns the item; offline device → mirror fallback for that item only. ⌘K is the one multi-device call (see §6). |
| Transport | **Per-user Durable Object** in oyster-cloud. Rejected: cloudflared-style tunnels (per-user Zero Trust provisioning, binary in the npm package); polling command queue (seconds of latency, dead end for SSE/PTY). |

## Architecture

```
Browser (app.oyster.to SPA)
   │  HTTPS  GET /api/relay/status
   │  HTTPS  GET /api/relay/d/:deviceId/<allowlisted path>
   ▼
oyster-cloud worker ── resolveSession (cookie) + pro gate
   │  stub = env.RELAY.idFromName(userId)     ← per-user DO; cross-user access structurally impossible
   ▼
RelayDO (WebSocket Hibernation API)
   ▲  one hibernatable WS per device_id, tagged by device_id
   │  multiplexed JSON frames (§4)
   │
Local Oyster server — relay-client.ts dials OUT:
   wss://app.oyster.to/api/relay/connect
   Cookie: oyster_session=<token from ~/Oyster/config/auth.json>
   │
   └─ allowlisted frames → loopback fetch http://127.0.0.1:<port>/<path>
```

New primitive: this is the first time the local server dials out a persistent socket (today all sync is request/response HTTPS). NAT traversal comes free from the dial-out direction, same trick as cloudflared/ngrok.

### Components

**`RelayDO`** (new, `infra/oyster-cloud/src/relay-do.ts`) — first Durable Object in oyster-cloud (wrangler.toml `[[durable_objects.bindings]]` + `[[migrations]]` tag v1). Holds device sockets via the Hibernation API (`state.acceptWebSocket(ws, [deviceId])`, `serializeAttachment` for device metadata, `setWebSocketAutoResponse` for ping/pong so keepalives don't wake it). Idle cost ~zero; sockets survive DO eviction.

**`relay-client.ts`** (new, `server/src/`) — runs whenever the existing `canRunCloudSync()` gate passes (pro tier + profile binding, `server/src/index.ts`). Sends a hello frame, then serves allowlisted request frames by loopback-fetching its own HTTP server. Jittered exponential backoff on disconnect (1s → 60s cap) — handles lid-close/wake for free. `OYSTER_RELAY=off` env var disables it entirely.

**Worker routes** (`infra/oyster-cloud/src/worker.ts`):
- `GET /api/relay/connect` — WS upgrade (device side). resolveSession + pro gate, then forward to the user's DO.
- `GET /api/relay/status` — browser side; DO returns online devices `[{device_id, device_label, connected_at}]`.
- `GET /api/relay/d/:deviceId/<path>` — browser side; worker validates browser session, checks `<path>` against the allowlist (§5), forwards into the DO, which frames it onto the device socket and streams the response back.
- `POST /api/relay/devices/:deviceId/disable` / `.../enable` — browser side; disable closes the socket (4403) and persists a `disabled` flag for that device_id in DO storage, so reconnect attempts are rejected until re-enabled from the cloud UI. The device cannot un-disable itself. This is the v1 kill switch; full session revocation (which would sign the device out of *all* cloud sync, not just relay) stays an account-level action outside relay UI.

**Web client** (`web/src/`) — `caps` stays build-time; relay adds **runtime** per-device state. Cloud SPA polls `/api/relay/status` (30s + on window focus) into a small store. UI changes in §6.

## Connection lifecycle

1. Device dials `/api/relay/connect` with its `oyster_session` cookie. Each device's sign-in is its own session row in D1, so the token *is* the device credential.
2. Worker resolves session (valid, not revoked, not expired, pro) and passes `{userId, deviceSession}` to the DO with the upgrade.
3. Device sends `{type:"hello", proto:1, device_id, device_label, routes:[...]}`. `routes` advertises what this server version supports — handles version skew when later slices add routes.
4. DO checks its `disabled` set first — a device disabled from the cloud UI is rejected (4403) before any socket is accepted. Otherwise it tags the socket with `device_id` and stores `{device_label, sessionToken, connectedAt, validatedAt}` via `serializeAttachment` (see security §6 for why storing the token here is acceptable). A second connect with the same `device_id` closes the old socket (newest wins — matches the single-instance lockfile reality: one server per machine).
5. **Revocation**: on each forwarded request the DO checks the device's session validity against D1, cached 5 minutes. Invalid → close the socket with code 4401. No alarms, no timers; an idle revoked socket dies on the next request aimed at it, which is the only moment it matters. The browser side is independently session-checked by the worker on every request.

## Frame protocol (proto 1)

All frames are JSON text messages. `id` is a per-request UUID minted by the DO.

```
device → DO   {type:"hello", proto:1, device_id, device_label, routes:[string]}
DO → device   {type:"req", id, method:"GET", path}
device → DO   {type:"res_start", id, status, headers:{[k]:v}}
device → DO   {type:"res_chunk", id, body_b64}        // ≤256KB raw per chunk
device → DO   {type:"res_end", id}
device → DO   {type:"res_err", id, code}              // e.g. "not_allowed", "fetch_failed"
```

- **Chunking is mandatory**, not an optimisation: Workers caps inbound WS messages at 1 MiB. 256KB raw (~342KB b64) per chunk stays well clear.
- Limits: 10 MB total response (then `res_err` `"too_large"` → browser 413), 30s per request (DO times out → 504), 100 requests/min and 20 concurrent per socket (DO-side counters → 429).
- **Why 10 MB is enough:** deck/app artefacts are bundles — the viewer fetches the HTML page and then each asset as a separate relayed request, so the per-response cap almost never binds on them. And the cap interacts with the timeout: 10 MB of b64 over a typical laptop uplink already approaches the 30s budget; a 50 MB cap would mostly convert 413s into 504s. v1 viewer targets text/Markdown/HTML/images; other types render inert ("open on \<device\>").
- Base64 inflates ~33%; acceptable for v1 (MD/HTML/images). If it ever matters, hibernation sockets accept binary messages — a proto 2 could move chunks to length-prefixed binary frames without touching the request/response shape.
- `proto` is the hook for slice 2 (SSE frames) and slice 3 (raw-WS PTY frames) on the same socket.

## Security model

**Threat model:** the relay turns a loopback-only server into something reachable from the internet via the worker. The assets at risk are the local filesystem (artefact serving), transcript content, and — in later slices — keystrokes into a terminal running an agent with filesystem access.

1. **Dual allowlist, device side authoritative.** The relay client is *not* a generic proxy into `handleHttpRequest`. It matches each frame against an explicit table of `(GET, path-pattern)` pairs and only then loopback-fetches. The DO enforces the same table before framing. A compromised worker can therefore still only ask for allowlisted reads; a bug in the worker allowlist is caught device-side. The two tables live in different codebases (server vs infra) — each carries a comment pointing at the other; drift fails closed (request rejected by whichever side is narrower).

   **v1 allowlist (GET only, no request bodies):**
   - `/api/sessions` — session list
   - `/api/sessions/:id` — session detail
   - `/api/sessions/search` — FTS, powers ⌘K
   - `/artifacts/<path>` — artefact file content (the file viewer)

   - `/api/artifacts` — live registry from the owning device. Reinstated during implementation: the mirror deliberately doesn't sync artefact file *URLs*, so the cloud client must ask the live device for them before it can open anything via `/artifacts/<path>`. The one list-shaped route, for exactly that reason.
   - `/docs/:name` — the registry's actual viewer route for filesystem artefacts (added during implementation). Resolved server-side from the artefact's registered path (id-keyed `getDocFile`), never computed from the URL — no traversal surface.

   Matching rules: percent-decode and normalise the pathname *before* pattern matching (so `..%2F` can't slip past a `:id` pattern), match on pathname only, and pass the query string through untouched (⌘K needs `?q=`).

2. **Device auth** = its own `oyster_session` token (§ lifecycle). **The v1 kill switch is the per-device disable flag** (DO storage; see routes) — it severs relay without touching sync. Session revocation still works as a stronger backstop: the 5-min revalidation drops the socket and the client stops reconnecting — but it signs the device out of everything, so it lives at account level, not in relay UI. Cloud UI gets a device list with a disable toggle (reuses the `/api/relay/status` payload).

3. **Browser auth** unchanged: cookie → resolveSession + pro gate per request. The browser's userId selects the DO, so a user can only ever reach their own devices — no device id enumeration matters.

4. **Path containment — hard merge gate.** `/artifacts/<path>` resolution (`server/src/routes/static.ts` `resolveArtifactsUrl`) was only ever reachable from loopback. String normalisation is not containment: the implementation must resolve the **real path** (`fs.realpath`, after symlink resolution) and assert it sits inside the allowed roots before reading a byte. Required rejection tests, all of which must exist before the server PR merges: `../`, `%2e%2e%2f`, double-encoded traversal, a symlink inside an artefact dir pointing outside OYSTER_HOME, absolute-path injection, and odd Unicode/separator forms (macOS paths).

5. **Local-origin gates stay intact.** The relay client loopback-fetches from the same machine, so `rejectIfNonLocalOrigin()` passes naturally; no gate is loosened. The `/ws/terminal` route keeps its loopback-only posture in v1 — PTY exposure is slice 3, behind opt-in and its own spec addendum.

6. **Credential exposure, stated honestly.** The device's session token is sent once on connect (same as every sync request today) and is then stored in the socket's DO attachment for revalidation. This is *not* a new exposure class: in this schema the token **is** the session row's primary key, already at rest in plaintext in the shared D1 — the DO attachment is the same platform with the same access. The token is never framed device→browser, never appears in `/api/relay/status`, and `auth.json` never leaves the device. The R2 encryption posture is untouched (relay reads are live HTTP, not stored). If the auth schema ever moves to hashed tokens, the DO attachment moves with it.

7. **Read-only is not "safe", and we say so.** Relay v1 exposes the same private local read surface (session metadata, transcript search hits, artefact file contents — local paths, project names, command output included) to the **authenticated owner**, remotely. That is the product. It is not public, but it is a meaningful expansion of where that data can be read from, and it's why the allowlist is minimal, GET-only, and dual-enforced.

8. **Visibility.** The relay client logs one line per relayed request (`[relay] GET /artifacts/... 200 34ms`) via the existing offline logger — the device owner can see exactly what the remote view touched.

9. **Relayed responses are origin-hardened** (added during implementation, #657). Device-controlled response headers are stripped to `content-type`; the DO forces `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff` + `Cache-Control: private, no-store`. Relayed artefact HTML therefore renders with an opaque origin and cannot act with app.oyster.to's authority (the auth cookie lives there) — the same problem share.oyster.to solves with a separate hostname, solved here with a header.

## Web UI behaviour (v1)

- **Artefact rows** (table + icon views): if the row's origin device is online per relay status → row is openable; the viewer fetches through `/api/relay/d/:deviceId/artifacts/<path>`. Offline → exactly today's inert row with the `⌂ on <device>` chip. Relay is progressive enhancement over the mirror; nothing regresses when no device is online.
- **Session detail**: transcript stays on the synced-bytes path (already live). The relay adds the *live* session list/detail so just-started sessions appear before their first chunk sync.
- **⌘K**: enabled when ≥1 device online. Queries each online device in parallel (3s timeout each), concatenates results grouped by device label. No merge/dedup logic — sessions live on exactly one device. Offline devices' transcripts simply don't appear (the mirror has no FTS; that stays true). This is the single deviation from strict per-item routing, and it's concat-only.
- **Device presence**: a small indicator (e.g. in the topbar or sessions header) showing online devices, doubling as the disable/enable surface.

## Failure modes

| Failure | Behaviour |
|---|---|
| Device offline / socket gone mid-request | DO → 502 `relay_device_offline`; UI silently falls back to mirror state (never an error page) |
| Request timeout (device wedged) | DO → 504 after 30s |
| Response > 10 MB | `res_err too_large` → 413; row stays inert |
| Device session revoked | Socket closed 4401; client does **not** reconnect until next sign-in |
| Relay disabled for device (cloud toggle) | Socket closed 4403; reconnects rejected until re-enabled; sync unaffected |
| Rate limit exceeded | 429; browser backs off |
| Version skew (old server, new routes) | hello `routes` doesn't include it → DO rejects locally with 502, never frames it |

## Testing

- **Worker (vitest-pool-workers, supports DOs):** connect auth (401 unsigned / 403 free-tier), per-user DO isolation (user B cannot reach user A's device), allowlist enforcement (non-allowlisted path → rejected before framing), full frame round-trip against a fake device socket, chunk reassembly, offline → 502, rate limit → 429, revoked-session → socket close.
- **Server (vitest, mock WS server):** relay client rejects non-allowlisted frames (the authoritative check), path-traversal rejection on `/artifacts/<path>`, backoff/reconnect, hello contents, `OYSTER_RELAY=off`.
- **Hand-test:** phone on cellular → app.oyster.to → open a laptop MD artefact; ⌘K finds a transcript string; close the laptop lid → row goes inert within one status poll; revoke the device → same, and the laptop log shows the 4401.

## Rollout

1. Worker PR: RelayDO + routes + tests. Deploy first — DO sits empty, no devices know about it. (Manual `wrangler deploy`, as ever; DO migration tag v1 in the same deploy.)
2. Server PR: relay-client + allowlist + traversal tests. Released via npm; devices connect as users upgrade.
3. Web PR (can ride with 1): status store + openable rows + ⌘K + presence/disable UI.

Within the slice, build and review the **file-read path first** (status + open an MD artefact end-to-end), then layer search/detail on the proven transport. The first security review then focuses on the one genuinely dangerous thing: safe local file reads through the relay.
4. CHANGELOG (consumer-visible): "Open artefact files and search transcripts from app.oyster.to while your device is online."

Both orders are safe: a new server dialing an old worker gets 404 and backs off; an old server ignores the relay entirely.

## Future slices (designed for, not built)

- **Slice 2 — chat + resume (per-device opt-in):** relay the `/api/ui/events` SSE stream (chat deltas ride it; there is no discrete chat-stream endpoint) as `sse_*` frames, plus `POST /api/chat/*` and `POST /api/sessions/:id/resume`. First write-capable routes; opt-in flag lives in local config and is advertised in hello `routes`.
- **Slice 3 — PTY attach (per-device opt-in, spec addendum required):** raw WS proxy frames (`ws_open`/`ws_data`/`ws_close`) bridging browser ↔ `/ws/terminal`. Needs: write-confirmation UX before first keystroke, idle timeout, and real auth on the terminal WS path (today it is loopback-origin-gated only). This is the "/remote-session" payoff and the riskiest surface — it gets its own review.
- **caps evolution:** `canChat` etc. shift from build-time constants to per-device runtime capability derived from relay status + advertised routes.

## Open questions

- Status poll vs. push: 30s polling is fine for v1; if it feels laggy, the browser could hold its own WS to the DO later (the DO already speaks WS).
- Should the device surface also list *mirror-only* devices (those that have synced but aren't relay-connected)? Lean yes eventually — it's the natural "my devices" page — but out of scope for v1.

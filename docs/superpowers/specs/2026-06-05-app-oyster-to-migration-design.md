# app.oyster.to Migration — Design

**Date:** 2026-06-05
**Status:** Approved
**Predecessor:** `2026-06-05-cloud-remote-view-design.md` (shipped: PR #619 backend, PR #622 UI — live at `oyster.to/app`)

## Goal

Move the cloud remote view from `oyster.to/app` to its own hostname, `app.oyster.to`. The apex `oyster_session` cookie is host-only by design (#397) and cannot follow to the subdomain, so the slice's heart is a one-time-code auth handshake through the shared D1. Everything else is routing: the oyster-cloud worker takes ownership of the new hostname, the SPA base flattens from `/app/` to `/`, publish/spaces calls reach oyster-publish via a service binding, and old `/app` URLs 308 over.

## Pinned invariants (do not regress)

1. **Never widen the cookie `Domain`.** The apex cookie and the new app cookie are both host-only. `share.oyster.to` serves untrusted published HTML and is same-site with both, so `SameSite=Lax` alone does not protect — host-only is the protection (#397).
2. **Handoff codes are hashed at rest** (sha256, mirroring `magic_link_tokens`), have a **60-second TTL**, are **single-use**, and are **burned atomically** (`UPDATE … SET consumed_at WHERE consumed_at IS NULL AND expires_at > ? RETURNING session_id` — two concurrent callbacks cannot both win).
3. **App sign-out revokes the shared session row**, signing the browser out of the apex too. This is intentional: both cookies carry the same session id; "signed out" means signed out.
4. **Bad, expired, or reused callback codes render a static retry page** with a link back to the handoff. The callback never auto-redirects on failure — no redirect loop is constructible.
5. **The D1 migration and the hand-maintained `seed.ts` schema mirror ship in the same slice** (`infra/oyster-cloud/test/fixtures/seed.ts` mirrors auth-worker migrations by hand; an unmirrored migration silently rots the test fixture).
6. **The service-binding path is tested against oyster-publish's host assumptions.** oyster-publish has real host-dependent logic (`/api/publish/access-redirect/*` 308s `www`/`share` hosts to the apex; `/p/*` 308s apex hosts to share). Proxied requests arrive with `url.hostname === "app.oyster.to"`, which falls through both checks. Tests must prove the proxied routes (`/api/publish/mine`, `PATCH`/`DELETE /api/publish/:token`, `/api/spaces/*`) behave identically on the app host.
7. **Explicit 308 tests** for `oyster.to/app`, `oyster.to/app/`, `oyster.to/app/foo`, and query-string preservation (plus the `www.` equivalents).

## 1. Auth handshake

### D1 migration `0013_app_handoff_codes.sql` (auth-worker migrations, additive)

```sql
CREATE TABLE IF NOT EXISTS app_handoff_codes (
  code_hash   TEXT PRIMARY KEY,   -- sha256 hex of the raw token; raw never stored
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,   -- created_at + 60_000
  consumed_at INTEGER
);

-- The GC path scans on expires_at; index it now while the table is empty.
CREATE INDEX IF NOT EXISTS idx_app_handoff_codes_expires_at
ON app_handoff_codes (expires_at);
```

**Time units: all three timestamp columns are milliseconds since epoch** (`Date.now()`), matching every other auth-worker table (`sessions.expires_at`, `magic_link_tokens.expires_at`, `device_codes.expires_at` are all ms). TTL is `created_at + 60_000`. No seconds anywhere in this slice.

Mirror the table **and the index** in `infra/oyster-cloud/test/fixtures/seed.ts` in the same commit (invariant 5).

### auth-worker (apex): `GET /auth/app-handoff?return=<path>`

- **Valid apex cookie** → mint a raw 32-byte token (`randomToken(32)`, the existing helper), insert its sha256 hash with a 60s TTL, then 302 →
  `https://app.oyster.to/auth/callback?code=<raw>[&return=<encoded path>]`.
  Opportunistic GC on each mint: `DELETE FROM app_handoff_codes WHERE expires_at < ? LIMIT 100` (mirrors the `device_codes` GC already running in production, so D1's `DELETE … LIMIT` support is proven there — but the test fixture's SQLite build may differ, so a GC test must pass against the fixture; if `DELETE … LIMIT` fails there, fall back to the subquery form `DELETE FROM app_handoff_codes WHERE code_hash IN (SELECT code_hash FROM app_handoff_codes WHERE expires_at < ? LIMIT 100)` in both code and test).
- **No/invalid cookie** → 302 → `/auth/sign-in?return=/auth/app-handoff`. Requires one exact-match addition to the `validateReturnPath` allowlist in `infra/auth-worker/src/return-path.ts`: the literal path `/auth/app-handoff` (no query — the validator's no-query rule stands). After sign-in, the existing return-path machinery lands the user back on the handoff, now with a cookie, and the first branch fires.
- **`return` pass-through validation** (handoff → callback): must start with `/`, must not start with `//`, no control characters, ≤ 256 chars. Anything failing validation is dropped (callback defaults to `/`). Consequence: **deep links survive the silent-SSO path only**; a full sign-in lands on `/`. Accepted for dogfood.
- No new rate limit: minting requires a valid session cookie; the unauthenticated branch is a pure redirect.

### oyster-cloud (`app.oyster.to`): `GET /auth/callback?code=<raw>&return=<path>`

1. Hash the raw code, burn atomically (invariant 2).
2. Verify the returned `session_id` still resolves to a live session (not revoked, not expired) via the existing `resolveSession` query shape.
3. Set the host-only cookie: `oyster_session=<session id>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` — identical attributes to the apex cookie, **no `Domain`** (invariant 1). Same session id, not a new session row.
4. 302 → validated `return` or `/`.
5. Any failure (no code, burn returned nothing, session dead) → static HTML retry page (invariant 4): brief copy + link to `https://oyster.to/auth/app-handoff`.

### oyster-cloud (`app.oyster.to`): `POST /auth/sign-out`

Revoke the session row in shared D1 (`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`), clear the cookie, return `{ok: true}`. Apex sign-out follows automatically (invariant 3). Guarded by `rejectBadOrigin`.

### Signed-out navigation on `app.oyster.to`

Replaces today's 401 sign-in page: 302 → `https://oyster.to/auth/app-handoff?return=<current path+search, validated>`. Hashed assets stay public (unchanged). Loop-safety: the handoff never redirects back without either a code (cookie present) or a trip through sign-in; the callback never redirects on failure.

### Accepted risk (documented, not mitigated)

Login-CSRF on the callback: an attacker with their own valid code could force a victim's browser through the callback and sign them into the attacker's account. Standard residual risk for code handoffs without a pre-existing binding cookie on the receiving host; meaningless for a personal read-mostly view. Revisit if accounts ever become multi-user.

## 2. Worker dispatch (oyster-cloud)

Top-level `fetch` becomes a hostname split. Order remains load-bearing and regression-tested.

**`app.oyster.to`** (new custom domain):
1. `GET /auth/callback` → handshake callback
2. `POST /auth/sign-out` → sign-out handler
3. `/api/publish/*` and `/api/spaces/*` → `env.PUBLISH.fetch(req)` — service binding to oyster-publish, request forwarded untouched (cookie and `Origin` header pass through; URL keeps the app hostname — see invariant 6)
4. `/api/*` → existing API handlers, **paths arrive bare** — the `/app/api/*` rewrite is deleted
5. everything else → SPA shell: public hashed assets via `ASSETS` (no more `/app` prefix-stripping — the binding's namespace and the URL space now agree), auth-gated navigations (signed-out → handoff redirect, signed-in → index at `/`)

**`oyster.to` / `www.oyster.to`**:
- `/app` and `/app/*` → 308 → `https://app.oyster.to/<path minus /app>` preserving query (invariant 7). `/app` exactly → `https://app.oyster.to/`. These routes stay in wrangler.toml indefinitely; the shell-serving and rewrite code for the apex is deleted.
- **Path-boundary guard:** match `pathname === "/app" || pathname.startsWith("/app/")` — never a bare `startsWith("/app")`. The current worker's www branch (`worker.ts:27`) has exactly this bug: `www.oyster.to/application` 308s today. Fix it in this slice and pin it with a negative test (`/application` → 404, both hosts).

**`cloud.oyster.to/api/*`**: untouched — local-server sync traffic, Bearer-authenticated.

### wrangler.toml (oyster-cloud)

```toml
[[routes]]
pattern = "app.oyster.to"
custom_domain = true        # auto-provisions DNS + cert on deploy

[[services]]
binding = "PUBLISH"
service = "oyster-publish"
```

Existing `oyster.to/app*` + `www.oyster.to/app*` routes remain (they now serve only 308s). The `[assets]` block is unchanged (`directory = "../../web/dist-cloud"`, SPA not-found handling, `run_worker_first`).

`Env` gains `PUBLISH: Fetcher`.

## 3. SPA (web/)

- `web/src/caps.ts`: cloud `apiBase: ""` and `routeBase: ""` — cloud and local become URL-identical. The `apiPath()` / `stripBase` / `withBase` indirection stays in place (call sites untouched; only the constants change). Update the file's header comment to name the new home.
- Vite cloud build: base `/app/` → `/` (same `dist-cloud` outDir, same `npm run build:cloud`).
- `AuthBadge` cloud sign-out: POST same-origin `/auth/sign-out` (now answered by oyster-cloud), then `window.location.href = "/"`.
- Cloud data adapters (`cloud-sessions` / `cloud-publications` / `cloud-spaces` / `cloud-memories` / `ui-events`): **zero changes.** Their relative `/api/...` URLs resolve against the app origin; the worker's dispatch and the publish proxy take it from there. The "apex, NOT apiPath-wrapped" comments in cloud-publications/cloud-spaces are updated to describe the proxy.
- `shareUrl` stays `https://share.oyster.to/p/<token>`.

## 4. Origin allowlists

Add `https://app.oyster.to` to `ALLOWED_BROWSER_ORIGINS` at both breadcrumb comments:
- `infra/oyster-cloud/src/json.ts`
- `infra/oyster-publish/src/worker.ts`

The service binding preserves the browser's `Origin: https://app.oyster.to` header, so oyster-publish's mutation guard sees the app origin directly.

## 5. Error handling

| Failure | Behaviour |
| --- | --- |
| Callback: missing/malformed/expired/reused code | Static retry page, 4xx (invariant 4) |
| Callback: session revoked between mint and burn | Same static retry page |
| Handoff: signed out at apex too | Sign-in page → back through handoff |
| Proxy: oyster-publish unreachable (binding error) | Surface the thrown error as a structured 502 `proxy_failed` |
| Sign-out without a cookie | Clear cookie, `{ok: true}` (idempotent, mirrors auth-worker) |

## 6. Testing

**oyster-cloud (vitest-pool-workers):**
- Callback matrix: valid code → Set-Cookie (host-only, HttpOnly, Secure, Lax, no Domain) + 302 to `/` or validated `return`; reused code → retry page; expired code → retry page; revoked session → retry page; concurrent double-burn → exactly one winner.
- Sign-out: revokes the row (subsequent `resolveSession` fails), clears cookie, origin-guarded.
- 308s: `/app`, `/app/`, `/app/foo`, `/app/foo?a=1&b=2` on apex and www (invariant 7); negative: `/application` does NOT redirect on either host.
- GC: expired handoff rows are deleted by the `DELETE … LIMIT` form against the test fixture (see §1 for the subquery fallback if the fixture's SQLite rejects it).
- Dispatch: `/api/publish/mine` and `/api/spaces/mine` on the app host route to the `PUBLISH` binding (stub `Fetcher` in env); `/api/sessions/...` on the app host hits the existing handlers bare; signed-out navigation 302s to the handoff; hashed assets bypass auth.
- Origin guard: mutation with `Origin: https://app.oyster.to` passes; foreign origin still 403s.

**oyster-publish (vitest-pool-workers):** proxied routes behave identically with `url.hostname === "app.oyster.to"` — `mine`, `PATCH`, `DELETE`, spaces routes (invariant 6); app-origin mutations pass the origin guard.

**auth-worker (vitest):** handoff mints + 302s with a cookie (code present in Location, row hashed in D1); 302s to sign-in without a cookie; `validateReturnPath` accepts the exact handoff path and still rejects queries/others; GC deletes expired rows.

**web/:** no test runner — `tsc -b`, lint (pre-existing-error baseline must not grow), `npm run build`, `npm run build:cloud`.

## 7. Cutover

One sitting, manual deploys from the merged branch, in order:
1. `wrangler d1 migrations apply oyster-auth --remote` (0013)
2. Deploy auth-worker (handoff endpoint live; inert until used)
3. Deploy oyster-publish (origin allowlist; inert)
4. `npm run build:cloud` (new base `/`)
5. Deploy oyster-cloud (custom domain provisions DNS/cert on first deploy; `/app` flips to 308s in the same deploy as the new hostname goes live)
6. **Remote smoke test immediately after step 5** — first-deploy provisioning is the fragile moment. Minimum: `curl -I https://app.oyster.to/` (expect 302 to the handoff, proving DNS + cert + worker), `curl -I https://oyster.to/app` (expect 308 to `https://app.oyster.to/`), then the authenticated pass with the E2E token: `curl -b "oyster_session=$TOKEN" https://app.oyster.to/api/me` and `/api/publish/mine` (proves cookie path + service binding end-to-end). Then the real dogfood: phone.

Old `/app` bookmarks 308 over forever. CHANGELOG: still deferred — the cloud remote view is unannounced; this slice moves an unannounced surface.

## Out of scope

- Deep-link preservation through a full sign-in (silent-SSO-only, see §1)
- Search rungs 2/3, projects grid in cloud, add-space from cloud (unchanged backlog)
- Retiring the `oyster.to/app*` routes (they stay as redirects)
- Any auth-worker sign-in UI changes

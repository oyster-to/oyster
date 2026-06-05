# app.oyster.to Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the cloud remote view from `oyster.to/app` to `app.oyster.to` with a one-time-code auth handshake, a custom-domain worker route, a service-binding proxy for publish/spaces, and 308s from the old URLs.

**Architecture:** The apex `oyster_session` cookie is host-only (#397) and cannot follow to the subdomain. The auth-worker (apex) mints a hashed, 60s, single-use code in the shared D1; oyster-cloud (now owning `app.oyster.to` via custom domain) burns it atomically and sets its own host-only cookie carrying the *same session id*. `/api/publish/*` + `/api/spaces/*` forward to oyster-publish over a service binding. The SPA base flattens `/app/` → `/`.

**Tech Stack:** Cloudflare Workers (wrangler manual deploys), D1 (shared `oyster-auth`), @cloudflare/vitest-pool-workers, Vite/React (web/).

**Spec:** `docs/superpowers/specs/2026-06-05-app-oyster-to-migration-design.md` — read the "Pinned invariants" section before starting any task.

**Worktree:** `~/Dev/oyster.worktrees/app-oyster-to-migration`, branch `app-oyster-to-migration`. All commands below run from that worktree root unless stated.

**Conventions that bite:**
- All timestamps are **milliseconds** since epoch (`Date.now()`), matching every existing auth table.
- `infra/oyster-cloud/test/fixtures/seed.ts` and `infra/auth-worker/test/fixtures/seed.ts` are **hand-maintained schema mirrors** — any migration change updates both in the same commit.
- web/ has **no test runner**: verification is `tsc -b` + lint (pre-existing error count must not grow) + both builds.
- Do NOT deploy anything from a subagent. Deploys happen in the main session (Task 11).

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `infra/auth-worker/migrations/0013_app_handoff_codes.sql` | create | handoff codes table + expires index |
| `infra/auth-worker/test/fixtures/seed.ts` | modify | mirror new table |
| `infra/oyster-cloud/test/fixtures/seed.ts` | modify | mirror new table |
| `infra/auth-worker/src/return-path.ts` | modify | allow `/auth/app-handoff` |
| `infra/auth-worker/src/worker.ts` | modify | `GET /auth/app-handoff` handler + route |
| `infra/auth-worker/test/app-handoff.test.ts` | create | handoff tests |
| `infra/oyster-cloud/src/app-auth.ts` | create | `/auth/callback`, `/auth/sign-out`, return validation, retry page |
| `infra/oyster-cloud/src/worker.ts` | modify | hostname dispatch: 308s, app host, proxy |
| `infra/oyster-cloud/src/app-shell.ts` | modify | drop `/app` stripping; signed-out → handoff redirect |
| `infra/oyster-cloud/src/session.ts` | modify | `Env.PUBLISH: Fetcher` |
| `infra/oyster-cloud/src/json.ts` | modify | origin allowlist + comment |
| `infra/oyster-cloud/wrangler.toml` | modify | custom_domain route + `[[services]]` |
| `infra/oyster-cloud/vitest.config.ts` | modify | `serviceBindings.PUBLISH` stub |
| `infra/oyster-cloud/test/app-auth.test.ts` | create | callback/sign-out tests |
| `infra/oyster-cloud/test/redirects.test.ts` | create | 308 matrix + `/application` negative |
| `infra/oyster-cloud/test/app-shell.test.ts` | rewrite | new-hostname shell tests + proxy dispatch |
| `infra/oyster-cloud/test/origin-guard.test.ts` | modify | app origin passes |
| `infra/oyster-publish/src/worker.ts` | modify | origin allowlist |
| `infra/oyster-publish/test/app-host.test.ts` | create | proxied routes on app hostname |
| `web/vite.config.ts` | modify | cloud base `/app/` → `/` |
| `web/src/caps.ts` | modify | `apiBase`/`routeBase` → `""` |
| `web/src/components/AuthBadge.tsx` | modify | sign-out comment + redirect `/` |
| `web/src/data/cloud-publications.ts`, `web/src/data/cloud-spaces.ts` | modify | comment updates only |

---

### Task 1: Migration 0013 + both seed mirrors

**Files:**
- Create: `infra/auth-worker/migrations/0013_app_handoff_codes.sql`
- Modify: `infra/auth-worker/test/fixtures/seed.ts`
- Modify: `infra/oyster-cloud/test/fixtures/seed.ts`

- [ ] **Step 1: Write the migration**

Create `infra/auth-worker/migrations/0013_app_handoff_codes.sql`:

```sql
-- One-time codes for the apex → app.oyster.to auth handshake
-- (spec 2026-06-05-app-oyster-to-migration). The apex oyster_session
-- cookie is host-only (#397) and cannot follow to the subdomain; the
-- auth-worker mints a code here, oyster-cloud burns it and sets its own
-- host-only cookie with the same session id.
-- All timestamps are milliseconds since epoch (Date.now()), matching
-- sessions / magic_link_tokens / device_codes.
CREATE TABLE IF NOT EXISTS app_handoff_codes (
  code_hash   TEXT PRIMARY KEY,   -- sha256 hex of the raw token; raw never stored
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,   -- created_at + 60_000
  consumed_at INTEGER
);

-- The opportunistic GC path (DELETE … WHERE expires_at < ? LIMIT 100)
-- scans on expires_at; index it now while the table is empty.
CREATE INDEX IF NOT EXISTS idx_app_handoff_codes_expires_at
ON app_handoff_codes (expires_at);
```

- [ ] **Step 2: Mirror in the auth-worker test fixture**

In `infra/auth-worker/test/fixtures/seed.ts`, the `SCHEMA_SQL` template string contains all tables. Append the new table + index just before the closing backtick of `SCHEMA_SQL`, and add `--   infra/auth-worker/migrations/0013_app_handoff_codes.sql (app_handoff_codes)` to the "Keep in sync with" comment list at the top:

```sql
CREATE TABLE IF NOT EXISTS app_handoff_codes (
  code_hash   TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_handoff_codes_expires_at
  ON app_handoff_codes (expires_at);
```

- [ ] **Step 3: Mirror in the oyster-cloud test fixture**

In `infra/oyster-cloud/test/fixtures/seed.ts`, append the same two statements (identical SQL as Step 2) just before the closing backtick of `SCHEMA_SQL`, with a comment line above them: `-- Mirror of infra/auth-worker/migrations/0013_app_handoff_codes.sql`.

- [ ] **Step 4: Run both worker test suites to prove the fixtures still parse**

```bash
cd infra/auth-worker && npx vitest run
cd ../oyster-cloud && npx vitest run
```

Expected: all existing tests PASS (the fixture splits on `;` and runs each statement; new statements are inert).

- [ ] **Step 5: Commit**

```bash
git add infra/auth-worker/migrations/0013_app_handoff_codes.sql infra/auth-worker/test/fixtures/seed.ts infra/oyster-cloud/test/fixtures/seed.ts
git commit -m "feat(auth): migration 0013 app_handoff_codes + seed mirrors"
```

**Do NOT apply the migration to remote D1 in this task** — that is cutover step 1 (Task 11, main session).

---

### Task 2: return-path allowlist for the handoff

**Files:**
- Modify: `infra/auth-worker/src/return-path.ts`
- Test: `infra/auth-worker/test/return-path.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing describe block in `infra/auth-worker/test/return-path.test.ts`:

```ts
it("accepts the app-handoff path exactly", () => {
  expect(validateReturnPath("/auth/app-handoff")).toBe("/auth/app-handoff");
});

it("rejects app-handoff with a query string", () => {
  expect(validateReturnPath("/auth/app-handoff?return=%2F")).toBeNull();
});

it("rejects app-handoff with a suffix", () => {
  expect(validateReturnPath("/auth/app-handoff/extra")).toBeNull();
});
```

- [ ] **Step 2: Run to verify the first fails**

```bash
cd infra/auth-worker && npx vitest run test/return-path.test.ts
```

Expected: FAIL — `validateReturnPath("/auth/app-handoff")` returns `null`.

- [ ] **Step 3: Implement**

In `infra/auth-worker/src/return-path.ts`, add a constant next to the existing regexes and extend the accept line:

```ts
// The app.oyster.to handshake (spec 2026-06-05-app-oyster-to-migration):
// after sign-in, return to the handoff so it can mint a code for the
// subdomain. Exact match only — the no-query rule stands.
const APP_HANDOFF_PATH = "/auth/app-handoff";
```

and change:

```ts
  if (SHARE_VIEWER_PATH.test(raw) || ACCESS_REDIRECT_PATH.test(raw)) return raw;
```

to:

```ts
  if (raw === APP_HANDOFF_PATH) return raw;
  if (SHARE_VIEWER_PATH.test(raw) || ACCESS_REDIRECT_PATH.test(raw)) return raw;
```

- [ ] **Step 4: Run tests**

```bash
cd infra/auth-worker && npx vitest run test/return-path.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/auth-worker/src/return-path.ts infra/auth-worker/test/return-path.test.ts
git commit -m "feat(auth): allow /auth/app-handoff as a sign-in return path"
```

---

### Task 3: auth-worker `GET /auth/app-handoff`

**Files:**
- Modify: `infra/auth-worker/src/worker.ts`
- Create: `infra/auth-worker/test/app-handoff.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `infra/auth-worker/test/app-handoff.test.ts`. Follow the established pattern from `return-path-integration.test.ts` (worker.fetch + execution context; `MAGIC_LINK_LIMIT` stub):

```ts
// Tests for GET /auth/app-handoff — the apex side of the app.oyster.to
// handshake (spec 2026-06-05-app-oyster-to-migration).
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { sha256Hex } from "../src/worker";
import { applySchema } from "./fixtures/seed";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).MAGIC_LINK_LIMIT = { limit: async () => ({ success: true }) };
});

beforeEach(async () => { await applySchema(); });

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedSession(opts: { revoked?: boolean; expired?: boolean } = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const sid = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `${userId}@example.com`, now, now).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sid, userId, now,
      opts.expired ? now - 1000 : now + 86_400_000,
      opts.revoked ? now : null).run();
  return sid;
}

function handoffReq(opts: { cookie?: string; ret?: string } = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", `oyster_session=${opts.cookie}`);
  const qs = opts.ret !== undefined ? `?return=${encodeURIComponent(opts.ret)}` : "";
  return new Request(`https://oyster.to/auth/app-handoff${qs}`, { headers });
}

describe("GET /auth/app-handoff", () => {
  it("redirects to sign-in when there is no cookie", async () => {
    const res = await call(handoffReq());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/sign-in?return=%2Fauth%2Fapp-handoff");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("redirects to sign-in when the session is revoked", async () => {
    const sid = await seedSession({ revoked: true });
    const res = await call(handoffReq({ cookie: sid }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/sign-in?return=%2Fauth%2Fapp-handoff");
  });

  it("mints a hashed single-use code and 302s to the app callback", async () => {
    const sid = await seedSession();
    const before = Date.now();
    const res = await call(handoffReq({ cookie: sid }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://app.oyster.to");
    expect(loc.pathname).toBe("/auth/callback");
    const code = loc.searchParams.get("code")!;
    expect(code.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url

    const row = await env.DB.prepare("SELECT * FROM app_handoff_codes WHERE code_hash = ?")
      .bind(await sha256Hex(code))
      .first<{ session_id: string; expires_at: number; consumed_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe(sid);
    expect(row!.consumed_at).toBeNull();
    // 60s TTL in milliseconds.
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + 59_000);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("passes a valid return path through to the callback", async () => {
    const sid = await seedSession();
    const res = await call(handoffReq({ cookie: sid, ret: "/sessions/abc?tab=1" }));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBe("/sessions/abc?tab=1");
  });

  it.each([
    ["protocol-relative", "//evil.example"],
    ["absolute", "https://evil.example/"],
    ["control chars", "/a\nb"],
    ["overlong", "/" + "a".repeat(300)],
  ])("drops an invalid return path (%s)", async (_name, ret) => {
    const sid = await seedSession();
    const res = await call(handoffReq({ cookie: sid, ret }));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("return")).toBeNull();
    expect(loc.searchParams.get("code")).not.toBeNull(); // handoff still proceeds
  });

  it("GCs expired rows on mint (proves DELETE … LIMIT on the fixture)", async () => {
    const sid = await seedSession();
    await env.DB.prepare(
      "INSERT INTO app_handoff_codes (code_hash, session_id, created_at, expires_at) VALUES ('stale', ?, 0, 1)",
    ).bind(sid).run();
    await call(handoffReq({ cookie: sid }));
    const stale = await env.DB.prepare("SELECT 1 FROM app_handoff_codes WHERE code_hash = 'stale'").first();
    expect(stale).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd infra/auth-worker && npx vitest run test/app-handoff.test.ts
```

Expected: FAIL — `/auth/app-handoff` 404s (route doesn't exist).

- [ ] **Step 3: Implement the handler**

In `infra/auth-worker/src/worker.ts`, add below `handleSignOut` (module scope, same file — that's the established pattern):

```ts
// ── app.oyster.to handshake (spec 2026-06-05-app-oyster-to-migration) ──
// The apex cookie is host-only (#397) and cannot follow to the subdomain.
// This endpoint mints a hashed, 60-second, single-use code in D1 and
// redirects to app.oyster.to/auth/callback, which burns it and sets its
// own host-only cookie carrying the same session id.
const APP_ORIGIN = "https://app.oyster.to";
const APP_HANDOFF_TTL_MS = 60 * 1000;

// Deep-link pass-through: a path(+search) on app.oyster.to. Must be a
// rooted path, not protocol-relative, no control chars, bounded length.
// Invalid values are dropped (callback defaults to "/"), never rejected.
function validateAppReturn(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.length > 256) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

async function handleAppHandoff(req: Request, env: Env, url: URL): Promise<Response> {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  const now = Date.now();
  const lookup = sid ? await getSession(env.DB, sid, now) : null;
  if (!lookup) {
    // Sign in first, then return here — /auth/app-handoff is in the
    // validateReturnPath allowlist (exact match, no query).
    return new Response(null, {
      status: 302,
      headers: { location: "/auth/sign-in?return=%2Fauth%2Fapp-handoff", ...NO_STORE },
    });
  }

  // Opportunistic GC, mirroring device_codes. Bounded LIMIT keeps any
  // single request cheap; over many requests the table stays trimmed.
  await env.DB
    .prepare("DELETE FROM app_handoff_codes WHERE expires_at < ? LIMIT 100")
    .bind(now)
    .run()
    .catch((err) => console.error("app_handoff_gc_failed", err));

  const rawCode = randomToken(32);
  const codeHash = await sha256Hex(rawCode);
  await env.DB
    .prepare("INSERT INTO app_handoff_codes (code_hash, session_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(codeHash, lookup.session.id, now, now + APP_HANDOFF_TTL_MS)
    .run();

  const dest = new URL("/auth/callback", APP_ORIGIN);
  dest.searchParams.set("code", rawCode);
  const ret = validateAppReturn(url.searchParams.get("return"));
  if (ret) dest.searchParams.set("return", ret);
  return new Response(null, { status: 302, headers: { location: dest.toString(), ...NO_STORE } });
}
```

Register the route in the default `fetch`, next to the other `/auth/*` routes (before the 404):

```ts
      if (url.pathname === "/auth/app-handoff" && req.method === "GET") {
        return await handleAppHandoff(req, env, url);
      }
```

- [ ] **Step 4: Run tests**

```bash
cd infra/auth-worker && npx vitest run
```

Expected: ALL PASS (new file + no regressions).

- [ ] **Step 5: Commit**

```bash
git add infra/auth-worker/src/worker.ts infra/auth-worker/test/app-handoff.test.ts
git commit -m "feat(auth): GET /auth/app-handoff mints one-time codes for app.oyster.to"
```

---

### Task 4: oyster-cloud `app-auth.ts` — callback + sign-out

**Files:**
- Create: `infra/oyster-cloud/src/app-auth.ts`
- Create: `infra/oyster-cloud/test/app-auth.test.ts`

Tests call the handlers **directly** (not via SELF.fetch) — dispatch wiring lands in Task 6. Direct calls need `env` from `cloudflare:test` and a constructed `Request`/`URL`.

- [ ] **Step 1: Write the failing tests**

Create `infra/oyster-cloud/test/app-auth.test.ts`:

```ts
// Direct-handler tests for the app.oyster.to handshake callback and
// sign-out (spec 2026-06-05-app-oyster-to-migration). Dispatch wiring is
// integration-tested in app-shell.test.ts (Task 6).
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";
import { handleAppCallback, handleAppSignOut } from "../src/app-auth.js";

async function sha256HexStr(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedSession(opts: { revoked?: boolean; expired?: boolean } = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const sid = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'pro', ?)")
    .bind(userId, `${userId}@example.com`, now).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sid, userId, now,
      opts.expired ? now - 1000 : now + 86_400_000,
      opts.revoked ? now : null).run();
  return sid;
}

async function seedCode(sid: string, opts: { expired?: boolean; consumed?: boolean } = {}): Promise<string> {
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app_handoff_codes (code_hash, session_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256HexStr(raw), sid, now,
    opts.expired ? now - 1000 : now + 60_000,
    opts.consumed ? now : null).run();
  return raw;
}

function callbackReq(code: string | null, ret?: string): { req: Request; url: URL } {
  const u = new URL("https://app.oyster.to/auth/callback");
  if (code !== null) u.searchParams.set("code", code);
  if (ret !== undefined) u.searchParams.set("return", ret);
  return { req: new Request(u), url: u };
}

describe("GET /auth/callback (app.oyster.to)", () => {
  beforeAll(async () => { await applySchema(); });

  it("burns a valid code, sets a host-only cookie, 302s to /", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw);
    const res = await handleAppCallback(req, env, url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`oyster_session=${sid}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain="); // invariant 1: host-only
    expect(res.headers.get("cache-control")).toContain("no-store");
    // Burned in D1.
    const row = await env.DB.prepare("SELECT consumed_at FROM app_handoff_codes WHERE session_id = ?")
      .bind(sid).first<{ consumed_at: number | null }>();
    expect(row!.consumed_at).not.toBeNull();
  });

  it("honours a validated return path", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw, "/sessions/abc?tab=1");
    const res = await handleAppCallback(req, env, url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sessions/abc?tab=1");
  });

  it("falls back to / for an invalid return path", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw, "//evil.example");
    const res = await handleAppCallback(req, env, url);
    expect(res.headers.get("location")).toBe("/");
  });

  async function expectRetryPage(res: Response): Promise<void> {
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("https://oyster.to/auth/app-handoff"); // retry link, no auto-redirect
  }

  it("shows the retry page for a missing code", async () => {
    const { req, url } = callbackReq(null);
    await expectRetryPage(await handleAppCallback(req, env, url));
  });

  it("shows the retry page for an unknown code", async () => {
    const { req, url } = callbackReq("not-a-real-code");
    await expectRetryPage(await handleAppCallback(req, env, url));
  });

  it("shows the retry page for an expired code", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid, { expired: true });
    const { req, url } = callbackReq(raw);
    await expectRetryPage(await handleAppCallback(req, env, url));
  });

  it("shows the retry page for a reused code (single-use)", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const a = callbackReq(raw);
    const first = await handleAppCallback(a.req, env, a.url);
    expect(first.status).toBe(302);
    const b = callbackReq(raw);
    await expectRetryPage(await handleAppCallback(b.req, env, b.url));
  });

  it("burns exactly once under concurrency", async () => {
    const sid = await seedSession();
    const raw = await seedCode(sid);
    const [r1, r2] = await Promise.all([
      (() => { const c = callbackReq(raw); return handleAppCallback(c.req, env, c.url); })(),
      (() => { const c = callbackReq(raw); return handleAppCallback(c.req, env, c.url); })(),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([302, 400]);
  });

  it("shows the retry page when the session was revoked between mint and burn", async () => {
    const sid = await seedSession({ revoked: true });
    const raw = await seedCode(sid);
    const { req, url } = callbackReq(raw);
    await expectRetryPage(await handleAppCallback(req, env, url));
  });
});

describe("POST /auth/sign-out (app.oyster.to)", () => {
  beforeAll(async () => { await applySchema(); });

  function signOutReq(opts: { cookie?: string; origin?: string } = {}): Request {
    const headers = new Headers();
    if (opts.cookie) headers.set("Cookie", `oyster_session=${opts.cookie}`);
    if (opts.origin) headers.set("Origin", opts.origin);
    return new Request("https://app.oyster.to/auth/sign-out", { method: "POST", headers });
  }

  it("revokes the shared session row and clears the cookie", async () => {
    const sid = await seedSession();
    const res = await handleAppSignOut(signOutReq({ cookie: sid }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const row = await env.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(sid).first<{ revoked_at: number | null }>();
    expect(row!.revoked_at).not.toBeNull(); // invariant 3: apex is signed out too
  });

  it("is idempotent without a cookie", async () => {
    const res = await handleAppSignOut(signOutReq(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects a foreign browser origin", async () => {
    const sid = await seedSession();
    const res = await handleAppSignOut(signOutReq({ cookie: sid, origin: "https://evil.example" }), env);
    expect(res.status).toBe(403);
  });
});
```

(The file above is complete: imports/helpers, the callback describe with 9 `it`s — valid, return honoured, return fallback, missing, unknown, expired, reused, concurrent, revoked-session — and the sign-out describe with 3 `it`s.)

- [ ] **Step 2: Run to verify failure**

```bash
cd infra/oyster-cloud && npx vitest run test/app-auth.test.ts
```

Expected: FAIL — module `../src/app-auth.js` does not exist.

- [ ] **Step 3: Implement `app-auth.ts`**

Create `infra/oyster-cloud/src/app-auth.ts`:

```ts
// app-auth.ts — app.oyster.to side of the auth handshake
// (spec 2026-06-05-app-oyster-to-migration). The apex oyster_session
// cookie is host-only (#397); /auth/app-handoff on the auth-worker mints
// a one-time code in the shared D1 and redirects here. We burn the code
// atomically and set our own host-only cookie carrying the SAME session
// id — so sign-out (which revokes the row) signs the browser out of the
// apex too, by design.
import type { Env } from "./session.js";
import { jsonOk, rejectBadOrigin } from "./json.js";
import { sha256Hex } from "./encryption.js";

// Cookie Max-Age matches the apex cookie (30 days). The session row's own
// expires_at is the real gate — a cookie that outlives the row just 401s
// into a fresh handoff.
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const HANDOFF_URL = "https://oyster.to/auth/app-handoff";

// Mirrors validateAppReturn in the auth-worker (both ends validate).
export function validateAppReturn(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.length > 256) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

// Invariant 4: bad/expired/reused codes get a STATIC page with a retry
// link — never an auto-redirect, so no loop is constructible.
const RETRY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oyster</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:2rem auto;max-width:40rem;padding:0 1rem;background:#101014;color:#e8e8ee}a{color:#7c6bff}</style>
</head><body><h1>Sign-in link expired</h1>
<p>That sign-in handoff is no longer valid — codes are single-use and expire after a minute.</p>
<p><a href="${HANDOFF_URL}">Try again</a></p></body></html>`;

function retryPage(): Response {
  return new Response(RETRY_PAGE, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** GET /auth/callback?code=…&return=… — burn the handoff code, set the
 *  host-only cookie, land in the SPA. */
export async function handleAppCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("code");
  if (!raw || raw.length > 100) return retryPage();

  const codeHash = await sha256Hex(new TextEncoder().encode(raw));
  const now = Date.now();
  // Atomic burn (invariant 2): only an unconsumed, unexpired row marks
  // itself consumed; two concurrent callbacks cannot both see RETURNING.
  const burned = await env.DB.prepare(
    `UPDATE app_handoff_codes
        SET consumed_at = ?
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING session_id`,
  ).bind(now, codeHash, now).first<{ session_id: string }>();
  if (!burned) return retryPage();

  // The session may have been revoked/expired between mint and burn.
  const live = await env.DB.prepare(
    "SELECT 1 FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
  ).bind(burned.session_id, now).first();
  if (!live) return retryPage();

  const ret = validateAppReturn(url.searchParams.get("return")) ?? "/";
  // Host-only cookie (invariant 1): same attributes as the apex cookie,
  // NO Domain — it must not leak to share.oyster.to or anywhere else.
  const cookie = `oyster_session=${burned.session_id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
  return new Response(null, {
    status: 302,
    headers: { location: ret, "set-cookie": cookie, "cache-control": "no-store" },
  });
}

const CLEARED_COOKIE = "oyster_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

/** POST /auth/sign-out — revoke the shared session row (signs out the
 *  apex too — invariant 3) and clear the app cookie. Idempotent. */
export async function handleAppSignOut(req: Request, env: Env): Promise<Response> {
  const badOrigin = rejectBadOrigin(req);
  if (badOrigin) return badOrigin;
  const m = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)oyster_session=([^;]+)/);
  if (m) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(Date.now(), m[1]).run();
  }
  return jsonOk({ ok: true }, 200, { "set-cookie": CLEARED_COOKIE, "cache-control": "no-store" });
}
```

**Note:** the origin-guard test in Step 1 ("rejects a foreign browser origin") passes already with today's allowlist (foreign origins 403 regardless). The *app-origin-passes* case is Task 7, after the allowlist gains `https://app.oyster.to`.

- [ ] **Step 4: Run tests**

```bash
cd infra/oyster-cloud && npx vitest run test/app-auth.test.ts
```

Expected: PASS (all 12).

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-cloud/src/app-auth.ts infra/oyster-cloud/test/app-auth.test.ts
git commit -m "feat(cloud): app.oyster.to auth callback + sign-out handlers"
```

---

### Task 5: 308 redirects from oyster.to/app* (with boundary guard)

**Files:**
- Modify: `infra/oyster-cloud/src/worker.ts` (top of `fetch`)
- Create: `infra/oyster-cloud/test/redirects.test.ts`

The old `/app` shell/rewrite code is **removed in Task 6**, not here — this task only inserts the 308 branch *above* it, which intercepts everything the old code handled on apex/www. (The old branches become dead for apex/www but still serve the `example.com`-hosted legacy tests until Task 6 rewrites them.)

- [ ] **Step 1: Write the failing tests**

Create `infra/oyster-cloud/test/redirects.test.ts`:

```ts
// 308s from the legacy oyster.to/app* URLs to app.oyster.to (spec
// invariant 7), including the /application boundary-guard negative the
// old www branch got wrong.
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const HOSTS = ["oyster.to", "www.oyster.to"] as const;

describe("legacy /app* → app.oyster.to 308s", () => {
  for (const host of HOSTS) {
    it(`${host}/app → app.oyster.to/`, async () => {
      const res = await SELF.fetch(`https://${host}/app`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/");
    });

    it(`${host}/app/ → app.oyster.to/`, async () => {
      const res = await SELF.fetch(`https://${host}/app/`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/");
    });

    it(`${host}/app/foo → app.oyster.to/foo`, async () => {
      const res = await SELF.fetch(`https://${host}/app/foo`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/foo");
    });

    it(`${host}/app/foo?a=1&b=2 preserves the query`, async () => {
      const res = await SELF.fetch(`https://${host}/app/foo?a=1&b=2`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://app.oyster.to/foo?a=1&b=2");
    });

    it(`${host}/application does NOT redirect (boundary guard)`, async () => {
      const res = await SELF.fetch(`https://${host}/application`, { redirect: "manual" });
      expect(res.status).not.toBe(308);
      expect(res.status).toBe(404);
    });
  }

  it("preserves the method semantics (308, not 301)", async () => {
    const res = await SELF.fetch("https://oyster.to/app/foo", { method: "POST", redirect: "manual" });
    expect(res.status).toBe(308);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd infra/oyster-cloud && npx vitest run test/redirects.test.ts
```

Expected: FAIL — apex `/app` currently serves the shell (401/200), www currently 308s to the apex (wrong target), `/application` on www currently 308s (the boundary bug).

- [ ] **Step 3: Implement the 308 branch**

In `infra/oyster-cloud/src/worker.ts`, **replace** the current step-1 www branch (lines 26–29, the `url.hostname === "www.oyster.to" && url.pathname.startsWith("/app")` block) with this, keeping it as the first branch after `const url = new URL(req.url);`:

```ts
    // Legacy oyster.to/app* → app.oyster.to 308s (spec
    // 2026-06-05-app-oyster-to-migration, invariant 7). Path-boundary
    // guarded: /application must NOT match — never a bare startsWith("/app").
    if (
      (url.hostname === "oyster.to" || url.hostname === "www.oyster.to") &&
      (url.pathname === "/app" || url.pathname.startsWith("/app/"))
    ) {
      const rest = url.pathname.slice("/app".length) || "/";
      return new Response(null, {
        status: 308,
        headers: {
          location: `https://app.oyster.to${rest}${url.search}`,
          "cache-control": "public, max-age=3600",
        },
      });
    }
```

Leave the `/app/api/*` rewrite and the `/app*` shell branches in place for now (they still back the legacy `example.com`-hosted tests; Task 6 deletes them).

- [ ] **Step 4: Run the full suite**

```bash
cd infra/oyster-cloud && npx vitest run
```

Expected: redirects.test.ts PASSES; all existing tests still PASS (they use `example.com`, untouched by the hostname-guarded branch).

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-cloud/src/worker.ts infra/oyster-cloud/test/redirects.test.ts
git commit -m "feat(cloud): 308 oyster.to/app* to app.oyster.to with path-boundary guard"
```

---

### Task 6: app.oyster.to dispatch — shell rework, proxy, wiring

**Files:**
- Modify: `infra/oyster-cloud/src/worker.ts`
- Modify: `infra/oyster-cloud/src/app-shell.ts`
- Modify: `infra/oyster-cloud/src/session.ts`
- Modify: `infra/oyster-cloud/wrangler.toml`
- Modify: `infra/oyster-cloud/vitest.config.ts`
- Rewrite: `infra/oyster-cloud/test/app-shell.test.ts`

- [ ] **Step 1: Add the PUBLISH binding to Env**

In `infra/oyster-cloud/src/session.ts`, add to the `Env` interface after `ASSETS: Fetcher;`:

```ts
  // Service binding to oyster-publish: /api/publish/* and /api/spaces/*
  // on app.oyster.to forward over this (no public hop, cookie + Origin
  // pass through untouched). Spec 2026-06-05-app-oyster-to-migration.
  PUBLISH: Fetcher;
```

- [ ] **Step 2: wrangler.toml — custom domain + service binding**

In `infra/oyster-cloud/wrangler.toml`, add after the existing `[[routes]]` blocks:

```toml
# app.oyster.to — the remote view's own hostname (spec
# 2026-06-05-app-oyster-to-migration). custom_domain auto-provisions
# DNS + cert on deploy; the worker owns the entire hostname.
[[routes]]
pattern = "app.oyster.to"
custom_domain = true

# Forward /api/publish/* + /api/spaces/* on app.oyster.to to
# oyster-publish without a public hop. Cookie and Origin pass through.
[[services]]
binding = "PUBLISH"
service = "oyster-publish"
```

Also update the comment above the `oyster.to/app*` routes: they now exist only to serve 308s (replace the existing "Remote view (spec …)" comment block with `# Legacy /app* URLs — kept indefinitely, serve only 308s to app.oyster.to.`).

- [ ] **Step 3: vitest.config.ts — stub the service binding**

In `infra/oyster-cloud/vitest.config.ts`, inside the `miniflare:` object, add after `r2Buckets`:

```ts
          // Stub for the PUBLISH service binding (oyster-publish). Echoes
          // request facts so dispatch tests can assert what was forwarded.
          // The real binding is integration-tested in oyster-publish's own
          // app-host tests.
          serviceBindings: {
            PUBLISH(req: Request) {
              return new Response(
                JSON.stringify({
                  stub: "oyster-publish",
                  url: req.url,
                  method: req.method,
                  origin: req.headers.get("origin"),
                  hasCookie: req.headers.get("cookie") !== null,
                }),
                { headers: { "content-type": "application/json" } },
              );
            },
          },
```

(If the pool refuses to start because wrangler.toml's `[[services]]` references an unknown worker, this `serviceBindings` override is what resolves it — check it's spelled `PUBLISH` exactly.)

- [ ] **Step 4: Rework app-shell.ts**

Replace the entire contents of `infra/oyster-cloud/src/app-shell.ts` with:

```ts
// app-shell.ts — serves the cloud remote-view SPA on app.oyster.to
// (spec 2026-06-05-app-oyster-to-migration). Hashed assets pass straight
// through to the ASSETS binding (public); navigations are auth-gated —
// signed-out visitors are redirected into the apex handoff, which either
// silently SSOs them back (valid apex cookie) or routes through sign-in.
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";
import { validateAppReturn } from "./app-auth.js";

const HANDOFF_URL = "https://oyster.to/auth/app-handoff";

/** Serve the cloud SPA at the hostname root: public hashed assets,
 *  auth-gated navigations (signed-out → handoff redirect). */
export async function handleAppShell(req: Request, env: Env, url: URL): Promise<Response> {
  // Hashed asset requests (js/css/img) — public, no auth. The ASSETS
  // binding namespace and the URL space agree now (base "/"), so no
  // path rewriting is needed.
  if (url.pathname.startsWith("/assets/") || /\.(js|css|svg|png|ico|woff2?)$/.test(url.pathname)) {
    return env.ASSETS.fetch(req);
  }
  // Everything else is a navigation → auth-gate, then SPA index.
  const user = await resolveSession(req, env);
  if (!user) {
    const dest = new URL(HANDOFF_URL);
    const ret = validateAppReturn(`${url.pathname}${url.search}`);
    if (ret && ret !== "/") dest.searchParams.set("return", ret);
    return new Response(null, {
      status: 302,
      headers: { location: dest.toString(), "cache-control": "no-store" },
    });
  }
  // A signed-in FREE user gets the index too; the data APIs 403. Acceptable v1.
  // "/" not "/index.html": Cloudflare ASSETS canonicalises /index.html → /
  // with a 307, which would loop.
  return env.ASSETS.fetch(new Request(new URL("/", url.origin), req));
}
```

- [ ] **Step 5: Rewire worker.ts dispatch**

In `infra/oyster-cloud/src/worker.ts`:

1. Add the import: `import { handleAppCallback, handleAppSignOut } from "./app-auth.js";`
2. **Delete** the old step-2 `/app/api/*` rewrite block (the `if (url.pathname.startsWith("/app/api/")) { … }`) and the old step-3 `/app*` shell block (the `if (url.pathname === "/app" || url.pathname.startsWith("/app/")) { … }`), plus the now-stale dispatch-order comment above them.
3. Immediately after the Task-5 308 branch, insert the app-host branch:

```ts
    // app.oyster.to — handshake endpoints, publish/spaces proxy, SPA shell.
    // /api/* (non-publish/spaces) falls THROUGH to the shared API dispatch
    // below — the same handlers serve cloud.oyster.to (Bearer sync clients)
    // and app.oyster.to (cookie'd SPA).
    if (url.hostname === "app.oyster.to") {
      if (url.pathname === "/auth/callback" && req.method === "GET") {
        return handleAppCallback(req, env, url);
      }
      if (url.pathname === "/auth/sign-out" && req.method === "POST") {
        return handleAppSignOut(req, env);
      }
      if (url.pathname.startsWith("/api/publish/") || url.pathname === "/api/publish" ||
          url.pathname.startsWith("/api/spaces/")  || url.pathname === "/api/spaces") {
        // Service binding to oyster-publish — request forwarded untouched
        // (cookie + Origin ride along; URL keeps this hostname, which
        // oyster-publish's host checks fall through cleanly — see its
        // app-host tests).
        try {
          return await env.PUBLISH.fetch(req);
        } catch (err) {
          console.warn("[proxy] publish binding failed:", err);
          return jsonError(502, "proxy_failed");
        }
      }
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") return jsonError(405, "method_not_allowed");
        return handleAppShell(req, env, url);
      }
      // fall through: /api/* → shared dispatch below
    }
```

The `/health` check and everything below it stay exactly as they are.

- [ ] **Step 6: Rewrite app-shell.test.ts for the new hostname**

Replace the entire contents of `infra/oyster-cloud/test/app-shell.test.ts` with:

```ts
// app.oyster.to shell + dispatch integration tests (spec
// 2026-06-05-app-oyster-to-migration). Replaces the oyster.to/app-era
// tests — the legacy URLs are covered by redirects.test.ts now.
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { applySchema } from "./fixtures/seed.js";

async function makeProSession(suffix = crypto.randomUUID()): Promise<{ token: string; userId: string }> {
  const userId = `u-pro-${suffix}`;
  const token  = `tok-pro-${suffix}`;
  await env.DB.prepare(`INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'pro', ?)`)
    .bind(userId, `pro-${suffix}@example.com`, Date.now()).run();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(token, userId, Date.now(), Date.now() + 86400_000).run();
  return { token, userId };
}

describe("app.oyster.to shell", () => {
  beforeAll(async () => { await applySchema(); });

  it("redirects a signed-out navigation into the apex handoff", async () => {
    const res = await SELF.fetch("https://app.oyster.to/", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://oyster.to/auth/app-handoff");
  });

  it("carries the deep link as a return param", async () => {
    const res = await SELF.fetch("https://app.oyster.to/sessions/abc?tab=1", { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/auth/app-handoff");
    expect(loc.searchParams.get("return")).toBe("/sessions/abc?tab=1");
  });

  it("serves the SPA index when signed in", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("oyster");
  });

  it("serves SPA routes (deep paths) when signed in", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/s/some-space", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves hashed assets publicly (no auth)", async () => {
    const res = await SELF.fetch("https://app.oyster.to/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fixture");
  });

  it("rejects non-GET methods on shell paths", async () => {
    const res = await SELF.fetch("https://app.oyster.to/", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("app.oyster.to API dispatch", () => {
  beforeAll(async () => { await applySchema(); });

  it("serves /api/* bare via the shared dispatch (not the SPA catch-all)", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/api/sessions/metadata", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    // Dispatch-order guard: html here would mean the shell swallowed it.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toHaveProperty("sessions");
  });

  it("forwards /api/publish/* to the PUBLISH service binding", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://app.oyster.to/api/publish/mine", {
      headers: { Cookie: `oyster_session=${token}`, Origin: "https://app.oyster.to" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stub).toBe("oyster-publish");
    expect(body.url).toBe("https://app.oyster.to/api/publish/mine"); // hostname preserved
    expect(body.origin).toBe("https://app.oyster.to");               // Origin passes through
    expect(body.hasCookie).toBe(true);                                // cookie passes through
  });

  it("forwards /api/spaces/* to the PUBLISH service binding", async () => {
    const res = await SELF.fetch("https://app.oyster.to/api/spaces/mine");
    const body = await res.json() as Record<string, unknown>;
    expect(body.stub).toBe("oyster-publish");
    expect(body.method).toBe("GET");
  });

  it("auth callback is reachable through the dispatch", async () => {
    const res = await SELF.fetch("https://app.oyster.to/auth/callback?code=bogus", { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Try again");
  });

  it("sign-out is reachable through the dispatch", async () => {
    const res = await SELF.fetch("https://app.oyster.to/auth/sign-out", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 7: Run the full suite**

```bash
cd infra/oyster-cloud && npx vitest run
```

Expected: ALL PASS. Pre-existing suites (me-route, memories-events, sessions-routes, transcript-events, origin-guard, worker) use `example.com` URLs and fall through to the shared dispatch unchanged.

- [ ] **Step 8: Commit**

```bash
git add infra/oyster-cloud/src/worker.ts infra/oyster-cloud/src/app-shell.ts infra/oyster-cloud/src/session.ts infra/oyster-cloud/wrangler.toml infra/oyster-cloud/vitest.config.ts infra/oyster-cloud/test/app-shell.test.ts
git commit -m "feat(cloud): app.oyster.to hostname dispatch — shell, handshake wiring, publish proxy"
```

---

### Task 7: Origin allowlists in both workers

**Files:**
- Modify: `infra/oyster-cloud/src/json.ts`
- Modify: `infra/oyster-publish/src/worker.ts`
- Modify: `infra/oyster-cloud/test/origin-guard.test.ts`
- Modify: `infra/oyster-publish/test/origin-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

In `infra/oyster-cloud/test/origin-guard.test.ts`, add to the existing describe (mirror the shape of the existing origin cases — a mutating request with `Origin: https://app.oyster.to` plus a valid pro session, asserting it does NOT 403):

```ts
  it("allows the app.oyster.to browser origin", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/api/memories/events", {
      method: "POST",
      headers: {
        Cookie: `oyster_session=${token}`,
        Origin: "https://app.oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(200);
  });
```

(Adapt the helper name to whatever that file already uses for seeding a pro session — read the file first; if it has no such helper, copy `makeProSession` from `app-shell.test.ts`.)

In `infra/oyster-publish/test/origin-guard.test.ts`, add alongside the existing allowed-origin cases:

```ts
  it("allows the app.oyster.to browser origin", async () => {
    const u = await seedUser();
    const pub = await seedActivePublication({ ownerId: u.id });
    const res = await call(patchRequest(pub.shareToken, {
      sessionToken: u.sessionToken,
      origin: "https://app.oyster.to",
    }));
    expect(res.status).toBe(200);
  });
```

(Adapt seeding-helper signatures to what `fixtures/seed.ts` actually exports — read the existing allowed-origin test in that file and clone its shape with the new origin.)

- [ ] **Step 2: Run to verify both fail with 403**

```bash
cd infra/oyster-cloud && npx vitest run test/origin-guard.test.ts
cd ../oyster-publish && npx vitest run test/origin-guard.test.ts
```

Expected: the two new cases FAIL (403 `bad_origin`).

- [ ] **Step 3: Implement**

`infra/oyster-cloud/src/json.ts` — replace the allowlist and its NOTE comment line:

```ts
// Browser-origin guard for mutating routes (spec
// 2026-06-05-cloud-remote-view-design.md). share.oyster.to serves
// untrusted published HTML and is *same-site* with the apex, so
// SameSite=Lax alone doesn't stop credentialed cross-origin fetches from
// it. Non-browser clients (the local Oyster server) send no Origin
// header — absence passes. app.oyster.to is the remote view's own
// hostname (spec 2026-06-05-app-oyster-to-migration).
const ALLOWED_BROWSER_ORIGINS = new Set([
  "https://oyster.to",
  "https://www.oyster.to",
  "https://app.oyster.to",
]);
```

`infra/oyster-publish/src/worker.ts` — same change at its `ALLOWED_BROWSER_ORIGINS` (around line 686), removing the "NOTE: when the remote view migrates…" breadcrumb and adding `"https://app.oyster.to",` to the set with a comment line `// app.oyster.to — the remote view (spec 2026-06-05-app-oyster-to-migration).`

- [ ] **Step 4: Run both suites fully**

```bash
cd infra/oyster-cloud && npx vitest run
cd ../oyster-publish && npx vitest run
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/oyster-cloud/src/json.ts infra/oyster-publish/src/worker.ts infra/oyster-cloud/test/origin-guard.test.ts infra/oyster-publish/test/origin-guard.test.ts
git commit -m "feat: allow https://app.oyster.to in both origin guards"
```

---

### Task 8: oyster-publish app-host behaviour tests (test-only)

**Files:**
- Create: `infra/oyster-publish/test/app-host.test.ts`

Spec invariant 6: proxied requests arrive with `url.hostname === "app.oyster.to"`; oyster-publish has host-dependent logic (`/api/publish/access-redirect/*` 308s www/share → apex; `/p/*` 308s apex → share). Prove the proxied routes fall through cleanly.

- [ ] **Step 1: Read the seed fixture exports**

Read `infra/oyster-publish/test/fixtures/seed.ts` and `test/spaces-handler.test.ts` / `test/publish-mine-handler.test.ts` to confirm helper names (`seedUser`, `authHeader`, `seedSyncedSpace`, `seedActivePublication`, …) and clone their call shapes.

- [ ] **Step 2: Write the tests**

Create `infra/oyster-publish/test/app-host.test.ts`:

```ts
// Host-behaviour tests for the app.oyster.to service-binding path (spec
// 2026-06-05-app-oyster-to-migration, invariant 6). The oyster-cloud
// worker forwards /api/publish/* and /api/spaces/* with the URL hostname
// preserved as app.oyster.to — these prove the handlers behave exactly
// as they do on the apex, and that the host-dependent branches
// (access-redirect's www/share 308, /p/*'s apex 308) don't fire.
import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import { applySchema, seedUser, authHeader, seedSyncedSpace, seedActivePublication } from "./fixtures/seed";

beforeEach(async () => { await applySchema(); });

async function call(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("app.oyster.to host behaviour", () => {
  it("GET /api/spaces/mine works identically on the app host", async () => {
    const u = await seedUser();
    await seedSyncedSpace({ ownerId: u.id, spaceId: "work", updatedAt: 1000 });
    const res = await call(new Request("https://app.oyster.to/api/spaces/mine", {
      headers: { Cookie: authHeader(u.sessionToken).Cookie },
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as { spaces: Array<{ space_id: string }> };
    expect(json.spaces.map((s) => s.space_id)).toEqual(["work"]);
  });

  it("GET /api/publish/mine works identically on the app host", async () => {
    const u = await seedUser();
    await seedActivePublication({ ownerId: u.id });
    const res = await call(new Request("https://app.oyster.to/api/publish/mine", {
      headers: { Cookie: authHeader(u.sessionToken).Cookie },
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as { publications: unknown[] };
    expect(json.publications).toHaveLength(1);
  });

  it("PATCH /api/publish/:token works with the app origin on the app host", async () => {
    const u = await seedUser();
    const pub = await seedActivePublication({ ownerId: u.id });
    const res = await call(new Request(`https://app.oyster.to/api/publish/${pub.shareToken}`, {
      method: "PATCH",
      headers: {
        Cookie: authHeader(u.sessionToken).Cookie,
        Origin: "https://app.oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "open" }),
    }));
    expect(res.status).toBe(200);
  });

  it("DELETE /api/publish/:token works on the app host", async () => {
    const u = await seedUser();
    const pub = await seedActivePublication({ ownerId: u.id });
    const res = await call(new Request(`https://app.oyster.to/api/publish/${pub.shareToken}`, {
      method: "DELETE",
      headers: {
        Cookie: authHeader(u.sessionToken).Cookie,
        Origin: "https://app.oyster.to",
      },
    }));
    expect(res.status).toBe(200);
  });

  it("access-redirect on the app host does NOT 308 away (falls through to the handler)", async () => {
    const res = await call(new Request("https://app.oyster.to/api/publish/access-redirect/sometoken"));
    // www/share hosts 308 to the apex here; the app host must fall through
    // to handleAccessRedirect (which 404s/redirects per its own logic for
    // an unknown token — anything but the host-308 is correct).
    expect(res.status).not.toBe(308);
  });
});
```

(Adjust seeding-helper names/shapes after Step 1 if they differ — e.g. `seedActivePublication` return shape. Assert shapes the existing tests already assert; do not invent new response fields.)

- [ ] **Step 3: Run**

```bash
cd infra/oyster-publish && npx vitest run test/app-host.test.ts
```

Expected: PASS (these document existing behaviour — if one FAILS, that's a real host-assumption bug: stop and report rather than changing the test).

- [ ] **Step 4: Commit**

```bash
git add infra/oyster-publish/test/app-host.test.ts
git commit -m "test(publish): prove handlers are host-agnostic on app.oyster.to"
```

---

### Task 9: SPA flattening (web/)

**Files:**
- Modify: `web/vite.config.ts:33`
- Modify: `web/src/caps.ts`
- Modify: `web/src/components/AuthBadge.tsx:202-223`
- Modify: `web/src/data/cloud-publications.ts`, `web/src/data/cloud-spaces.ts` (comments only)

There is no web test runner. Verification: tsc + lint baseline + both builds.

- [ ] **Step 1: Capture the lint baseline**

```bash
cd web && npm run lint 2>&1 | tail -3
```

Note the error/warning count — it must not grow.

- [ ] **Step 2: vite.config.ts**

Change line 33 from:

```ts
  base: process.env.VITE_OYSTER_MODE === "cloud" ? "/app/" : "/",
```

to:

```ts
  // Cloud serves from the app.oyster.to root since spec
  // 2026-06-05-app-oyster-to-migration — both builds use base "/".
  base: "/",
```

(Leave the `outDir` ternary on line 35 untouched.)

- [ ] **Step 3: caps.ts**

Replace the `apiBase`/`routeBase` entries (and the file-header reference to oyster.to/app):

```ts
  /** Prefix for API calls. Cloud lives at the app.oyster.to root since
   *  spec 2026-06-05-app-oyster-to-migration, so both modes are "". The
   *  indirection stays — call sites keep using apiPath(). */
  apiBase: "",
  /** Prefix for client routes (history.pushState / URL parsing). */
  routeBase: "",
```

In the header comment (lines 3–5), change "served by the oyster-cloud worker at oyster.to/app" to "served by the oyster-cloud worker at app.oyster.to".

- [ ] **Step 4: AuthBadge.tsx**

In `handleSignOut` (cloud branch), update the comment and the redirect:

```ts
    if (caps.cloud) {
      // Cloud signs out against the oyster-cloud worker (same origin —
      // app.oyster.to). It revokes the shared session row (apex included)
      // and clears the host-only cookie. Then we reload "/", which the
      // worker redirects into the apex handoff → sign-in.
      try {
        const res = await fetch("/auth/sign-out", { method: "POST" });
        if (!res.ok) {
          setSignOutError("Sign-out failed. Try again.");
          console.error("[auth] sign-out returned", res.status);
          return;
        }
      } catch (err) {
        setSignOutError("Sign-out failed. Try again.");
        console.error("[auth] sign-out failed:", err);
        return;
      }
      window.location.href = "/";
      return;
    }
```

(Only the comment and `window.location.href = "/"` change; the fetch URL `/auth/sign-out` is already correct.)

- [ ] **Step 5: Comment updates in the cloud adapters**

- `web/src/data/cloud-spaces.ts` (~line 42): change the `// NOT behind the /app/api rewrite — call it directly (no apiPath).` comment to `// Served by oyster-publish via the worker's service-binding proxy on app.oyster.to — call it directly (no apiPath).`
- `web/src/data/cloud-publications.ts`: find the equivalent "apex, NOT apiPath-wrapped" comment(s) on its publish fetches and update the wording the same way. No URL changes anywhere.

- [ ] **Step 6: Verify**

```bash
cd web && npx tsc -b && npm run lint 2>&1 | tail -3
cd .. && npm run build && npm run build:cloud
```

Expected: tsc clean, lint count unchanged from Step 1, both builds succeed. Spot-check `web/dist-cloud/index.html` references assets as `/assets/...` (root-absolute, no `/app/` prefix):

```bash
grep -o 'src="[^"]*"' web/dist-cloud/index.html
```

- [ ] **Step 7: Commit**

```bash
git add web/vite.config.ts web/src/caps.ts web/src/components/AuthBadge.tsx web/src/data/cloud-spaces.ts web/src/data/cloud-publications.ts
git commit -m "feat(web): cloud build serves from app.oyster.to root (base /, empty apiBase/routeBase)"
```

---

### Task 10: Full verification sweep

No new code. Run everything; fix nothing silently — report any failure.

- [ ] **Step 1: All three worker suites**

```bash
cd infra/auth-worker && npx vitest run
cd ../oyster-cloud && npx vitest run
cd ../oyster-publish && npx vitest run
```

Expected: ALL PASS in all three.

- [ ] **Step 2: Web checks**

```bash
cd ../../web && npx tsc -b && npm run lint 2>&1 | tail -3
cd .. && npm run build && npm run build:cloud
```

Expected: clean / baseline / both builds green.

- [ ] **Step 3: Grep for leftovers**

```bash
grep -rn "oyster.to/app" web/src infra/oyster-cloud/src --include="*.ts" --include="*.tsx" | grep -v "app.oyster.to" | grep -v "308\|Legacy\|legacy"
```

Expected: no functional references to the old URL remain (comment-only mentions of the legacy redirect are fine).

- [ ] **Step 4: Commit (only if anything changed)**

```bash
git status --short
```

If clean, nothing to commit.

---

### Task 11: Cutover (MAIN SESSION ONLY — not a subagent)

Pre-conditions: PR merged to main, working from the main checkout. Deploys are manual; the permission classifier flags subagent deploys, so this task runs in the main session with the user present.

- [ ] **Step 1: Apply migration 0013 to production D1**

```bash
cd infra/auth-worker && npx wrangler d1 migrations apply oyster-auth --remote
```

Expected: `0013_app_handoff_codes.sql` applied (earlier migrations already recorded).

- [ ] **Step 2: Deploy auth-worker**

```bash
cd infra/auth-worker && npx wrangler deploy
```

(Handoff endpoint goes live; inert until something links to it.)

- [ ] **Step 3: Deploy oyster-publish**

```bash
cd ../oyster-publish && npx wrangler deploy
```

(Origin allowlist; inert.)

- [ ] **Step 4: Build the cloud SPA with the new base**

```bash
cd ../.. && npm run build:cloud
```

- [ ] **Step 5: Deploy oyster-cloud**

```bash
cd infra/oyster-cloud && npx wrangler deploy
```

First deploy with `custom_domain = true` provisions DNS + cert for app.oyster.to. `/app` flips to 308s in the same deploy.

- [ ] **Step 6: Remote smoke test (spec §7 step 6)**

```bash
curl -sI https://app.oyster.to/ | head -3            # expect 302 → oyster.to/auth/app-handoff
curl -sI https://oyster.to/app | head -3              # expect 308 → https://app.oyster.to/
curl -sI https://oyster.to/application | head -3      # expect NOT 308
# Authenticated pass — read the token from ~/Oyster/config/auth.json (NEVER print it):
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/Oyster/config/auth.json','utf8')).token)")
curl -s -b "oyster_session=$TOKEN" https://app.oyster.to/api/me | head -c 200          # expect {"email":…}
curl -s -b "oyster_session=$TOKEN" https://app.oyster.to/api/publish/mine | head -c 200 # expect {"publications":…} via the service binding
```

(If `auth.json`'s shape differs, inspect its keys with `node -e "console.log(Object.keys(...))"` first — never echo the value.)

- [ ] **Step 7: Browser dogfood**

User: open `https://app.oyster.to` in a signed-in apex browser (silent SSO), then on the phone (likely full sign-in round-trip). Verify sessions list, live tail, publications tab, space pills, sign-out.

---

## Self-review notes

- **Spec coverage:** invariant 1 → Task 4 cookie assertions; invariant 2 → Task 3 (hash, TTL) + Task 4 (atomic burn, concurrency test); invariant 3 → Task 4 sign-out test; invariant 4 → Task 4 retry-page tests; invariant 5 → Task 1; invariant 6 → Tasks 6 (stub asserts forwarded URL/Origin/cookie) + 8 (real worker on app host); invariant 7 → Task 5 matrix incl. `/application` negative. §3 SPA → Task 9. §4 allowlists → Task 7. §5 error table → Tasks 4 (retry page, idempotent sign-out) + 6 (502 proxy_failed). §7 cutover → Task 11.
- **Known judgment calls:** Tasks 7/8 tell the implementer to read the existing fixture helpers and clone shapes rather than trust guessed signatures — those test files' helpers were verified to exist (`seedUser`, `authHeader`, `seedSyncedSpace`, `seedActivePublication`) but their option shapes must be confirmed in-file.
- **Type consistency:** `handleAppCallback(req, env, url)` / `handleAppSignOut(req, env)` / `validateAppReturn(raw)` are used identically in Tasks 4, 6. `Env.PUBLISH: Fetcher` (Task 6 Step 1) matches `env.PUBLISH.fetch` (Step 5) and the vitest stub name (Step 3).

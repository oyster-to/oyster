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
  const sid = m?.[1];
  if (sid) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(Date.now(), sid).run();
  }
  return jsonOk({ ok: true }, 200, { "set-cookie": CLEARED_COOKIE, "cache-control": "no-store" });
}

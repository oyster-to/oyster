// app-shell.ts — serves the cloud remote-view SPA at /app
// (spec 2026-06-05-cloud-remote-view). Hashed assets pass straight through
// to the ASSETS binding (public); navigations (index.html) are auth-gated so
// a signed-out visitor lands on a sign-in prompt rather than an empty SPA.
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";

function page(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oyster</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:2rem auto;max-width:40rem;padding:0 1rem;background:#101014;color:#e8e8ee}a{color:#7c6bff}li{margin:.35rem 0}</style>
</head><body>${body}</body></html>`;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

const SIGN_IN_BODY = `<h1>Oyster</h1><p>Not signed in. <a href="https://oyster.to/auth/sign-in">Sign in</a>, then come back to <a href="/app">/app</a>.</p>`;

/** Serve the cloud SPA: hashed assets pass straight through to the ASSETS
 *  binding; navigations (index.html) require a signed-in user. */
export async function handleAppShell(req: Request, env: Env, url: URL): Promise<Response> {
  const sub = url.pathname.slice("/app".length) || "/";
  // Hashed asset requests (js/css/img) — public, immutable, no auth. The
  // ASSETS binding is keyed without the /app prefix (directory root is
  // dist-cloud), so we strip /app before forwarding.
  if (sub.startsWith("/assets/") || /\.(js|css|svg|png|ico|woff2?)$/.test(sub)) {
    return env.ASSETS.fetch(new Request(new URL(sub, url.origin), req));
  }
  // Everything else is a navigation → auth-gate, then SPA index.
  const user = await resolveSession(req, env);
  if (!user) {
    return new Response(page(SIGN_IN_BODY), { status: 401, headers: HTML_HEADERS });
  }
  // A signed-in FREE user gets the index too; the data APIs will 403. Acceptable v1.
  return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), req));
}

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

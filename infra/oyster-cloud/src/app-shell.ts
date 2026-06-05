// app-shell.ts — throwaway whoami shell for the remote view's backend
// slice (spec 2026-06-05-cloud-remote-view-design.md). Proves the chain
// browser → apex cookie → worker → sessions metadata end-to-end. The UI
// slice (blocked on unified-scope-ux PR1) replaces this with the real
// cloud-mode web build.
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oyster</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:2rem auto;max-width:40rem;padding:0 1rem;background:#101014;color:#e8e8ee}a{color:#7c6bff}li{margin:.35rem 0}</style>
</head><body>${body}</body></html>`;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export async function handleAppShell(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) {
    return new Response(
      page(`<h1>Oyster</h1><p>Not signed in. <a href="https://oyster.to/auth/sign-in">Sign in</a>, then come back to <a href="/app">/app</a>.</p>`),
      { status: 401, headers: HTML_HEADERS },
    );
  }
  return new Response(
    page(`<h1>Oyster</h1>
<p>Signed in as <strong>${esc(user.email)}</strong> (${esc(user.tier)}).</p>
<h2>Sessions</h2><ol id="s"><li>loading…</li></ol>
<script>
fetch("/app/api/sessions/metadata").then(function (r) { return r.json(); }).then(function (d) {
  var ol = document.getElementById("s");
  ol.innerHTML = "";
  var sessions = (d.sessions || []).slice(0, 20);
  if (!sessions.length) { ol.innerHTML = "<li>none synced yet</li>"; return; }
  sessions.forEach(function (s) {
    var li = document.createElement("li"); // textContent — titles are untrusted
    li.textContent = (s.title || s.session_id) + " — " + (s.device_label || s.device_id) + " (" + s.state + ")";
    ol.appendChild(li);
  });
});
</script>`),
    { headers: HTML_HEADERS },
  );
}

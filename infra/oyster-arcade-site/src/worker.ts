// Worker for arcade.oyster.to. Most paths are served from docs/arcade/ via
// the ASSETS binding. /assets/* (Press Start 2P, crt.png, …) is owned by
// the main oyster.to site at docs/assets/ — we proxy those through instead
// of duplicating the files, so docs/assets/ stays the single source of
// truth. Cloudflare's edge caches the responses by the origin's
// Cache-Control headers (GitHub Pages sets long max-age on static files).

// The share-registry handler is plain JS shared with the groovebox app and its
// vitest suite (single source of truth) — wrangler bundles it here, hence the
// allowJs tsconfig flag.
import { handleRegistry } from '../../../docs/arcade/groovebox/registry/handler.js';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EDIT_KEY_SECRET: string;
  WRITE_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

// D1 adapter for the handler's injected db interface. UNIQUE violations are
// surfaced as { code: 'conflict' } so the handler can retry id generation.
function d1Db(d1: D1Database) {
  const T = 'gb_registry_items';
  return {
    async get(id: string) {
      return await d1.prepare(`SELECT * FROM ${T} WHERE id = ?`).bind(id).first();
    },
    async insert(r: Record<string, unknown>) {
      try {
        await d1.prepare(
          `INSERT INTO ${T} (id,kind,schema_version,name,author,payload,remix_of,revision,edit_key_hash,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(r.id, r.kind, r.schema_version, r.name, r.author, r.payload, r.remix_of,
                r.revision, r.edit_key_hash, r.created_at, r.updated_at).run();
      } catch (e) {
        if (String(e).includes('UNIQUE')) {
          const err = new Error('conflict') as Error & { code: string };
          err.code = 'conflict';
          throw err;
        }
        throw e;
      }
    },
    async update(id: string, f: { name: string; author: string; payload: string; revision: number; updated_at: string }) {
      await d1.prepare(`UPDATE ${T} SET name=?, author=?, payload=?, revision=?, updated_at=? WHERE id=?`)
        .bind(f.name, f.author, f.payload, f.revision, f.updated_at, id).run();
    },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ─── Share registry API (all hosts; same-origin from both prod domains) ──
    if (url.pathname === '/api/registry' || url.pathname.startsWith('/api/registry/')) {
      if (req.method === 'POST' || req.method === 'PUT') {
        const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
        const rl = await env.WRITE_LIMIT?.limit({ key: ip });   // binding absent in local dev → skip
        if (rl && !rl.success) {
          return new Response(JSON.stringify({ error: 'rate limited — try again in a minute' }),
            { status: 429, headers: { 'content-type': 'application/json' } });
        }
      }
      return handleRegistry(req, d1Db(env.DB), env.EDIT_KEY_SECRET);
    }

    // ─── Pretty share links: /s/<id>[@rev] → groovebox app with ?s=<id> ───────
    // Redirect (not rewrite): index.html uses all-relative asset refs, so
    // serving the app AT /s/<id> would break them. On groovebox.oyster.to the
    // app lives at /; on arcade.oyster.to and wrangler dev (localhost) it lives
    // at /groovebox/. @rev is reserved syntax, ignored in v1 (never 404s).
    {
      const m = url.pathname.match(/^\/s\/([a-z0-9]{4,16})(?:@\d+)?\/?$/i);
      if (m) {
        const base = url.hostname === 'groovebox.oyster.to' ? '/' : '/groovebox/';
        return Response.redirect(new URL(`${base}?s=${m[1].toLowerCase()}`, req.url).toString(), 302);
      }
    }

    // groovebox.oyster.to serves the groovebox at its root — rewrite every
    // path onto the /groovebox/ subtree of the same ASSETS directory. The
    // groovebox is fully self-contained (all-relative refs), so a bare
    // prefix rewrite is sufficient — no /assets/ proxying needed.
    // Idempotent (pasted arcade.oyster.to/groovebox/... deep links don't
    // double-prefix) and preserves the query string.
    if (url.hostname === 'groovebox.oyster.to') {
      const path = url.pathname === '/groovebox' || url.pathname.startsWith('/groovebox/')
        ? url.pathname
        : '/groovebox' + url.pathname;
      const rewritten = new URL(path + url.search, req.url);
      return env.ASSETS.fetch(new Request(rewritten, req));
    }

    if (url.pathname.startsWith('/assets/')) {
      // Wrap the original Request so the proxy preserves method,
      // headers, and any body — bare `fetch(string)` always issues a
      // GET and drops Range / If-Modified-Since / HEAD semantics that
      // we want to pass through to oyster.to for partial-content and
      // caching to behave correctly.
      return fetch(new Request('https://oyster.to' + url.pathname + url.search, req));
    }

    // Path-based room codes — /invaders/FROG (and /invaders/FROG/)
    // should serve the canonical index.html so the client can read
    // the room code from location.pathname. We rewrite any
    // /invaders/<segment> that doesn't look like a file (no dot) and
    // isn't the bare directory path. Real files (simple-peer.min.js,
    // engine.js, sfx-*.mp3, etc.) flow through to ASSETS.
    if (/^\/invaders\/[^./]+\/?$/.test(url.pathname)) {
      const rewritten = new URL('/invaders/', req.url);
      return env.ASSETS.fetch(new Request(rewritten, req));
    }

    // Back-compat for shared links from the v18 (2P) and v19-v32 (MP)
    // era: 301 anything under /invaders-2p/ or /invaders-mp/ to the
    // same path under /invaders/. Preserves the room code so old QR
    // codes / Messages links still work. Bare paths without a trailing
    // slash also map to /invaders/ so the ASSETS binding can serve the
    // directory index.
    if (url.pathname === '/invaders-2p' || url.pathname.startsWith('/invaders-2p/') ||
        url.pathname === '/invaders-mp' || url.pathname.startsWith('/invaders-mp/')) {
      const prefix = url.pathname.startsWith('/invaders-mp') ? '/invaders-mp' : '/invaders-2p';
      const tail = url.pathname.slice(prefix.length); // '' or '/...'
      const dest = '/invaders' + (tail || '/');
      return Response.redirect(new URL(dest + url.search, req.url).toString(), 301);
    }

    return env.ASSETS.fetch(req);
  },
};

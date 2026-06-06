// Worker for arcade.oyster.to. Most paths are served from docs/arcade/ via
// the ASSETS binding. /assets/* (Press Start 2P, crt.png, …) is owned by
// the main oyster.to site at docs/assets/ — we proxy those through instead
// of duplicating the files, so docs/assets/ stays the single source of
// truth. Cloudflare's edge caches the responses by the origin's
// Cache-Control headers (GitHub Pages sets long max-age on static files).

export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // groovebox.oyster.to serves the groovebox at its root — rewrite every
    // path onto the /groovebox/ subtree of the same ASSETS directory. The
    // groovebox is fully self-contained (all-relative refs), so a bare
    // prefix rewrite is sufficient — no /assets/ proxying needed.
    if (url.hostname === 'groovebox.oyster.to') {
      const rewritten = new URL('/groovebox' + url.pathname, req.url);
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

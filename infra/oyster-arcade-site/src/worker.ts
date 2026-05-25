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

    if (url.pathname.startsWith('/assets/')) {
      // Wrap the original Request so the proxy preserves method,
      // headers, and any body — bare `fetch(string)` always issues a
      // GET and drops Range / If-Modified-Since / HEAD semantics that
      // we want to pass through to oyster.to for partial-content and
      // caching to behave correctly.
      return fetch(new Request('https://oyster.to' + url.pathname + url.search, req));
    }

    // Path-based room codes for the MP spike — /invaders-mp/FROG (and
    // /invaders-mp/FROG/) should serve the canonical index.html so
    // the client can read the room code from location.pathname. We
    // rewrite any /invaders-mp/<segment> that doesn't look like a
    // file (no dot) and isn't the bare directory path. Real files
    // (simple-peer.min.js, engine.js, etc.) flow through to ASSETS.
    if (/^\/invaders-mp\/[^./]+\/?$/.test(url.pathname)) {
      const rewritten = new URL('/invaders-mp/', req.url);
      return env.ASSETS.fetch(new Request(rewritten, req));
    }

    // Back-compat for v18 (2P-only) shared links: 301 anything under
    // /invaders-2p/ to the same path under /invaders-mp/. Preserves
    // the room code so old QR codes / Messages links still work.
    // The bare path `/invaders-2p` (no trailing slash) maps to
    // `/invaders-mp/` so the ASSETS binding can serve the directory
    // index; without the trailing slash it would 404.
    if (url.pathname === '/invaders-2p' || url.pathname.startsWith('/invaders-2p/')) {
      const tail = url.pathname.slice('/invaders-2p'.length); // '' or '/...'
      const dest = '/invaders-mp' + (tail || '/');
      return Response.redirect(new URL(dest + url.search, req.url).toString(), 301);
    }

    // Phase J — MP is now feature-complete (lives, supers, bosses,
    // cutscene, leaderboard) and inherits SP's 'invaders' hi-score
    // table. Redirect the canonical SP entry points to the MP lobby
    // so bookmarks + search results land on the multiplayer build.
    //   /invaders, /invaders/, /invaders/index.html → /invaders-mp/
    // Asset paths under /invaders/ (sfx-shoot.mp3, sfx-kill.wav,
    // anything else with a file extension) are EXEMPT — MP still
    // references them via ../invaders/ so they have to keep serving.
    if (url.pathname === '/invaders' ||
        url.pathname === '/invaders/' ||
        url.pathname === '/invaders/index.html') {
      return Response.redirect(new URL('/invaders-mp/' + url.search, req.url).toString(), 301);
    }

    return env.ASSETS.fetch(req);
  },
};

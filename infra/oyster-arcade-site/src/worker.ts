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

    // Path-based room codes for the 2P spike — /invaders-2p/FROG should
    // serve the canonical index.html so the client can read the room
    // code from location.pathname. We rewrite any /invaders-2p/<segment>
    // that doesn't look like a file (no dot) and isn't the bare
    // directory path. Actual files (simple-peer.min.js, etc.) flow
    // through to the ASSETS binding unchanged.
    if (/^\/invaders-2p\/[^./]+$/.test(url.pathname)) {
      const rewritten = new URL('/invaders-2p/', req.url);
      return env.ASSETS.fetch(new Request(rewritten, req));
    }

    return env.ASSETS.fetch(req);
  },
};

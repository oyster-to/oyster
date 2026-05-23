// Oyster arcade multiplayer worker.
//
// GET  /api/mp/health             → "ok" (route precedence sanity check)
// GET  /api/mp/invaders/ws        → WebSocket upgrade, forwarded to the
//                                   singleton InvadersRoom Durable Object
//
// Anything else 404s. v0 is one game (invaders), one room (singleton),
// no matchmaking, no auth — just the smallest possible proof that two
// devices can play the same session.

export interface Env {
  ROOM: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api/mp/health') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/mp/invaders/ws') {
      // Per-pair rooms keyed by a 4-letter code supplied as ?code=.
      // Each unique code resolves to its own DO instance, so two
      // households opening the URL don't collide. The client generates
      // a code on first visit and updates the URL, so sharing the
      // link with someone on the same Wi-Fi auto-joins the room.
      //
      // No locationHint — diagnostics showed the UAE user's ISP pins
      // all CF traffic through MRS edge, and any non-MRS DO adds a
      // second MRS↔DO hop on top. MRS-placed DO is the ~150 ms floor.
      const raw = url.searchParams.get('code') ?? '';
      const code = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (code.length !== 4) {
        return new Response('missing or invalid ?code= (4 letters A–Z)', { status: 400 });
      }
      const id = env.ROOM.idFromName('room-' + code);
      return env.ROOM.get(id).fetch(req);
    }

    return new Response('not found', { status: 404 });
  },
};

export { InvadersRoom } from './room';

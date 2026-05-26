// Oyster arcade multiplayer worker.
//
// GET  /api/mp/health             → "ok" (route precedence sanity check)
// GET  /api/mp/invaders/ws?code=X → WebSocket upgrade, forwarded to the
//                                   InvadersRoom Durable Object whose
//                                   id is derived from the 4-letter
//                                   room code (one DO per code)
// GET  /api/mp/turn-credentials   → mints short-lived TURN credentials
//                                   from Cloudflare Realtime so peers
//                                   on hostile NAT (hotel APs, cellular)
//                                   have a relay path when STUN-only
//                                   handshakes fail. Returns the JSON
//                                   from CF, or 503 if the TURN_APP_ID
//                                   + TURN_APP_TOKEN secrets aren't set.
//
// Anything else 404s. v0 is one game (invaders), per-pair rooms keyed
// by code, no matchmaking, no auth.
//
// Required secrets for TURN (set via `npx wrangler secret put`):
//   TURN_APP_ID    — Cloudflare Realtime TURN key ID (UUID)
//   TURN_APP_TOKEN — API token with Realtime:Edit scope
// Without these the TURN endpoint 503s and the client falls back to
// STUN-only, which is fine for cone-NAT networks but fails on hotels
// + cellular with symmetric NAT.

export interface Env {
  ROOM: DurableObjectNamespace;
  TURN_APP_ID?: string;
  TURN_APP_TOKEN?: string;
}

// 1-hour TTL on TURN credentials. Long enough that a single fetch
// covers a typical co-op session; short enough that leaked creds
// can't be reused for long. The client caches the result and
// refreshes ~10 min before expiry.
const TURN_CREDENTIAL_TTL_SEC = 3600;

async function handleTurnCredentials(env: Env): Promise<Response> {
  if (!env.TURN_APP_ID || !env.TURN_APP_TOKEN) {
    return new Response(
      JSON.stringify({ error: 'turn_not_configured' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_APP_ID}/credentials/generate`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TURN_APP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SEC }),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'cf_turn_unreachable', detail: (e as Error).message }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return new Response(
      JSON.stringify({ error: 'cf_turn_failed', status: resp.status, body: text }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  // Pass CF's response through verbatim — it includes the iceServers
  // object the client splices straight into its WebRTC config.
  // Cache at the edge briefly so a flurry of joiners doesn't fan
  // out one CF API call per client (creds are still per-session
  // distinct, just on the same TTL window).
  const body = await resp.text();
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, max-age=60',
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api/mp/health') {
      return new Response('ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/api/mp/turn-credentials') {
      return handleTurnCredentials(env);
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

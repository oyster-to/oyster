// ─── Share-registry HTTP handler (pure; db + secret injected) ────────────────
// Worker glue (infra/oyster-arcade-site/src/worker.ts) supplies the D1 adapter,
// the HMAC secret, and rate limiting. This file is testable in plain node.
// db interface: get(id)→row|null, insert(row) [throws {code:'conflict'} on dup id],
//               update(id, fields).

import { validateCreate, validateUpdate } from './validate.js';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function makeId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => ID_ALPHABET[x % 36]).join('');   // tiny modulo bias is fine: ids are not secrets
}

export function makeEditKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function hmacHex(secret, value) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare (XOR-fold). Both inputs are HMAC hex digests of
// fixed length, which is what makes this equivalent to timingSafeEqual.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

async function readJson(req) {
  try { return await req.json(); } catch { return undefined; }
}

async function create(req, db, secret) {
  const body = await readJson(req);
  if (body === undefined) return json(400, { error: 'invalid JSON' });
  const v = validateCreate(body);
  if (!v.ok) return json(400, { error: v.error });
  if (body.remix_of !== undefined && !(await db.get(body.remix_of))) return json(400, { error: 'remix_of not found' });

  const editKey = makeEditKey();
  const now = new Date().toISOString();
  const row = {
    kind: body.kind, schema_version: body.schema_version,
    name: body.name, author: body.author ?? '',
    payload: JSON.stringify(body.payload),
    remix_of: body.remix_of ?? null, revision: 1,
    edit_key_hash: await hmacHex(secret, editKey),
    created_at: now, updated_at: now,
  };
  for (let attempt = 0; attempt < 5; attempt++) {       // server-side ids; regenerate on collision
    const id = makeId();
    try { await db.insert({ id, ...row }); return json(201, { id, editKey }); }
    catch (e) { if (e.code !== 'conflict') throw e; }
  }
  return json(503, { error: 'could not allocate id' });
}

async function get(id, db) {
  const row = await db.get(id);
  if (!row) return json(404, { error: 'not found' });
  const { edit_key_hash, ...pub } = row;                // NEVER returned
  return json(200, { ...pub, payload: JSON.parse(row.payload) });
}

async function update(id, req, db, secret) {
  const row = await db.get(id);
  if (!row) return json(404, { error: 'not found' });
  const body = await readJson(req);
  if (body === undefined) return json(400, { error: 'invalid JSON' });
  const v = validateUpdate(body, row.kind, row.schema_version);   // same gate as POST
  if (!v.ok) return json(400, { error: v.error });
  const hash = await hmacHex(secret, body.editKey);
  if (!constantTimeEqual(hash, row.edit_key_hash)) return json(403, { error: 'forbidden' });
  const revision = row.revision + 1;
  await db.update(id, {
    name: body.name, author: body.author ?? '',
    payload: JSON.stringify(body.payload),
    revision, updated_at: new Date().toISOString(),     // server timestamps only
  });
  return json(200, { revision });
}

// POST /:id/play — anonymous play beacon. Fire-and-forget from the app; counts
// are approximate by design (self-plays and reloads count; stakes are low).
async function play(id, db) {
  const row = await db.get(id);
  if (!row) return json(404, { error: 'not found' });
  await db.bumpPlays(id);
  return new Response(null, { status: 204 });
}

// GET /api/registry?kind=song&limit=25 — the discovery shelf. Light rows only
// (no payload, no edit_key_hash), newest first.
async function list(url, db) {
  const kind = url.searchParams.get('kind') ?? 'song';
  if (kind !== 'song' && kind !== 'groove') return json(400, { error: 'bad kind' });
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25));
  const rows = await db.list(kind, limit);
  return json(200, {
    items: rows.map(({ id, kind: k, name, author, plays, remix_of, created_at }) =>
      ({ id, kind: k, name, author, plays, remix_of, created_at })),
  });
}

export async function handleRegistry(req, db, secret) {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/api\/registry(?:\/([a-z0-9]{8})(\/play)?)?$/);
  if (!m) return json(404, { error: 'not found' });
  const id = m[1], isPlay = !!m[2];
  try {
    if (req.method === 'POST' && id && isPlay) return await play(id, db);
    if (req.method === 'POST' && !id) return await create(req, db, secret);
    if (req.method === 'GET' && !id) return await list(url, db);
    if (req.method === 'GET' && id && !isPlay) return await get(id, db);
    if (req.method === 'PUT' && id && !isPlay) return await update(id, req, db, secret);
  } catch {
    return json(500, { error: 'internal error' });
  }
  return json(405, { error: 'method not allowed' });
}

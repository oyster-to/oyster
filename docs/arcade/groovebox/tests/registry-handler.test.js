import { describe, it, expect, beforeEach } from 'vitest';
import { handleRegistry, makeId, makeEditKey } from '../registry/handler.js';
import { GROOVE_PAYLOAD, SONG_PAYLOAD } from './helpers/registry-fixtures.js';

const SECRET = 'test-secret';

// In-memory db implementing the injected interface. insert throws
// { code: 'conflict' } on duplicate id — mirrors the D1 adapter contract.
function memDb(rows = {}) {
  return {
    rows,
    async get(id) { return rows[id] ?? null; },
    async insert(row) {
      if (rows[row.id]) { const e = new Error('UNIQUE'); e.code = 'conflict'; throw e; }
      rows[row.id] = { ...row };
    },
    async update(id, fields) { Object.assign(rows[id], fields); },
    async bumpPlays(id) { rows[id].plays = (rows[id].plays ?? 0) + 1; },
    async list(kind, limit) {
      return Object.values(rows)
        .filter(r => r.kind === kind)
        // newest first, id tie-break — mirrors the D1 adapter's ORDER BY
        .sort((a, b) => (a.created_at !== b.created_at
          ? (a.created_at < b.created_at ? 1 : -1)
          : (a.id < b.id ? -1 : 1)))
        .slice(0, limit);
    },
  };
}

const post = (body) => new Request('https://groovebox.oyster.to/api/registry', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
const CREATE = (over = {}) => ({ kind: 'groove', schema_version: 1, name: 'amen-ish', author: 'Henry', payload: GROOVE_PAYLOAD, ...over });

describe('id + key generation', () => {
  it('makeId: 8 chars lowercase alnum', () => expect(makeId()).toMatch(/^[a-z0-9]{8}$/));
  it('makeEditKey: long base64url, high entropy', () => {
    const k = makeEditKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(makeEditKey()).not.toBe(k);
  });
});

describe('POST /api/registry', () => {
  let db; beforeEach(() => { db = memDb(); });

  it('creates: 201 { id, editKey }; row stored with hash, never raw key', async () => {
    const res = await handleRegistry(post(CREATE()), db, SECRET);
    expect(res.status).toBe(201);
    const { id, editKey } = await res.json();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    const row = db.rows[id];
    expect(row.kind).toBe('groove');
    expect(row.revision).toBe(1);
    expect(row.edit_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.edit_key_hash).not.toBe(editKey);
    expect(JSON.stringify(row)).not.toContain(editKey);
    expect(typeof row.payload).toBe('string');          // stored serialized
    expect(row.created_at).toBe(row.updated_at);
  });

  it('400 on invalid body, with the validator message', async () => {
    const res = await handleRegistry(post(CREATE({ kind: 'sample' })), db, SECRET);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('400 on malformed JSON', async () => {
    const res = await handleRegistry(new Request('https://x/api/registry', { method: 'POST', body: '{nope' }), db, SECRET);
    expect(res.status).toBe(400);
  });

  it('remix_of must reference an existing item', async () => {
    expect((await handleRegistry(post(CREATE({ remix_of: 'aaaaaaaa' })), db, SECRET)).status).toBe(400);
    const first = await (await handleRegistry(post(CREATE()), db, SECRET)).json();
    const res = await handleRegistry(post(CREATE({ remix_of: first.id })), db, SECRET);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(db.rows[id].remix_of).toBe(first.id);
  });

  it('retries on id collision up to 5 times, then 503', async () => {
    let calls = 0;
    db.insert = async () => { calls++; const e = new Error('UNIQUE'); e.code = 'conflict'; throw e; };
    const res = await handleRegistry(post(CREATE()), db, SECRET);
    expect(calls).toBe(5);
    expect(res.status).toBe(503);
  });

  it('non-conflict insert errors surface as 500, no retry', async () => {
    let calls = 0;
    db.insert = async () => { calls++; throw new Error('D1 exploded'); };
    const res = await handleRegistry(post(CREATE()), db, SECRET);
    expect(calls).toBe(1);
    expect(res.status).toBe(500);
  });

  it('405 on unknown method/path combos; 404 on bad path', async () => {
    expect((await handleRegistry(new Request('https://x/api/registry', { method: 'DELETE' }), db, SECRET)).status).toBe(405);
    expect((await handleRegistry(new Request('https://x/api/other', { method: 'GET' }), db, SECRET)).status).toBe(404);
  });
});

describe('GET /api/registry/:id', () => {
  it('returns full record, payload parsed, edit_key_hash absent', async () => {
    const db = memDb();
    const { id } = await (await handleRegistry(post(CREATE()), db, SECRET)).json();
    const res = await handleRegistry(new Request(`https://x/api/registry/${id}`), db, SECRET);
    expect(res.status).toBe(200);
    const rec = await res.json();
    expect(rec.id).toBe(id);
    expect(rec.payload).toEqual(GROOVE_PAYLOAD);              // parsed JSON, not a string
    expect(rec.edit_key_hash).toBeUndefined();
    expect(rec).toMatchObject({ kind: 'groove', schema_version: 1, name: 'amen-ish', author: 'Henry', remix_of: null, revision: 1 });
    expect(rec.created_at).toBeTruthy(); expect(rec.updated_at).toBeTruthy();
  });
  it('404 on unknown id', async () => {
    expect((await handleRegistry(new Request('https://x/api/registry/zzzzzzzz'), memDb(), SECRET)).status).toBe(404);
  });
});

describe('PUT /api/registry/:id', () => {
  const put = (id, body) => new Request(`https://x/api/registry/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  let db, id, editKey;
  beforeEach(async () => {
    db = memDb();
    ({ id, editKey } = await (await handleRegistry(post(CREATE()), db, SECRET)).json());
  });

  it('owner update: 200 { revision: 2 }, fields updated, identity untouched', async () => {
    const newPayload = { ...GROOVE_PAYLOAD, bpm: 140 };
    const res = await handleRegistry(put(id, { editKey, name: 'amen-2', author: 'H', payload: newPayload }), db, SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 2 });
    const row = db.rows[id];
    expect(row.name).toBe('amen-2');
    expect(JSON.parse(row.payload).bpm).toBe(140);
    expect(row.kind).toBe('groove');                       // identity fields unchanged
    expect(row.created_at).toBeTruthy();
  });

  it('second update → revision 3', async () => {
    const body = { editKey, name: 'n', author: '', payload: GROOVE_PAYLOAD };
    await handleRegistry(put(id, body), db, SECRET);
    const res = await handleRegistry(put(id, body), db, SECRET);
    expect(await res.json()).toEqual({ revision: 3 });
  });

  it('403 on wrong editKey; row untouched', async () => {
    const res = await handleRegistry(put(id, { editKey: 'x'.repeat(43), name: 'evil', author: '', payload: GROOVE_PAYLOAD }), db, SECRET);
    expect(res.status).toBe(403);
    expect(db.rows[id].name).toBe('amen-ish');
    expect(db.rows[id].revision).toBe(1);
  });

  it('400 when body smuggles identity fields', async () => {
    const res = await handleRegistry(put(id, { editKey, name: 'n', author: '', payload: GROOVE_PAYLOAD, kind: 'song' }), db, SECRET);
    expect(res.status).toBe(400);
  });

  it('PUT payload passes the same validation gate as POST', async () => {
    const res = await handleRegistry(put(id, { editKey, name: 'n', author: '', payload: { laneType: 'vocals' } }), db, SECRET);
    expect(res.status).toBe(400);
  });

  it('PUT payload is validated against the ROW kind (groove row rejects song payload)', async () => {
    const res = await handleRegistry(put(id, { editKey, name: 'n', author: '', payload: SONG_PAYLOAD }), db, SECRET);
    expect(res.status).toBe(400);
  });

  it('404 on unknown id (before any key check)', async () => {
    expect((await handleRegistry(put('zzzzzzzz', { editKey, name: 'n', author: '', payload: GROOVE_PAYLOAD }), db, SECRET)).status).toBe(404);
  });
});

describe('POST /api/registry/:id/play', () => {
  const playReq = (id) => new Request(`https://x/api/registry/${id}/play`, { method: 'POST' });
  let db, id;
  beforeEach(async () => {
    db = memDb();
    ({ id } = await (await handleRegistry(post(CREATE()), db, SECRET)).json());
  });

  it('204, increments plays', async () => {
    expect((await handleRegistry(playReq(id), db, SECRET)).status).toBe(204);
    expect((await handleRegistry(playReq(id), db, SECRET)).status).toBe(204);
    expect(db.rows[id].plays).toBe(2);
  });

  it('404 on unknown id; non-POST methods rejected', async () => {
    expect((await handleRegistry(playReq('zzzzzzzz'), db, SECRET)).status).toBe(404);
    expect((await handleRegistry(new Request(`https://x/api/registry/${id}/play`), db, SECRET)).status).toBe(405);
    expect((await handleRegistry(new Request(`https://x/api/registry/${id}/play`, { method: 'PUT', body: '{}' }), db, SECRET)).status).toBe(405);
  });

  it('plays survives owner updates and cannot be set via PUT body', async () => {
    await handleRegistry(playReq(id), db, SECRET);
    // PUT with plays in body → 400 (strict keys protect the counter)
    const res = await handleRegistry(new Request(`https://x/api/registry/${id}`, {
      method: 'PUT', body: JSON.stringify({ editKey: 'k'.repeat(43), name: 'n', author: '', payload: GROOVE_PAYLOAD, plays: 9000 }),
    }), db, SECRET);
    expect(res.status).toBe(400);
    expect(db.rows[id].plays).toBe(1);
  });
});

describe('GET /api/registry (list — the discovery shelf)', () => {
  let db; beforeEach(() => { db = memDb(); });
  const listReq = (qs = '') => new Request(`https://groovebox.oyster.to/api/registry${qs}`);

  async function seed(kind, name, plays = 0) {
    const res = await handleRegistry(post(CREATE({
      kind, name,
      schema_version: kind === 'song' ? 2 : 1,
      payload: kind === 'song' ? SONG_PAYLOAD : GROOVE_PAYLOAD,
    })), db, SECRET);
    expect(res.status).toBe(201);
    const { id } = await res.json();
    db.rows[id].plays = plays;
    return id;
  }

  it('returns light song rows — no payload, no edit_key_hash', async () => {
    await seed('song', 'Cool Song', 7);
    await seed('groove', 'Some Groove');
    const res = await handleRegistry(listReq('?kind=song'), db, SECRET);
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Cool Song');
    expect(items[0].plays).toBe(7);
    expect(items[0].author).toBe('Henry');
    expect(items[0]).not.toHaveProperty('payload');
    expect(items[0]).not.toHaveProperty('edit_key_hash');
  });

  it('defaults to kind=song; bad kind → 400; limit clamps to 50', async () => {
    await seed('song', 'A');
    const def = await handleRegistry(listReq(''), db, SECRET);
    expect((await def.json()).items).toHaveLength(1);
    const bad = await handleRegistry(listReq('?kind=banana'), db, SECRET);
    expect(bad.status).toBe(400);
    const big = await handleRegistry(listReq('?limit=999'), db, SECRET);
    expect(big.status).toBe(200);   // clamp is the db arg; just must not error
  });

  it('grooves listable too', async () => {
    await seed('groove', 'G1');
    const res = await handleRegistry(listReq('?kind=groove'), db, SECRET);
    expect((await res.json()).items.map(i => i.name)).toEqual(['G1']);
  });
});

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

// ─── Browser client for the share registry ───────────────────────────────────
// Pure helpers (parse, storage) are unit-tested; fetch wrappers are exercised
// against wrangler dev + the live deploy.

export const API_BASE = '/api/registry';
export const CANONICAL_ORIGIN = 'https://groovebox.oyster.to';

// Canonical host for links — except in local dev (wrangler dev / vite), where a
// canonical link would 404 until deployed; there the local origin is the truth.
export function shareUrl(id) {
  const local = typeof location !== 'undefined' && /^(localhost|127\.)/.test(location.hostname);
  return `${local ? location.origin : CANONICAL_ORIGIN}/s/${id}`;
}

// /s/<id> redirects here as /?s=<id>; @revision is reserved syntax, ignored in v1.
export function parseShareParam(search) {
  const raw = new URLSearchParams(search).get('s');
  if (!raw) return null;
  const m = raw.match(/^([a-z0-9]{8})(?:@\d+)?$/i);
  return m ? m[1].toLowerCase() : null;
}

// localStorage access mirrors app.js convention: try/catch, degrade silently.
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
// Map values are { key, name, kind, at } — or a bare key string from the
// earliest builds (tolerated on read).
export function getEditKey(id) {
  const v = readJSON('gb-registry-edit-keys', {})[id];
  return v ? (typeof v === 'string' ? v : v.key) : null;
}
export function storeEditKey(id, key, meta = {}) {
  try {
    const map = readJSON('gb-registry-edit-keys', {});
    const prev = typeof map[id] === 'object' ? map[id] : {};
    map[id] = { ...prev, key, ...meta, at: Date.now() };
    localStorage.setItem('gb-registry-edit-keys', JSON.stringify(map));
  } catch {}
}
// Your private publish history (newest first) — local to this browser, NOT a
// discovery surface. Bare-string legacy entries surface as unnamed items.
export function listMine() {
  const map = readJSON('gb-registry-edit-keys', {});
  return Object.entries(map)
    .map(([id, v]) => typeof v === 'string' ? { id, name: id, kind: '', at: 0 } : { id, name: v.name || id, kind: v.kind || '', at: v.at || 0 })
    .sort((a, b) => b.at - a.at);
}
export function getAuthor() { try { return localStorage.getItem('gb-registry-author') || ''; } catch { return ''; } }
export function setAuthor(name) { try { localStorage.setItem('gb-registry-author', name); } catch {} }

async function call(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
export const createItem = (body) => call('POST', '', body);            // → { id, editKey }
export const getItem = (id) => call('GET', `/${id}`);                  // → record
export const updateItem = (id, body) => call('PUT', `/${id}`, body);   // → { revision }
// Discovery shelf — light rows (id/kind/name/author/plays/remix_of/created_at), newest first.
export const listItems = (kind = 'song', limit = 25) => call('GET', `?kind=${kind}&limit=${limit}`);
// Fire-and-forget play beacon — never blocks or breaks the load path.
export const pingPlay = (id) => { fetch(`${API_BASE}/${id}/play`, { method: 'POST' }).catch(() => {}); };

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
export function getEditKey(id) { return readJSON('gb-registry-edit-keys', {})[id] ?? null; }
export function storeEditKey(id, key) {
  try {
    const map = readJSON('gb-registry-edit-keys', {});
    map[id] = key;
    localStorage.setItem('gb-registry-edit-keys', JSON.stringify(map));
  } catch {}
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

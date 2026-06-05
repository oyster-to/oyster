// transcript-events.ts — rendered-transcript read path for the remote view
// (spec docs/superpowers/specs/2026-06-05-cloud-remote-view-design.md).
// Contract mirrors the local server's GET /api/sessions/:id/events
// (server/src/routes/sessions.ts) with one substitution: event ids are
// plaintext byte offsets of each JSONL line start — monotonic, stable,
// derivable without a DB, so before/after cursors work identically.
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";
import { jsonError } from "./json.js";
import { decryptChunk, type ChunkAad } from "./encryption.js";
import { renderEvent, safeParse, isClaudeProtocolArtifact } from "../../../shared/claude-transcript.js";

// Mirror server ingest truncation (watchers/claude-code.ts TEXT_PREVIEW_MAX).
const TEXT_PREVIEW_MAX = 280;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
// CPU/memory guard: decrypt at most this many chunks per request. Typical
// delta chunks are KBs; only initial-backfill chunks approach 25 MB. A
// request that exhausts the cap returns fewer events than `limit` — the
// client pages again with before=<smallest id>.
const MAX_CHUNKS = 4;

interface ChunkRow {
  chunk_number: number;
  start_offset: number;
  end_offset: number;
  plaintext_sha256: string;
}

export async function handleSessionEventsGet(req: Request, env: Env, sessionId: string): Promise<Response> {
  // (a) Auth + tier gate + metadata row
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");

  const meta = await env.DB.prepare(
    `SELECT bytes_generation, cwd FROM synced_session_metadata
      WHERE owner_id = ? AND session_id = ? LIMIT 1`,
  ).bind(user.id, sessionId).first<{ bytes_generation: number; cwd: string | null }>();
  if (!meta) return jsonError(404, "session_not_found");
  const generation = meta.bytes_generation;
  const cwd = meta.cwd;

  // (b) Chunk rows
  const rows = await env.DB.prepare(
    `SELECT chunk_number, start_offset, end_offset, plaintext_sha256
       FROM synced_session_chunks
      WHERE owner_id = ? AND session_id = ? AND bytes_generation = ?
      ORDER BY chunk_number ASC`,
  ).bind(user.id, sessionId, generation).all<ChunkRow>();
  const chunks = rows.results ?? [];
  if (chunks.length === 0) {
    return Response.json([], { headers: { "cache-control": "private, no-store" } });
  }

  // (c) Params
  const url = new URL(req.url);
  const num = (name: string): number | null => {
    const v = url.searchParams.get(name);
    return v !== null && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const limitRaw = num("limit");
  const limit = limitRaw !== null ? Math.max(1, Math.min(MAX_LIMIT, limitRaw)) : DEFAULT_LIMIT;
  const before = num("before");
  const after = num("after");

  // (d) Chunk window (forward from cursor for `after` = live tail;
  //     backward from end or `before` otherwise)
  let selected: ChunkRow[];
  if (after !== null) {
    selected = chunks.filter((c) => c.end_offset > after).slice(0, MAX_CHUNKS);
  } else if (before !== null) {
    selected = chunks.filter((c) => c.start_offset < before).slice(-MAX_CHUNKS);
  } else {
    selected = chunks.slice(-MAX_CHUNKS);
  }
  if (selected.length === 0) {
    return Response.json([], { headers: { "cache-control": "private, no-store" } });
  }

  // (e) Decrypt the window — R2 key + AAD reconstruction copied from
  //     handleSessionsBytesChunkGet. D1 row state is the AAD source of truth,
  //     never R2 customMetadata.
  const parts: Uint8Array[] = [];
  for (const row of selected) {
    const key = `sessions/${user.id}/${sessionId}/g${generation}/chunk-${row.chunk_number}.bin`;
    const obj = await env.SESSIONS_BUCKET.get(key);
    if (!obj) return jsonError(404, "chunk_bytes_missing");
    const ciphertext = new Uint8Array(await obj.arrayBuffer());
    const aad: ChunkAad = {
      owner_id: user.id,
      session_id: sessionId,
      bytes_generation: generation,
      chunk_number: row.chunk_number,
      start_offset: row.start_offset,
      end_offset: row.end_offset,
      plaintext_sha256: row.plaintext_sha256,
    };
    try {
      parts.push(await decryptChunk(env.SESSIONS_ENCRYPTION_KEY, aad, ciphertext));
    } catch (err) {
      console.warn("[sessions] decryptChunk failed:", err);
      return jsonError(500, "decrypt_failed");
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  {
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
  }
  const baseOffset = selected[0]!.start_offset;

  // (f) Split on \n tracking absolute BYTE offsets. Chunk starts are
  //     newline-aligned by the uploader except the >25 MB single-line
  //     pathological case; a mid-line fragment fails safeParse and is
  //     skipped — the same tolerance local ingest has. Trailing bytes with
  //     no terminating \n are a partial write: skipped, matching the
  //     watcher's partial-line buffering.
  const decoder = new TextDecoder();
  type WireEvent = { id: number; sessionId: string; role: string; text: string; ts: string | null; raw: null };
  const events: WireEvent[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    if (i > lineStart) {
      const line = decoder.decode(buf.subarray(lineStart, i));
      const ev = safeParse(line);
      // Mirror local ingest exactly (watchers/claude-code.ts ingest loop):
      // render → truncate to preview budget → drop protocol artifacts.
      // NOTE: `home` is deliberately omitted — the worker doesn't know the
      // device's home directory, so paths render absolute (acceptable parity
      // divergence for the remote view; documented here).
      const rendered = ev ? renderEvent(ev, cwd) : null;
      if (rendered) {
        const text = rendered.text.slice(0, TEXT_PREVIEW_MAX);
        if (!isClaudeProtocolArtifact(text)) {
          events.push({
            id: baseOffset + lineStart,
            sessionId,
            role: rendered.role,
            text,
            ts: typeof ev!.timestamp === "string" ? ev!.timestamp : null,
            raw: null,
          });
        }
      }
    }
    lineStart = i + 1;
  }

  // (g) Window + respond
  let out = events;
  if (after !== null) out = out.filter((e) => e.id > after).slice(0, limit);
  else if (before !== null) out = out.filter((e) => e.id < before).slice(-limit);
  else out = out.slice(-limit);

  return Response.json(out, { headers: { "cache-control": "private, no-store" } });
}

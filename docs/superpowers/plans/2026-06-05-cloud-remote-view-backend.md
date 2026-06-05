# Cloud Remote View — Backend Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in browser at `https://oyster.to/app` can list synced sessions and fetch rendered transcript events from the cloud worker — proving the full chain (cookie → worker → R2 decrypt → shared parser) end-to-end, with the same-site CSRF gap closed.

**Architecture:** Extract the JSONL→event transform from the local watcher into top-level `shared/` (pattern already established by `shared/types.ts`); add a `GET /api/sessions/:id/events` route to the oyster-cloud worker that decrypts R2 chunks and parses them with byte-offset event ids; add Origin checks to all `/api/*` mutating routes on oyster-cloud and oyster-publish; route `oyster.to/app*` to the oyster-cloud worker with a throwaway whoami shell. **No auth-worker changes** — the host-only apex cookie (#397) authenticates `/app` because it lives on the apex.

**Tech Stack:** TypeScript. Server: vitest (`server/test/`). Worker: vitest + `@cloudflare/vitest-pool-workers` (`infra/oyster-cloud/test/`). Deploys are manual `wrangler deploy` (no CI).

**Spec:** `docs/superpowers/specs/2026-06-05-cloud-remote-view-design.md`

**Branch / worktree:** `cloud-remote-view`, worktree at `~/Dev/oyster.worktrees/cloud-remote-view` (exists; holds the spec). Copy `.env` in and `npm install` in `server/` if running anything locally.

**Scope guard:** Backend only. No `web/` changes (blocked on unified-scope-ux PR1). No changelog entry (no consumer-visible change). The `/app` HTML shell in Task 4 is throwaway scaffolding the UI slice replaces.

**Key facts** (verified against code, don't re-derive):
- Cloud bytes are **Claude Code JSONL only** — only the claude-code watcher sets `jsonl_path`; OpenCode sessions sync metadata-only. The parser handles one format.
- Local ingest (`server/src/watchers/claude-code.ts:468-478`): `renderEvent(ev, cwd)` → truncate text to 280 → `ts = ev.timestamp` if string → `is_protocol_artifact = isClaudeProtocolArtifact(text)`. Local read APIs exclude protocol artifacts.
- Local events API contract (`server/src/routes/sessions.ts:599-661`): `?before=<id>` (id < before, latest N), `?after=<id>` (id > after, oldest N), neither = latest N, `?limit` default 1000 cap 10 000. Response: array of `{id, sessionId, role, text, ts, raw: null}`. The cloud endpoint matches this contract with **id = plaintext byte offset of the JSONL line start** (monotonic integer, so cursors work identically).
- Chunk uploads split at newline boundaries (`chooseChunkSize`, session-sync-service.ts) except the pathological >25 MB single-line case — a mid-line chunk start produces one unparseable fragment that `safeParse` drops, same tolerance as local ingest.
- `oyster_session` cookie is deliberately host-only on the apex (#397; auth-worker worker.ts:138-149). Do NOT add a `Domain` attribute anywhere.
- share.oyster.to (untrusted published HTML) is *same-site* with oyster.to → `SameSite=Lax` does not stop credentialed fetches from it → Origin checks are the mitigation.
- The password-unlock `POST /p/:token` on oyster-publish is legitimately posted from `share.oyster.to` pages — Origin checks apply to `/api/*` mutations ONLY, never `/p/*`.

---

### Task 1: Extract the shared transcript parser

The transform lives in `server/src/watchers/claude-code.ts` (`safeParse` line 1030, `RenderedEvent` 1038, `displayTouchPath` 1045, `renderEvent` 1062) and `server/src/utils/claude-protocol-artifacts.ts`. Move it to `shared/claude-transcript.ts` with zero behaviour change, keeping every existing import path working via re-exports.

**Files:**
- Create: `shared/claude-transcript.ts`
- Create: `server/test/claude-transcript-parity.test.ts`
- Modify: `server/src/watchers/claude-code.ts`
- Modify: `server/src/utils/claude-protocol-artifacts.ts`

- [ ] **Step 1: Write the parity test against the CURRENT exports (before moving anything)**

Create `server/test/claude-transcript-parity.test.ts`. It imports from the watcher's existing public exports, so it passes before AND after the extraction — that's the parity guarantee.

```ts
import { describe, it, expect } from "vitest";
import { renderEvent, displayTouchPath } from "../src/watchers/claude-code.js";
import { isClaudeProtocolArtifact } from "../src/utils/claude-protocol-artifacts.js";

const CWD = "/Users/test/Dev/proj";

describe("renderEvent parity", () => {
  it("renders a plain user message", () => {
    expect(renderEvent({ type: "user", message: { content: "hello world" } }))
      .toEqual({ role: "user", text: "hello world" });
  });

  it("renders a tool_result wrapper (string content)", () => {
    const ev = { type: "user", message: { content: [{ type: "tool_result", content: "ok done" }] } };
    expect(renderEvent(ev)).toEqual({ role: "tool_result", text: "ok done" });
  });

  it("renders a tool_result wrapper (array content)", () => {
    const ev = { type: "user", message: { content: [{ type: "tool_result", content: [{ text: "a" }, { text: "b" }] }] } };
    expect(renderEvent(ev)).toEqual({ role: "tool_result", text: "ab" });
  });

  it("renders assistant text + tool_use with file path relative to cwd", () => {
    const ev = {
      type: "assistant",
      message: { content: [
        { type: "text", text: "Editing now." },
        { type: "tool_use", name: "Edit", input: { file_path: `${CWD}/src/a.ts` } },
      ] },
    };
    expect(renderEvent(ev, CWD)).toEqual({ role: "assistant", text: "Editing now. [Edit src/a.ts]" });
  });

  it("renders a pure tool_use turn as role tool", () => {
    const ev = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } };
    expect(renderEvent(ev, CWD)).toEqual({ role: "tool", text: "[Bash]" });
  });

  it("renders empty assistant turns as (thinking)", () => {
    const ev = { type: "assistant", message: { content: [{ type: "text", text: "  " }] } };
    expect(renderEvent(ev)).toEqual({ role: "assistant", text: "(thinking)" });
  });

  it("renders system events as subtype: content", () => {
    expect(renderEvent({ type: "system", subtype: "warn", content: "low disk" }))
      .toEqual({ role: "system", text: "warn: low disk" });
  });

  it("skips unknown event types", () => {
    expect(renderEvent({ type: "file-history-snapshot", snapshot: {} })).toBeNull();
    expect(renderEvent({ type: "summary", summary: "..." })).toBeNull();
  });

  it("classifies protocol artifacts", () => {
    expect(isClaudeProtocolArtifact("<command-name>/exit</command-name>")).toBe(true);
    expect(isClaudeProtocolArtifact("  <system-reminder>x</system-reminder>")).toBe(true);
    expect(isClaudeProtocolArtifact("local_command: foo")).toBe(true);
    expect(isClaudeProtocolArtifact("normal message about <command-name>")).toBe(false);
  });
});

describe("displayTouchPath parity", () => {
  it("relativises paths under cwd", () => {
    expect(displayTouchPath(`${CWD}/deep/file.ts`, CWD)).toBe("deep/file.ts");
  });
  it("falls back to absolute for unrelated paths", () => {
    expect(displayTouchPath("/etc/hosts", CWD)).toBe("/etc/hosts");
  });
  it("collapses the home dir to ~", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    expect(displayTouchPath(`${home}/notes.md`, null)).toBe("~/notes.md");
  });
});
```

- [ ] **Step 2: Run it — must pass against the current implementation**

Run: `cd server && npx vitest run test/claude-transcript-parity.test.ts`
Expected: PASS (all green). If any case fails, the fixture doesn't match current behaviour — fix the TEST to match reality, never the code.

- [ ] **Step 3: Create `shared/claude-transcript.ts`**

First check the `SessionEventRole` union in `server/src/session-store.ts` (grep `SessionEventRole`) — `TranscriptRole` below must use the identical member strings so the watcher's `InsertSessionEvent.role` assignment stays type-correct.

```ts
// claude-transcript.ts — pure JSONL→event transform for Claude Code session
// transcripts. Shared between the local server's ingest watcher
// (server/src/watchers/claude-code.ts) and the cloud worker's read path
// (infra/oyster-cloud), so local and remote rendering cannot diverge.
//
// SCOPE GUARD: parsing + rendering ONLY. Display-state, output
// classification and artifact registration stay in server/src — if a
// change here needs a DB type or a node API, it belongs on the server.
// Runs in Node and in Workers: no node:* imports, no process.env.

export type TranscriptRole = "user" | "assistant" | "tool" | "tool_result" | "system";

export interface RenderedEvent {
  role: TranscriptRole;
  text: string;
}

export function safeParse(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// (move isClaudeProtocolArtifact here verbatim from
// server/src/utils/claude-protocol-artifacts.ts, including its full
// comment block)

/** Display form for a touched file path: relative to the session cwd when
 *  under it; else ~-collapsed when `home` is provided; else absolute.
 *  Portable replacement for the node:path version — a pure prefix check,
 *  equivalent for the normalized absolute paths Claude Code emits. */
export function displayTouchPath(filePath: string, cwd?: string | null, home?: string | null): string {
  if (cwd) {
    const base = cwd.endsWith("/") ? cwd : cwd + "/";
    if (filePath.startsWith(base) && filePath.length > base.length) {
      return filePath.slice(base.length);
    }
  }
  if (home) {
    const fp = filePath.replace(/\\/g, "/");
    const h = home.replace(/\\/g, "/");
    if (fp === h || fp.startsWith(h + "/")) return "~" + fp.slice(h.length);
  }
  return filePath;
}

// (move renderEvent here verbatim from watchers/claude-code.ts:1062-1136,
// changing only the signature to add the `home` pass-through:)
export function renderEvent(ev: Record<string, any>, cwd?: string | null, home?: string | null): RenderedEvent | null {
  // ... identical body, except both displayTouchPath callsites become
  //     displayTouchPath(filePath, cwd, home)
}
```

- [ ] **Step 4: Rewire the server to import from shared**

(a) `server/src/utils/claude-protocol-artifacts.ts` becomes a one-line re-export (keeps every existing import + its test working):

```ts
export { isClaudeProtocolArtifact } from "../../../shared/claude-transcript.js";
```

(b) In `server/src/watchers/claude-code.ts`:
- Delete the local `safeParse` (1030-1036), `RenderedEvent` (1038-1041), `displayTouchPath` (1045-1057), `renderEvent` (1062-1136).
- Add near the top, next to the existing re-exports (line 27):

```ts
import {
  renderEvent as renderEventShared,
  displayTouchPath as displayTouchPathShared,
  safeParse,
} from "../../../shared/claude-transcript.js";

// HOME captured once: the shared module is env-free; the node side owns
// the ~-collapse context.
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? null;

/** Node-side wrappers binding the home dir — keeps every existing caller
 *  and test on the old (ev, cwd) signature. */
export function renderEvent(ev: Record<string, any>, cwd?: string | null) {
  return renderEventShared(ev, cwd, HOME);
}
export function displayTouchPath(filePath: string, cwd?: string | null) {
  return displayTouchPathShared(filePath, cwd, HOME);
}
```

- Remove `relative` and `isAbsolute` from the `node:path` import **only if** nothing else in the file uses them (eslint/tsc will tell you; `join`, `dirname`, `basename` are used elsewhere — keep those).
- The `internal RenderedEvent` return type annotations: where the deleted interface was referenced, import the type: `import type { RenderedEvent } from "../../../shared/claude-transcript.js";` if still needed.

- [ ] **Step 5: Run the parity test + full server suite + typecheck**

Run: `cd server && npx vitest run test/claude-transcript-parity.test.ts && npm test && npx tsc --noEmit`
Expected: parity test green (proving behaviour identical), full suite green, tsc clean. `server/tsconfig.json` already has `"include": ["src", "../shared"]` and `rootDir: ".."` — no config change needed.

- [ ] **Step 6: Commit**

```bash
git add shared/claude-transcript.ts server/src/watchers/claude-code.ts server/src/utils/claude-protocol-artifacts.ts server/test/claude-transcript-parity.test.ts
git commit -m "shared: extract claude transcript parser for cloud worker reuse"
```

---

### Task 2: Worker events endpoint — `GET /api/sessions/:id/events`

New read route on oyster-cloud: decrypt the relevant R2 chunks, parse with the shared module, return events in the local API's wire shape with **byte-offset ids**.

**Files:**
- Create: `infra/oyster-cloud/src/transcript-events.ts`
- Modify: `infra/oyster-cloud/src/worker.ts` (dispatch, ~line 60)
- Modify: `infra/oyster-cloud/tsconfig.json` (only if `tsc --noEmit` complains about the `../../shared` import — add it to `include`)
- Test: `infra/oyster-cloud/test/transcript-events.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `infra/oyster-cloud/test/transcript-events.test.ts`. Copy the `makeProSession`, `makeFreeSession`, `signedFetch`, `sampleSession`, and `putChunk` helpers from `test/sessions-routes.test.ts` (they're file-local — copy, don't import). Fixture transcript:

```ts
const CWD = "/Users/test/proj";

// One JSONL line per event; byte offsets are line starts in the
// concatenated plaintext. All-ASCII so char offsets == byte offsets.
const LINES = [
  JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2026-05-10T10:00:01Z" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] }, timestamp: "2026-05-10T10:00:02Z" }),
  JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),                                  // skipped: unknown type
  JSON.stringify({ type: "user", message: { content: "<command-name>/exit</command-name>" } }),     // skipped: protocol artifact
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${CWD}/a.ts` } }] }, timestamp: "2026-05-10T10:00:03Z" }),
];
const BODY = LINES.map((l) => l + "\n").join("");
const PARTIAL_TAIL = `{"type":"user","message":{"content":"still being writ`; // no newline

function offsetOf(i: number): number {
  return LINES.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
}
```

Test cases (each seeds metadata via `POST /api/sessions/metadata` then uploads `BODY + PARTIAL_TAIL` as chunk 1 via `putChunk`, mirroring how sessions-routes.test.ts does it):

```ts
describe("GET /api/sessions/:id/events", () => {
  it("returns rendered events oldest-first with byte-offset ids", async () => {
    // setup: makeProSession → POST metadata for sid → putChunk(BODY + PARTIAL_TAIL)
    const res = await signedFetch(`/api/sessions/${sid}/events`, { method: "GET" }, token);
    expect(res.status).toBe(200);
    const events = await res.json();
    // 3 renderable events: user hello, assistant hi, tool [Edit a.ts].
    // Snapshot + protocol-artifact lines skipped; partial tail dropped.
    expect(events.map((e: any) => [e.id, e.role, e.text])).toEqual([
      [offsetOf(0), "user", "hello"],
      [offsetOf(1), "assistant", "hi there"],
      [offsetOf(4), "tool", "[Edit a.ts]"],
    ]);
    expect(events[0].ts).toBe("2026-05-10T10:00:01Z");
    expect(events[0].sessionId).toBe(sid);
    expect(events[0].raw).toBeNull();
  });

  it("honours after= (live tail)", async () => {
    const res = await signedFetch(`/api/sessions/${sid}/events?after=${offsetOf(0)}`, { method: "GET" }, token);
    const events = await res.json();
    expect(events.map((e: any) => e.id)).toEqual([offsetOf(1), offsetOf(4)]);
  });

  it("honours before= and limit= (scroll up)", async () => {
    const res = await signedFetch(`/api/sessions/${sid}/events?before=${offsetOf(4)}&limit=1`, { method: "GET" }, token);
    const events = await res.json();
    expect(events.map((e: any) => e.id)).toEqual([offsetOf(1)]); // latest 1 below cursor
  });

  it("returns [] for a session with metadata but no chunks", async () => {
    // setup: POST metadata only, no putChunk
    const res = await signedFetch(`/api/sessions/${sid}/events`, { method: "GET" }, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("requires auth", async () => {
    const res = await SELF.fetch(`https://example.com/api/sessions/${sid}/events`);
    expect(res.status).toBe(401);
  });

  it("rejects free tier with 403", async () => {
    const { token: freeToken } = await makeFreeSession();
    const res = await signedFetch(`/api/sessions/${sid}/events`, { method: "GET" }, freeToken);
    expect(res.status).toBe(403); // matches the manifest route's pro gate
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd infra/oyster-cloud && npm test -- transcript-events`
Expected: FAIL — route returns 404 `not_found` (no dispatch yet).

- [ ] **Step 3: Implement `src/transcript-events.ts`**

```ts
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
  // Auth + tier gate + metadata row: copy the opening block of
  // handleSessionsBytesManifestGet in worker.ts (~line 700) — same
  // resolveSession call (401 "sign_in_required"), same pro-tier rejection
  // (403 "pro_required") — but EXTEND its metadata SELECT: the manifest
  // handler reads only `bytes_generation, active_device_id`; this handler
  // additionally needs `cwd` (for renderEvent's path relativisation):
  //   SELECT bytes_generation, cwd FROM synced_session_metadata
  //    WHERE owner_id = ? AND session_id = ? LIMIT 1
  // Missing row → 404 "session_not_found" (same as manifest handler).
  // The block yields: `user`, `generation`, `cwd`.

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

  const url = new URL(req.url);
  const num = (name: string): number | null => {
    const v = url.searchParams.get(name);
    return v !== null && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const limitRaw = num("limit");
  const limit = limitRaw !== null ? Math.max(1, Math.min(MAX_LIMIT, limitRaw)) : DEFAULT_LIMIT;
  const before = num("before");
  const after = num("after");

  // Pick a contiguous chunk window: forward from the cursor for `after`
  // (live tail), backward from the end (or `before`) otherwise.
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

  // Decrypt the window. R2 key + AAD reconstruction copied from
  // handleSessionsBytesChunkGet (worker.ts ~795-820) — D1 row state is
  // the AAD source of truth, never R2 customMetadata.
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

  // Split on \n tracking absolute BYTE offsets (offsets are plaintext byte
  // positions — scan bytes, decode per line; never use JS string lengths).
  // Chunk starts are newline-aligned by the uploader except the >25 MB
  // single-line pathological case; a mid-line fragment fails safeParse and
  // is skipped — the same tolerance local ingest has. Trailing bytes with
  // no terminating \n are a partial write: skipped, matching the watcher's
  // partial-line buffering.
  const decoder = new TextDecoder();
  type WireEvent = { id: number; sessionId: string; role: string; text: string; ts: string | null; raw: null };
  const events: WireEvent[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    if (i > lineStart) {
      const line = decoder.decode(buf.subarray(lineStart, i));
      const ev = safeParse(line);
      // Mirror local ingest exactly (watchers/claude-code.ts:468-478):
      // render → truncate to preview budget → drop protocol artifacts.
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

  let out = events;
  if (after !== null) out = out.filter((e) => e.id > after).slice(0, limit);
  else if (before !== null) out = out.filter((e) => e.id < before).slice(-limit);
  else out = out.slice(-limit);

  return Response.json(out, { headers: { "cache-control": "private, no-store" } });
}
```

Notes for the implementer:
- The `home` argument to `renderEvent` is deliberately omitted (no `~`-collapse in the cloud — the worker doesn't know the device's home dir; paths render absolute). This is a documented, acceptable parity divergence.
- `cwd` comes from the metadata row fetched in the auth block.
- If `tsc --noEmit` rejects the `../../shared` import, add `"../../shared"` to the `include` array in `infra/oyster-cloud/tsconfig.json`.

- [ ] **Step 4: Register the route in `worker.ts`**

After the manifest match block (~line 60), following the same shape:

```ts
    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && eventsMatch[1] && req.method === "GET") {
      const sessionId = safeDecode(eventsMatch[1]);
      if (sessionId === null) return jsonError(400, "invalid_session_id");
      return handleSessionEventsGet(req, env, sessionId);
    }
```

Plus the import at the top: `import { handleSessionEventsGet } from "./transcript-events.js";`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd infra/oyster-cloud && npm test && npm run typecheck`
Expected: all green, including the pre-existing suites.

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-cloud/src/transcript-events.ts infra/oyster-cloud/src/worker.ts infra/oyster-cloud/test/transcript-events.test.ts infra/oyster-cloud/tsconfig.json
git commit -m "oyster-cloud: rendered transcript events endpoint (byte-offset cursors)"
```

---

### Task 3: Origin checks on mutating `/api/*` routes (both workers)

share.oyster.to hosts untrusted published HTML and is same-site with the apex — `SameSite=Lax` does not stop it firing credentialed mutations. Reject browser requests whose `Origin` isn't the apex. Requests with **no** Origin header (the local Oyster server's node fetch) pass.

**Files:**
- Modify: `infra/oyster-cloud/src/json.ts` (add helper) and `infra/oyster-cloud/src/worker.ts` (apply)
- Modify: `infra/oyster-publish/src/worker.ts` (add same helper locally + apply)
- Test: `infra/oyster-cloud/test/origin-guard.test.ts` AND `infra/oyster-publish/test/origin-guard.test.ts` — oyster-publish has a full vitest-pool-workers setup (`vitest.config.ts`, 14 test files in `test/`); crib its existing helpers for an equivalent three-case test against one mutating route (e.g. `PATCH /api/publish/:token`)

- [ ] **Step 1: Write the failing test (oyster-cloud)**

`infra/oyster-cloud/test/origin-guard.test.ts` (reuse `makeProSession` / `signedFetch` patterns; add an `origin` header variant):

```ts
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
// + applySchema/makeProSession helpers as in sessions-routes.test.ts

describe("origin guard on mutating routes", () => {
  it("rejects a mutating request from a foreign browser origin", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/api/sessions/metadata", {
      method: "POST",
      headers: {
        Cookie: `oyster_session=${token}`,
        Origin: "https://share.oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessions: [] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("bad_origin");
  });

  it("allows the apex origin", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/api/sessions/metadata", {
      method: "POST",
      headers: {
        Cookie: `oyster_session=${token}`,
        Origin: "https://oyster.to",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessions: [] }),
    });
    expect(res.status).not.toBe(403);
  });

  it("allows requests with no Origin header (local server)", async () => {
    const { token } = await makeProSession();
    const res = await signedFetch("/api/sessions/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions: [] }),
    }, token);
    expect(res.status).not.toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd infra/oyster-cloud && npm test -- origin-guard`
Expected: first test FAILS (no guard yet — request is processed normally).

- [ ] **Step 3: Implement the guard (oyster-cloud)**

In `infra/oyster-cloud/src/json.ts`:

```ts
// Browser-origin guard for mutating routes (spec
// 2026-06-05-cloud-remote-view-design.md). share.oyster.to serves
// untrusted published HTML and is *same-site* with the apex, so
// SameSite=Lax alone doesn't stop credentialed cross-origin fetches from
// it. Non-browser clients (the local Oyster server) send no Origin
// header — absence passes.
const ALLOWED_BROWSER_ORIGINS = new Set(["https://oyster.to", "https://www.oyster.to"]);

export function rejectBadOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_BROWSER_ORIGINS.has(origin)) {
    return jsonError(403, "bad_origin");
  }
  return null;
}
```

In `worker.ts`, at the top of each mutating handler — `handleMemoryEventsPost`, `handleSessionsMetadataPost`, `handleSessionsBytesChunkPut`, `handleSessionsBytesReset` — first line:

```ts
  const badOrigin = rejectBadOrigin(req);
  if (badOrigin) return badOrigin;
```

- [ ] **Step 4: Same guard in oyster-publish**

Add the identical `rejectBadOrigin` (with its comment) to `infra/oyster-publish/src/worker.ts` (or its helpers module if one fits better — match local style; it already has `jsonError`-equivalent helpers, check `publish-helpers.ts`). Apply to these handlers ONLY:
- `POST /api/publish/upload`
- `DELETE /api/publish/:token`
- `PATCH /api/publish/:token`
- `PUT /api/spaces/:id`
- `DELETE /api/spaces/:id`

**Do NOT touch the `/p/*` POST** — that's the password-unlock form legitimately posted from share.oyster.to viewer pages; it has its own gate.

- [ ] **Step 5: Run both workers' checks**

Run: `cd infra/oyster-cloud && npm test && npm run typecheck`
Run: `cd infra/oyster-publish && npm test && npx tsc --noEmit`
Expected: green in both, including all pre-existing suites — push tests must still pass (they send no Origin).

- [ ] **Step 6: Commit**

```bash
git add infra/oyster-cloud/src/json.ts infra/oyster-cloud/src/worker.ts infra/oyster-cloud/test/origin-guard.test.ts infra/oyster-publish/src
git commit -m "workers: reject mutating /api requests from foreign browser origins"
```

---

### Task 4: `oyster.to/app` — route, /app/api rewrite, whoami shell

The remote view lives on the apex so the host-only `oyster_session` cookie (#397) authenticates it with zero auth changes. `/app/api/*` rewrites onto the existing `/api/*` dispatch. The HTML shell is throwaway scaffolding proving the chain E2E; the UI slice replaces it.

**Files:**
- Create: `infra/oyster-cloud/src/app-shell.ts`
- Modify: `infra/oyster-cloud/src/worker.ts` (dispatch, top of fetch)
- Modify: `infra/oyster-cloud/wrangler.toml` (routes)
- Test: `infra/oyster-cloud/test/app-shell.test.ts`

- [ ] **Step 1: Write the failing tests**

`infra/oyster-cloud/test/app-shell.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
// + applySchema/makeProSession helpers as in sessions-routes.test.ts

describe("GET /app", () => {
  it("serves a sign-in prompt when unauthenticated", async () => {
    const res = await SELF.fetch("https://example.com/app");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Sign in");
  });

  it("serves the whoami shell when signed in", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/app", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Signed in as");
  });

  it("rewrites /app/api/* onto the API dispatch", async () => {
    const { token } = await makeProSession();
    const res = await SELF.fetch("https://example.com/app/api/sessions/metadata", {
      headers: { Cookie: `oyster_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("sessions");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd infra/oyster-cloud && npm test -- app-shell`
Expected: FAIL — 404 `not_found` on all three.

- [ ] **Step 3: Implement `src/app-shell.ts`**

First check `resolveSession`'s return shape in `src/session.ts` (the user object's exact fields — `email`, `tier`) and adjust the template below if the names differ.

```ts
// app-shell.ts — throwaway whoami shell for the remote view's backend
// slice (spec 2026-06-05-cloud-remote-view-design.md). Proves the chain
// browser → apex cookie → worker → sessions metadata end-to-end. The UI
// slice (blocked on unified-scope-ux PR1) replaces this with the real
// cloud-mode web build.
import type { Env } from "./session.js";
import { resolveSession } from "./session.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oyster</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:2rem auto;max-width:40rem;padding:0 1rem;background:#101014;color:#e8e8ee}a{color:#7c6bff}li{margin:.35rem 0}</style>
</head><body>${body}</body></html>`;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export async function handleAppShell(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) {
    return new Response(
      page(`<h1>Oyster</h1><p>Not signed in. <a href="https://oyster.to/auth/sign-in">Sign in</a>, then come back to <a href="/app">/app</a>.</p>`),
      { status: 401, headers: HTML_HEADERS },
    );
  }
  return new Response(
    page(`<h1>Oyster</h1>
<p>Signed in as <strong>${esc(user.email)}</strong> (${esc(user.tier)}).</p>
<h2>Sessions</h2><ol id="s"><li>loading…</li></ol>
<script>
fetch("/app/api/sessions/metadata").then(function (r) { return r.json(); }).then(function (d) {
  var ol = document.getElementById("s");
  ol.innerHTML = "";
  var sessions = (d.sessions || []).slice(0, 20);
  if (!sessions.length) { ol.innerHTML = "<li>none synced yet</li>"; return; }
  sessions.forEach(function (s) {
    var li = document.createElement("li"); // textContent — titles are untrusted
    li.textContent = (s.title || s.session_id) + " — " + (s.device_label || s.device_id) + " (" + s.state + ")";
    ol.appendChild(li);
  });
});
</script>`),
    { headers: HTML_HEADERS },
  );
}
```

Note: verify the sign-in URL `https://oyster.to/auth/sign-in` against the auth-worker's actual page route (grep `sign-in` in `infra/auth-worker/src/worker.ts`); adjust the href if the path differs.

- [ ] **Step 4: Dispatch + rewrite in `worker.ts`**

At the top of `fetch`, immediately after `const url = new URL(req.url);`:

```ts
    // oyster.to/app — remote-view shell (spec 2026-06-05-cloud-remote-view).
    // Lives on the apex so the host-only oyster_session cookie (#397)
    // authenticates it with no auth-worker changes. The shell's API calls
    // are same-origin: /app/api/* is rewritten onto the /api/* dispatch
    // below (URL.pathname is mutable).
    if (url.hostname === "www.oyster.to" && url.pathname.startsWith("/app")) {
      return Response.redirect(`https://oyster.to${url.pathname}${url.search}`, 301);
    }
    if ((url.pathname === "/app" || url.pathname === "/app/") && req.method === "GET") {
      return handleAppShell(req, env);
    }
    if (url.pathname.startsWith("/app/api/")) {
      url.pathname = url.pathname.slice("/app".length);
    }
```

Plus the import: `import { handleAppShell } from "./app-shell.js";`

Check that the dispatch below matches on `url.pathname` (it does — lines 18-67) rather than re-deriving from `req.url`; the rewrite only works if every subsequent match reads the mutated `url`.

- [ ] **Step 5: wrangler.toml routes**

Append to `infra/oyster-cloud/wrangler.toml`:

```toml
# Remote view (spec 2026-06-05-cloud-remote-view): the app shell + its
# same-origin /app/api/* rewrite live on the apex so the host-only
# oyster_session cookie (#397) applies. Path-specific routes win over
# whatever else serves oyster.to/*.
[[routes]]
pattern = "oyster.to/app*"
zone_name = "oyster.to"

[[routes]]
pattern = "www.oyster.to/app*"
zone_name = "oyster.to"
```

- [ ] **Step 6: Run tests**

Run: `cd infra/oyster-cloud && npm test && npm run typecheck`
Expected: all green (new + pre-existing).

- [ ] **Step 7: Commit**

```bash
git add infra/oyster-cloud/src/app-shell.ts infra/oyster-cloud/src/worker.ts infra/oyster-cloud/wrangler.toml infra/oyster-cloud/test/app-shell.test.ts
git commit -m "oyster-cloud: oyster.to/app whoami shell + /app/api rewrite"
```

---

### Task 5: Full verification + deploy + E2E

- [ ] **Step 1: Full local verification**

```bash
cd server && npm test && npx tsc --noEmit
cd ../infra/oyster-cloud && npm test && npm run typecheck
cd ../.. && npm run build
```
Expected: everything green. `npm run build` confirms the shared-module move didn't break the production server build (`rootDir: ".."` puts `shared/` in `server/dist/shared/`).

- [ ] **Step 2: Deploy (manual — no CI for workers)**

```bash
cd infra/oyster-cloud && npx wrangler deploy
cd ../oyster-publish && npx wrangler deploy
```
auth-worker is untouched — do not deploy it.

- [ ] **Step 3: E2E — laptop**

In a browser already signed into oyster.to: open `https://oyster.to/app`.
Expected: "Signed in as matthew@slight.me (pro)" + up to 20 session titles with device labels.

Then exercise the events endpoint with a real synced session (grab a session id from the shell page, token from `~/Oyster/config/auth.json`):

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Oyster/config/auth.json'))['session_token'])")
curl -s -b "oyster_session=$TOKEN" "https://oyster.to/app/api/sessions/<id>/events?limit=5" | python3 -m json.tool
```
Expected: 5 rendered events with integer byte-offset `id`s, roles, 280-char-max texts. (If the auth.json key isn't `session_token`, check the file — `auth-service.ts` writes it.)

- [ ] **Step 4: E2E — phone**

On your phone: `https://oyster.to/app` → sign in via the oyster.to flow → return to /app → session list renders. This is the dogfood moment the slice exists for.

- [ ] **Step 5: CSRF spot-check**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Origin: https://share.oyster.to" -b "oyster_session=$TOKEN" \
  -H "content-type: application/json" -d '{"sessions":[]}' \
  https://cloud.oyster.to/api/sessions/metadata
```
Expected: `403`.

- [ ] **Step 6: Confirm local sync still healthy**

Restart the local dev server (`npm run dev`) and watch for the usual `[sessions] reconcile (startup): pulled=N pushed=N` line with no new errors — proves the Origin guard didn't break the no-Origin node client.

- [ ] **Step 7: Push branch + PR**

```bash
git push -u origin cloud-remote-view
gh pr create --title "Cloud remote view: backend slice (shared parser, events endpoint, origin guard, /app shell)" --body "..."
```
PR body should link the spec and note: no changelog entry (no consumer-visible change yet); UI slice follows after unified-scope-ux PR1 lands.

---

## Explicitly deferred (do not build in this slice)

- `GET /api/sessions/:id/events/:offset` raw-line endpoint (tool-turn expand) — UI slice
- Worker-side caching of parsed tails — only if live-tail polling proves hot
- Cloud-mode web build, responsive pass, device filter UI — UI slice, post-PR1
- `app.oyster.to` + one-time-code cookie handshake — productization
- Known wrinkle for the UI slice: a `MAX_CHUNKS`-capped response can return fewer than `limit` events while older history still exists; the local UI reads short pages as "history exhausted". The cloud client adapter must handle this (e.g. always offer "load more" until an empty page).
- Live-tail polling note for the UI slice: an `after=` poll whose cursor sits inside the last chunk re-decrypts that chunk even when nothing changed (the cursor is a line *start*, so the chunk always "contains newer bytes"). The cheap no-op poll is: poll `GET .../manifest` (D1-only, no R2) and call `/events?after=` only when `total_size` grew. Don't add worker-side caching for this in the backend slice.

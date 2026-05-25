# Session meta-tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app agent surface a past session in the UI — adding `list_sessions` (recency-ordered discovery) and `open_session` (open a session in the existing inspector, optionally focused on a transcript turn).

**Architecture:** A new `listRecent` store query backs a thin `list_sessions` MCP tool. `open_session` looks up the session and broadcasts a `UiCommand` over the existing SSE channel; `App.tsx` re-dispatches it as the `oyster:open-session` window event that `Home` + `SessionInspector` already consume (the exact path Spotlight uses). No new UI, no new routing.

**Tech Stack:** TypeScript, better-sqlite3, `@modelcontextprotocol/sdk` (via the in-repo `makeTool` helper), Zod, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-session-meta-tools-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/session-store.ts` | SQLite session persistence | Add `listRecent` (interface + prepared stmt + method) |
| `server/test/session-list-recent.test.ts` | Unit tests for `listRecent` | Create |
| `server/src/mcp-server.ts` | MCP tool surface | Add `list_sessions` + `open_session` tools |
| `web/src/App.tsx` | Root SSE command handling | Add `open_session` → `oyster:open-session` re-dispatch |
| `.opencode/agents/oyster.md` | Agent guidance | Add tool-table rows + usage bullet |
| `CHANGELOG.md` / `docs/changelog.html` | User-facing changelog | Add Unreleased entry + rebuild |
| `CLAUDE.md` | Project context | Reword the brittle tool-count line |

All automated testing lives in Task 1 (the store query — the only non-trivial logic). The MCP tools, web handler, and docs are thin wrappers / prose with no unit-test seam in this codebase (there are no `mcp-server` unit tests today); they're verified by typecheck + the manual end-to-end test in Task 7. This is deliberate — do not scaffold a new MCP protocol-level test harness.

---

## Task 1: `listRecent` store query

**Files:**
- Modify: `server/src/session-store.ts` (interface near line 179; `stmts` type near line 242; constructor near line 270; method near line 432)
- Test: `server/test/session-list-recent.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `server/test/session-list-recent.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import { SqliteSessionStore } from "../src/session-store.js";

function makeEnv() {
  const userland = mkdtempSync(join(tmpdir(), "oyster-listrecent-"));
  const db = initDb(userland);
  const store = new SqliteSessionStore(db);
  return {
    db,
    store,
    dispose: () => { db.close(); rmSync(userland, { recursive: true, force: true }); },
  };
}

interface InsertOpts {
  spaceId?: string | null;
  title?: string | null;
  startedAt?: string;
  lastEventAt?: string;
}

function insertSession(db: Database.Database, id: string, opts: InsertOpts = {}) {
  db.prepare(
    `INSERT INTO sessions (id, space_id, project_id, cwd, agent, title, state, started_at, last_event_at, assignment_mode)
     VALUES (?, ?, NULL, NULL, 'claude-code', ?, 'disconnected', ?, ?, 'auto')`,
  ).run(
    id,
    opts.spaceId ?? null,
    opts.title ?? null,
    opts.startedAt ?? "2026-01-01 00:00:00",
    opts.lastEventAt ?? "2026-01-01 00:00:00",
  );
}

describe("SqliteSessionStore.listRecent", () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.dispose(); });

  it("orders by last_event_at descending", () => {
    insertSession(env.db, "s-old", { title: "old", lastEventAt: "2026-01-01 00:00:00" });
    insertSession(env.db, "s-mid", { title: "mid", lastEventAt: "2026-01-02 00:00:00" });
    insertSession(env.db, "s-new", { title: "new", lastEventAt: "2026-01-03 00:00:00" });
    expect(env.store.listRecent().map((s) => s.id)).toEqual(["s-new", "s-mid", "s-old"]);
  });

  it("breaks last_event_at ties by started_at then id, descending", () => {
    // Identical last_event_at + started_at: only id differs → id DESC wins.
    insertSession(env.db, "id-1", { title: "a", startedAt: "2026-02-01 00:00:00", lastEventAt: "2026-02-09 00:00:00" });
    insertSession(env.db, "id-2", { title: "b", startedAt: "2026-02-01 00:00:00", lastEventAt: "2026-02-09 00:00:00" });
    // Same last_event_at but later started_at → sorts above the two above.
    insertSession(env.db, "id-0", { title: "c", startedAt: "2026-02-05 00:00:00", lastEventAt: "2026-02-09 00:00:00" });
    expect(env.store.listRecent().map((s) => s.id)).toEqual(["id-0", "id-2", "id-1"]);
  });

  it("defaults to 20 rows and caps at 100", () => {
    for (let i = 0; i < 101; i++) {
      // Zero-padded ids keep ordering deterministic under the id tie-breaker.
      insertSession(env.db, `s-${String(i).padStart(3, "0")}`, {
        title: `t${i}`,
        lastEventAt: "2026-03-01 00:00:00",
      });
    }
    expect(env.store.listRecent().length).toBe(20);
    expect(env.store.listRecent({ limit: 1000 }).length).toBe(100);
    expect(env.store.listRecent({ limit: 5 }).length).toBe(5);
  });

  it("returns empty for an unknown space", () => {
    insertSession(env.db, "s-1", { title: "x", spaceId: "home" });
    expect(env.store.listRecent({ spaceId: "does-not-exist" })).toEqual([]);
  });

  it("scopes to a space when spaceId is given", () => {
    insertSession(env.db, "s-home", { title: "h", spaceId: "home" });
    insertSession(env.db, "s-work", { title: "w", spaceId: "work" });
    expect(env.store.listRecent({ spaceId: "home" }).map((s) => s.id)).toEqual(["s-home"]);
  });

  it("excludes empty stubs but keeps titled or evented rows", () => {
    insertSession(env.db, "s-stub", { title: null });           // no title, no events → excluded
    insertSession(env.db, "s-titled", { title: "has a title" }); // titled, no events → kept
    insertSession(env.db, "s-evented", { title: null });         // no title, has events → kept
    env.store.insertEvent({ session_id: "s-evented", role: "assistant", text: "hello" });
    const ids = env.store.listRecent().map((s) => s.id).sort();
    expect(ids).toEqual(["s-evented", "s-titled"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run test/session-list-recent.test.ts`
Expected: FAIL — `env.store.listRecent is not a function` (method not yet defined).

- [ ] **Step 3: Add `listRecent` to the `SessionStore` interface**

In `server/src/session-store.ts`, immediately after the `getById` line in the `SessionStore` interface (the line `getById(id: string): SessionRow | undefined;`, ~line 180):

```ts
  /** Recent sessions for discovery (the list_sessions MCP tool). Recency-
   *  ordered (last_event_at desc, then started_at, then id), optionally
   *  scoped to a space. Excludes empty stubs (no title AND no events).
   *  Limit defaults to 20 and is capped at 100. */
  listRecent(opts?: { spaceId?: string | null; limit?: number }): SessionRow[];
```

- [ ] **Step 4: Declare the prepared statement**

In the `SqliteSessionStore` `private stmts: { … }` type, after `getById: Database.Statement;` (~line 242):

```ts
    listRecent: Database.Statement;
```

- [ ] **Step 5: Prepare the statement in the constructor**

In the constructor's `this.stmts = { … }` block, after the `getById: db.prepare("SELECT * FROM sessions WHERE id = ?"),` line (~line 270):

```ts
      // Discovery query for list_sessions. @spaceId null = all spaces.
      // last_event_at is NOT NULL today, so COALESCE is defensive only;
      // the started_at/id tie-breakers give a stable order for equal
      // timestamps. Empty stubs (no title AND no events) are filtered out.
      listRecent: db.prepare(`
        SELECT * FROM sessions
        WHERE (@spaceId IS NULL OR space_id = @spaceId)
          AND ( (title IS NOT NULL AND title <> '')
                OR EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = sessions.id) )
        ORDER BY COALESCE(last_event_at, started_at) DESC, started_at DESC, id DESC
        LIMIT @limit
      `),
```

- [ ] **Step 6: Implement the method**

In `SqliteSessionStore`, immediately after the `getById` method (the block `getById(id: string): SessionRow | undefined { return this.stmts.getById.get(id) as SessionRow | undefined; }`, ~line 432):

```ts
  listRecent(opts?: { spaceId?: string | null; limit?: number }): SessionRow[] {
    const limit = Math.min(Math.max(1, Math.trunc(opts?.limit ?? 20)), 100);
    return this.stmts.listRecent.all({ spaceId: opts?.spaceId ?? null, limit }) as SessionRow[];
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd server && npx vitest run test/session-list-recent.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 8: Commit**

```bash
git add server/src/session-store.ts server/test/session-list-recent.test.ts
git commit -m "feat(sessions): listRecent store query for session discovery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `list_sessions` + `open_session` MCP tools

**Files:**
- Modify: `server/src/mcp-server.ts` (insert between the `open_artifact` tool block, which ends ~line 738, and the `// ── switch_space ──` comment ~line 740)

- [ ] **Step 1: Add both tool blocks**

In `server/src/mcp-server.ts`, immediately after the closing `);` of the `open_artifact` `tool(...)` call and before the `// ── switch_space ──` comment, insert:

```ts
  // ── list_sessions ──

  tool(
    "list_sessions",
    "List recent sessions for discovery — most-recently-active first, optionally scoped to a space by id. Returns slim metadata only (no transcript text). Use recall_transcripts to search session content, or open_session to surface a session in the inspector.",
    {
      space_id: z.string().optional().describe("Scope to a single space id (omit for all spaces). Unknown id returns an empty list."),
      limit: z.number().int().positive().optional().describe("Max sessions to return. Defaults to 20, capped at 100."),
    },
    async ({ space_id, limit }) => {
      const rows = deps.sessionStore.listRecent({ spaceId: space_id, limit });
      return rows.map((s) => ({
        id: s.id,
        title: s.title,
        space_id: s.space_id,
        agent: s.agent,
        state: s.state,
        started_at: s.started_at,
        last_event_at: s.last_event_at,
        ended_at: s.ended_at,
      }));
    },
  );

  // ── open_session ──

  tool(
    "open_session",
    "Open a past session in the user's session inspector by exact ID — shows its transcript, artefacts, and memory. The inspector opens immediately over the current surface. Find the id with recall_transcripts or list_sessions. Pass event_id (from a recall_transcripts hit) to land on that exact transcript turn, and query to pre-fill the in-transcript find bar.",
    {
      session_id: z.string().describe("ID of the session to open"),
      event_id: z.number().int().optional().describe("Transcript event id from a recall_transcripts hit to scroll to and highlight. Best-effort: a stale/missing id still opens the session."),
      query: z.string().optional().describe("Text to pre-fill the in-transcript find bar (e.g. the phrase recall_transcripts matched)."),
    },
    async ({ session_id, event_id, query }) => {
      const session = deps.sessionStore.getById(session_id);
      if (!session) throw new Error(`Session "${session_id}" not found. Use list_sessions or recall_transcripts to find a session id.`);
      deps.broadcastUiEvent({
        version: 1,
        command: "open_session",
        payload: { sessionId: session.id, eventId: event_id, query },
      });
      return `Opened session "${session.title ?? session.id}"`;
    },
  );
```

- [ ] **Step 2: Typecheck the server**

Run: `cd server && npm run build`
Expected: `tsc` exits 0, no type errors. (`z`, `tool`, `deps.sessionStore`, `deps.broadcastUiEvent` are all already in scope in this file.)

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp-server.ts
git commit -m "feat(mcp): list_sessions + open_session tools

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `open_session` web handler

**Files:**
- Modify: `web/src/App.tsx` (inside the `subscribeUiEvents` callback in the SSE `useEffect`, after the `terminal_session_linked` block ~line 231)

- [ ] **Step 1: Add the handler**

In `web/src/App.tsx`, inside the `useEffect(() => subscribeUiEvents((event) => { … })` callback, after the closing `}` of the `if (event.command === "terminal_session_linked") { … }` block and before the callback's closing `})`, insert:

```ts
    if (event.command === "open_session") {
      // Mirror Spotlight: re-dispatch as the window event Home already
      // listens for. No route push — Home is always mounted, so this opens
      // the inspector from any space. eventId → focusEventId, query →
      // initialSearchQuery; both best-effort (a stale eventId still opens).
      const { sessionId, eventId, query } = event.payload as {
        sessionId: string; eventId?: number; query?: string;
      };
      window.dispatchEvent(new CustomEvent("oyster:open-session", {
        detail: { id: sessionId, eventId, query },
      }));
    }
```

- [ ] **Step 2: Typecheck the web app**

Run: `cd web && npx tsc -b`
Expected: exits 0, no type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): open_session SSE command opens the session inspector

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Agent guidance

**Files:**
- Modify: `.opencode/agents/oyster.md` (tool table after the `open_artifact` / `switch_space` rows ~line 67-68; usage bullets after line 83)

- [ ] **Step 1: Add the tool-table rows**

In `.opencode/agents/oyster.md`, immediately after the `| `switch_space` | … |` row (~line 68), add two rows:

```markdown
| `list_sessions` | List recent sessions (most-recent first), optionally scoped to a space. Slim metadata only — no transcript text. Use it to find a session to open. |
| `open_session` | Open a past session in the inspector by exact ID — transcript, artefacts, memory. Get the id from `recall_transcripts` or `list_sessions`; pass `event_id` to land on a specific turn. |
```

- [ ] **Step 2: Add the usage bullet**

After the `- **"Show me X" / "open X"** → … open_artifact(id) …` bullet (~line 83), add:

```markdown
- **"Show me / open this session"** → `open_session(session_id)` with the id from a `recall_transcripts` hit or `list_sessions`. Pass the hit's `event_id` to jump to the exact turn. Treat it as an instant navigation command like `open_artifact` — call it immediately, one-line confirmation after.
```

- [ ] **Step 3: Commit**

```bash
git add .opencode/agents/oyster.md
git commit -m "docs(agent): guide open_session / list_sessions usage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CHANGELOG + CLAUDE.md

**Files:**
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section near line 5)
- Modify: `CLAUDE.md` (line 42, the tool-count line)
- Regenerate: `docs/changelog.html`

- [ ] **Step 1: Add the Unreleased entry**

In `CHANGELOG.md`, replace the lone `## [Unreleased]` heading (line 5) with:

```markdown
## [Unreleased]

### Added

- **Ask to see a past session, and Oyster opens it.** Say "show me the session about X" and the agent finds it and opens it in the inspector — jumping straight to the relevant moment when it can. It can also list your recent sessions on request.
```

- [ ] **Step 2: Reword the CLAUDE.md tool-count line**

In `CLAUDE.md`, replace line 42:

```markdown
**MCP** — the server exposes 21 tools at `/mcp/` (17 artifact/space + 4 memory). Any MCP client (Claude Code, Cursor, etc.) can connect and control the surface.
```

with:

```markdown
**MCP** — the server exposes MCP tools at `/mcp/` covering spaces, artefacts, sessions, and memory. Any MCP client (Claude Code, Cursor, etc.) can connect and control the surface.
```

- [ ] **Step 3: Regenerate the changelog HTML**

Run: `npm run build:changelog`
Expected: exits 0; `docs/changelog.html` is rewritten to include the Unreleased "Added" entry.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/changelog.html CLAUDE.md
git commit -m "docs: changelog entry for session opening; de-brittle MCP tool count

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full build

**Files:** none (verification only)

- [ ] **Step 1: Build the whole project**

Run: `npm run build`
Expected: web build (`tsc -b && vite build`) and server build (`tsc`) both succeed; `web/dist` is copied into `server/dist/public`. Exit 0.

- [ ] **Step 2: Run the server test suite**

Run: `cd server && npm test`
Expected: all tests pass, including `session-list-recent.test.ts`.

---

## Task 7: Manual end-to-end verification

**Files:** none (manual)

> Run the dev server from the worktree. Because dev and the installed package share `~/Oyster/` under a single-instance lockfile, either stop any other running Oyster first, or isolate this worktree's workspace with `OYSTER_USERLAND=/tmp/oyster-meta-tools` so it can't collide. From the worktree root: `npm run dev`, then open the Vite URL (`http://localhost:7337`).

- [ ] **Step 1: Happy path — open by content**

In the chat bar, ask: "which session was working with PR 593?" then "show me that session."
Expected: the agent calls `recall_transcripts` then `open_session`, and the `SessionInspector` opens on the matched session.

- [ ] **Step 2: Focused turn**

Ask the agent to open a session "at the part where we discussed <phrase>" so it passes `event_id` (from a `recall_transcripts` hit).
Expected: the inspector opens scrolled to that turn, which flashes briefly; the find bar is pre-filled if `query` was passed.

- [ ] **Step 3: Stale event_id is best-effort**

(Optional, via an MCP client or by editing the agent's call.) Call `open_session` with a valid `session_id` but a bogus `event_id` (e.g. `999999999`).
Expected: the session still opens (no error) — it simply shows a valid window of that session's events without scrolling/flashing a missing one.

- [ ] **Step 4: list_sessions discovery**

Ask: "what are my most recent sessions?"
Expected: the agent calls `list_sessions` and lists recent sessions (titled or evented only — no empty stubs), most-recent first.

- [ ] **Step 5: Protect the "Home always mounted" assumption**

Open an artifact in the viewer (or navigate to a deep-linked `/s/<space>/a/<id>` URL) so the surface is not on the default Home view, then ask the agent to "show me <session>".
Expected: the `SessionInspector` still opens over the current surface. (If a future refactor unmounts `Home`, this step is where it breaks.)

- [ ] **Step 6: Final commit (if any manual-fix tweaks were needed)**

Only if Steps 1-5 surfaced a fix. Otherwise nothing to commit.

---

## Done

The user story — "find the relevant session, then show it" — is complete: `list_sessions` + `recall_transcripts` find a session; `open_session` surfaces it in the inspector, optionally on the exact turn.

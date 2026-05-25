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
  if (opts.spaceId) {
    db.prepare(
      `INSERT OR IGNORE INTO spaces (id, display_name, color, scan_status) VALUES (?, ?, '#000', 'none')`,
    ).run(opts.spaceId, opts.spaceId);
  }
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
    insertSession(env.db, "id-1", { title: "a", startedAt: "2026-02-01 00:00:00", lastEventAt: "2026-02-09 00:00:00" });
    insertSession(env.db, "id-2", { title: "b", startedAt: "2026-02-01 00:00:00", lastEventAt: "2026-02-09 00:00:00" });
    insertSession(env.db, "id-0", { title: "c", startedAt: "2026-02-05 00:00:00", lastEventAt: "2026-02-09 00:00:00" });
    expect(env.store.listRecent().map((s) => s.id)).toEqual(["id-0", "id-2", "id-1"]);
  });

  it("defaults to 20 rows and caps at 100", () => {
    for (let i = 0; i < 101; i++) {
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
    insertSession(env.db, "s-stub", { title: null });
    insertSession(env.db, "s-titled", { title: "has a title" });
    insertSession(env.db, "s-evented", { title: null });
    env.store.insertEvent({ session_id: "s-evented", role: "assistant", text: "hello" });
    const ids = env.store.listRecent().map((s) => s.id).sort();
    expect(ids).toEqual(["s-evented", "s-titled"]);
  });

  it("treats a protocol-artifact-only session as an empty stub", () => {
    // Slash-command machinery (is_protocol_artifact = 1) is hidden from the
    // transcript and excluded from FTS, so it must not count as "has events".
    insertSession(env.db, "s-protocol-only", { title: null });
    env.store.insertEvent({
      session_id: "s-protocol-only",
      role: "system",
      text: "<command-name>/exit</command-name>",
      is_protocol_artifact: 1,
    });
    expect(env.store.listRecent().map((s) => s.id)).toEqual([]);
  });
});

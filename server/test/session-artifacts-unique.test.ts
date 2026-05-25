import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { initDb } from "../src/db.js";

describe("session_artifacts UNIQUE(session_id, artifact_id, role)", () => {
  let dir: string; let db: ReturnType<typeof initDb>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-sau-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id,display_name,color,scan_status) VALUES ('s','S','#000','none')`);
    db.prepare(`INSERT INTO projects (id,space_id,name) VALUES ('p','s','proj')`).run();
    db.exec(`INSERT INTO sessions (id,agent,state,project_id) VALUES ('sess','claude-code','done','p')`);
    db.prepare(`INSERT INTO artifacts (id,label,artifact_kind,storage_kind,storage_config,runtime_kind,runtime_config,project_id) VALUES ('a','a','notes','filesystem','{}','static_file','{}','p')`).run();
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("rejects a duplicate (session, artifact, role) and keeps one row", () => {
    const ins = db.prepare(`INSERT OR IGNORE INTO session_artifacts (session_id, artifact_id, role, when_at) VALUES ('sess','a','create',?)`);
    ins.run("2026-01-01T00:00:00Z");
    ins.run("2026-01-02T00:00:00Z"); // dup (session,artifact,role) — ignored
    const n = db.prepare("SELECT COUNT(*) AS n FROM session_artifacts WHERE session_id='sess' AND artifact_id='a' AND role='create'").get() as { n: number };
    expect(n.n).toBe(1);
  });
  it("allows the same artifact with a different role", () => {
    db.prepare(`INSERT OR IGNORE INTO session_artifacts (session_id,artifact_id,role) VALUES ('sess','a','create')`).run();
    db.prepare(`INSERT OR IGNORE INTO session_artifacts (session_id,artifact_id,role) VALUES ('sess','a','modify')`).run();
    const n = db.prepare("SELECT COUNT(*) AS n FROM session_artifacts WHERE session_id='sess' AND artifact_id='a'").get() as { n: number };
    expect(n.n).toBe(2);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { SqliteArtifactStore } from "../src/artifact-store.js";

describe("artifact store derives space via project", () => {
  let userland: string;
  let db: ReturnType<typeof initDb>;
  let store: SqliteArtifactStore;
  beforeEach(() => {
    userland = mkdtempSync(join(tmpdir(), "oyster-asd-"));
    db = initDb(userland);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
    db.prepare("INSERT INTO projects (id, space_id, name) VALUES ('p1','work','repo')").run();
    store = new SqliteArtifactStore(db);
  });
  afterEach(() => { db.close(); rmSync(userland, { recursive: true, force: true }); });

  it("derives space_id from the artifact's project; orphan → empty string", () => {
    store.insert({ id: "a1", owner_id: null, label: "r", artifact_kind: "notes", storage_kind: "filesystem", storage_config: JSON.stringify({ path: "/repo/r.md" }), runtime_kind: "static_file", runtime_config: "{}", group_name: null, project_id: "p1" });
    store.insert({ id: "a2", owner_id: null, label: "o", artifact_kind: "notes", storage_kind: "filesystem", storage_config: JSON.stringify({ path: "/x/o.md" }), runtime_kind: "static_file", runtime_config: "{}", group_name: null, project_id: null });

    expect(store.getById("a1")!.space_id).toBe("work");      // derived from project p1
    expect(store.getById("a2")!.space_id).toBe("");          // orphan → empty
    expect(store.getBySpaceId("work").map((r) => r.id)).toEqual(["a1"]); // orphan excluded
    expect(store.getDistinctSpaces()).toEqual([{ space_id: "work", count: 1 }]);
  });
});

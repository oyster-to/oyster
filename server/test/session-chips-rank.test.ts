import { describe, it, expect } from "vitest";
import { rankSessionChips } from "../src/routes/sessions.js"; // export it from sessions.ts

const row = (artifactId: string, role: "create"|"modify"|"read", whenAt: string, kind: string) =>
  ({ artifactId, label: artifactId, role, whenAt, kind } as const);

describe("rankSessionChips", () => {
  it("caps at 5, drops reads when the session produced anything, ranks role→recency→kind", () => {
    const rows = [
      row("a","create","2026-01-06","notes"), row("b","create","2026-01-05","deck"),
      row("c","modify","2026-01-04","notes"), row("d","modify","2026-01-03","wireframe"),
      row("e","create","2026-01-02","notes"), row("f","modify","2026-01-01","table"),
      row("r1","read","2026-01-09","notes"), row("r2","read","2026-01-08","notes"),
    ];
    const chips = rankSessionChips(rows);
    expect(chips).toHaveLength(5);
    expect(chips.every((c) => c.role !== "read")).toBe(true);
    expect(chips[0].role).toBe("create");
    expect(chips[0].artifactId).toBe("a");
  });
  it("falls back to read chips only when nothing was produced", () => {
    const chips = rankSessionChips([row("r1","read","2026-01-09","notes"), row("r2","read","2026-01-08","deck")]);
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.role === "read")).toBe(true);
  });
  it("dedupes one artifact to its strongest role", () => {
    const chips = rankSessionChips([row("a","read","2026-01-09","notes"), row("a","create","2026-01-01","notes")]);
    expect(chips).toHaveLength(1);
    expect(chips[0].role).toBe("create");
  });
  it("breaks role+recency ties by kind (presentation kinds before notes)", () => {
    const chips = rankSessionChips([
      row("plain","create","2026-01-01","notes"),
      row("fancy","create","2026-01-01","deck"),
    ]);
    expect(chips[0].artifactId).toBe("fancy");
  });
});

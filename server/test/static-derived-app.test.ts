import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunnableApp, buildLaunchArgv } from "../src/runnable-app.js";

// The route's derived branch is `resolveRunnableApp(project)` + `buildLaunchArgv`.
// Pin that contract: a vite project resolves and produces a runnable argv.
describe("static route derived-app resolution contract", () => {
  it("resolves a projectId-shaped project to a launchable argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-route-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const project = { id: "p9", name: "Site", spaceId: "work", recentPath: dir };
    const r = resolveRunnableApp(project);
    expect(r.app?.id).toBe("app:p9");
    const argv = buildLaunchArgv(r.app!.framework, 4501);
    expect(argv).toEqual(["npm", "run", "dev", "--", "--port", "4501", "--strictPort"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

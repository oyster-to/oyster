import { describe, it, expect, afterEach } from "vitest";
import {
  startAppById, stopAppById, getRunningApp, findFreePort, isPortOpen,
} from "../src/process-manager.js";

const started: string[] = [];
afterEach(() => { for (const id of started.splice(0)) stopAppById(id); });

describe("derived-app runtime", () => {
  it("records a running app, then clears it on exit", async () => {
    const port = await findFreePort();
    startAppById("app:test-1", ["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), port);
    started.push("app:test-1");
    expect(getRunningApp("app:test-1")).toMatchObject({ port });

    const stopped = stopAppById("app:test-1");
    expect(stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(getRunningApp("app:test-1")).toBeUndefined();
  });

  it("clears the entry when the child errors (bad binary)", async () => {
    startAppById("app:test-2", ["this-binary-does-not-exist-xyz"], process.cwd(), 65000);
    await new Promise((r) => setTimeout(r, 50));
    expect(getRunningApp("app:test-2")).toBeUndefined();
  });

  it("findFreePort skips Oyster's own ports", async () => {
    const p = await findFreePort();
    expect(p).not.toBe(3333);
    expect(p).not.toBe(4444);
    expect(await isPortOpen(p)).toBe(false);
  });

  it("start is idempotent for the same appId", async () => {
    const port = await findFreePort();
    startAppById("app:test-3", ["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), port);
    started.push("app:test-3");
    const first = getRunningApp("app:test-3");
    startAppById("app:test-3", ["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), 9999);
    expect(getRunningApp("app:test-3")).toBe(first); // unchanged
  });
});

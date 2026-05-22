import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The route reads ~/.local/share/opencode/auth.json. To test deterministically
// we point HOME at a temp dir, then assert the route's response by importing
// the handler in isolation rather than booting the full server.
import { getProviderStatus } from "../src/routes/provider-status.js";

describe("provider-status", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "oyster-provider-status-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("returns configured: false when auth.json is absent", () => {
    expect(getProviderStatus()).toEqual({ configured: false });
  });

  it("returns configured: false when auth.json is empty object", () => {
    const authDir = join(tmpHome, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), "{}");
    expect(getProviderStatus()).toEqual({ configured: false });
  });

  it("returns configured: true when auth.json has at least one provider", () => {
    const authDir = join(tmpHome, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ anthropic: { api: "sk-..." } }));
    expect(getProviderStatus()).toEqual({ configured: true });
  });

  it("returns configured: false when auth.json is malformed", () => {
    const authDir = join(tmpHome, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), "not json");
    expect(getProviderStatus()).toEqual({ configured: false });
  });

  it("returns configured: true when ANTHROPIC_API_KEY is in env (env-key bypass)", () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      expect(getProviderStatus()).toEqual({ configured: true });
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

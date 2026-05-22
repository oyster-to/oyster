import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The route reads ~/.local/share/opencode/auth.json. To test deterministically
// we point HOME at a temp dir, then assert the route's response by importing
// the handler in isolation rather than booting the full server.
import { getProviderStatus } from "../src/routes/provider-status.js";

describe("provider-status", () => {
  const ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
  ] as const;

  let tmpHome: string;
  let originalHome: string | undefined;
  let savedKeys: Partial<Record<typeof ENV_KEYS[number], string>>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "oyster-provider-status-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;

    // Clear any AI provider keys from the developer's environment so the
    // file-system-path tests aren't shortcut by the env-var bypass.
    savedKeys = {};
    for (const k of ENV_KEYS) {
      if (process.env[k] !== undefined) savedKeys[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    for (const k of ENV_KEYS) {
      if (k in savedKeys) process.env[k] = savedKeys[k];
      else delete process.env[k];
    }
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
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(getProviderStatus()).toEqual({ configured: true });
  });
});

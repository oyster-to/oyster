import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveArtifactsUrl } from "../src/routes/static.js";

// Builds a fake Oyster layout under a tmp dir:
//   <root>/Oyster/{apps,spaces}/...
// Tests then call resolveArtifactsUrl with that layout to exercise the
// multi-root containment + traversal guard logic.
function makeLayout() {
  const tmp = mkdtempSync(join(tmpdir(), "oyster-resolve-test-"));
  const oysterHome = join(tmp, "Oyster");
  const appsDir = join(oysterHome, "apps");
  const spacesDir = join(oysterHome, "spaces");
  mkdirSync(appsDir, { recursive: true });
  mkdirSync(spacesDir, { recursive: true });
  return { tmp, layout: { oysterHome, appsDir, spacesDir } };
}

describe("resolveArtifactsUrl", () => {
  let tmp: string;
  let layout: { oysterHome: string; appsDir: string; spacesDir: string };

  beforeEach(() => {
    ({ tmp, layout } = makeLayout());
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("happy path resolution", () => {
    it("resolves a file under OYSTER_HOME directly", () => {
      mkdirSync(join(layout.oysterHome, "icons", "abc"), { recursive: true });
      const file = join(layout.oysterHome, "icons", "abc", "icon.png");
      writeFileSync(file, "x");
      expect(resolveArtifactsUrl("icons/abc/icon.png", layout)).toBe(file);
    });

    it("resolves a file under APPS_DIR", () => {
      mkdirSync(join(layout.appsDir, "calculator"), { recursive: true });
      const file = join(layout.appsDir, "calculator", "icon.png");
      writeFileSync(file, "x");
      expect(resolveArtifactsUrl("calculator/icon.png", layout)).toBe(file);
    });

    it("resolves a file under SPACES_DIR (rel starts with space name)", () => {
      mkdirSync(join(layout.spacesDir, "home", "snake-game"), { recursive: true });
      const file = join(layout.spacesDir, "home", "snake-game", "icon.png");
      writeFileSync(file, "x");
      expect(resolveArtifactsUrl("home/snake-game/icon.png", layout)).toBe(file);
    });

    it("falls back to walking SPACES_DIR/<space>/<rel> for AI-generated bundles", () => {
      // Simulates the AI-generated bundle case where the URL is just
      // /artifacts/<bundle>/icon.png with no space hint.
      mkdirSync(join(layout.spacesDir, "home", "snake-game"), { recursive: true });
      const file = join(layout.spacesDir, "home", "snake-game", "icon.png");
      writeFileSync(file, "x");
      expect(resolveArtifactsUrl("snake-game/icon.png", layout)).toBe(file);
    });
  });

  describe("containment guard", () => {
    it("rejects sibling-prefix paths (the OysterX vs Oyster trap)", () => {
      // Layout has oysterHome at <tmp>/Oyster. Create a sibling <tmp>/OysterX
      // with a real file inside, then ask for a relative path that, when
      // joined naively, would walk into OysterX.
      const sibling = join(tmp, "OysterX");
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "secret.txt"), "leak");
      expect(resolveArtifactsUrl("../OysterX/secret.txt", layout)).toBeNull();
    });

    it("rejects ../-based traversal that escapes OYSTER_HOME", () => {
      // Create a file outside OYSTER_HOME entirely.
      const escape = join(tmp, "outside.txt");
      writeFileSync(escape, "leak");
      expect(resolveArtifactsUrl("../outside.txt", layout)).toBeNull();
    });

    it("allows a path that resolves to OYSTER_HOME itself only when it's a real file (it isn't here)", () => {
      // Edge: relativePath=""  → join produces oysterHome itself (a directory).
      // Should return null because directories aren't served.
      expect(resolveArtifactsUrl("", layout)).toBeNull();
    });
  });

  // Relay merge gate (spec 2026-06-07-device-relay-design §security):
  // /artifacts/<path> is reachable through the device relay now, not just
  // loopback. Lexical checks are not containment — these pin the
  // realpath layer. Note the tmp dir itself sits behind a symlink on
  // macOS (/var → /private/var), so every happy-path test above also
  // proves the root is realpath'd (a lexical-root comparison would fail
  // them all).
  describe("symlink containment (relay merge gate)", () => {
    it("rejects a symlinked FILE inside ~/Oyster pointing outside it", () => {
      const target = join(tmp, "outside-secret.txt");
      writeFileSync(target, "leak");
      mkdirSync(join(layout.spacesDir, "home"), { recursive: true });
      symlinkSync(target, join(layout.spacesDir, "home", "innocent.md"));
      expect(resolveArtifactsUrl("home/innocent.md", layout)).toBeNull();
    });

    it("rejects files under a symlinked DIRECTORY pointing outside ~/Oyster", () => {
      const outsideDir = join(tmp, "outside-dir");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "creds.json"), "leak");
      symlinkSync(outsideDir, join(layout.spacesDir, "linked"));
      expect(resolveArtifactsUrl("linked/creds.json", layout)).toBeNull();
    });

    it("still serves a symlink whose target stays INSIDE ~/Oyster", () => {
      mkdirSync(join(layout.spacesDir, "home"), { recursive: true });
      const real = join(layout.spacesDir, "home", "real.md");
      writeFileSync(real, "# fine");
      symlinkSync(real, join(layout.spacesDir, "home", "alias.md"));
      expect(resolveArtifactsUrl("home/alias.md", layout)).toBe(
        join(layout.spacesDir, "home", "alias.md"),
      );
    });
  });

  describe("encoded / injected paths (relay merge gate)", () => {
    it("does not decode percent-encoding — %2e%2e is a literal filename, not a traversal", () => {
      const escape = join(tmp, "outside.txt");
      writeFileSync(escape, "leak");
      // No decode layer exists in this resolver (req.url arrives raw and
      // is passed through) — the encoded form must not escape.
      expect(resolveArtifactsUrl("%2e%2e/outside.txt", layout)).toBeNull();
      expect(resolveArtifactsUrl("%252e%252e/outside.txt", layout)).toBeNull();
    });

    it("rejects absolute-path injection", () => {
      // join() makes these relative to the roots, so they can only
      // resolve inside — assert they don't accidentally hit /etc.
      expect(resolveArtifactsUrl("/etc/hosts", layout)).toBeNull();
      expect(resolveArtifactsUrl("//etc/hosts", layout)).toBeNull();
    });

    it("treats backslash sequences as literal file names, not separators", () => {
      const escape = join(tmp, "outside.txt");
      writeFileSync(escape, "leak");
      expect(resolveArtifactsUrl("..\\outside.txt", layout)).toBeNull();
    });
  });

  describe("file-vs-directory", () => {
    it("returns null when the resolved path is a directory, not a file", () => {
      mkdirSync(join(layout.appsDir, "calculator"), { recursive: true });
      // No file inside — just the dir.
      expect(resolveArtifactsUrl("calculator", layout)).toBeNull();
    });

    it("returns null when the file does not exist", () => {
      expect(resolveArtifactsUrl("nope/missing.png", layout)).toBeNull();
    });
  });

  describe("spaces-walk fallback edges", () => {
    it("does NOT fall through to spaces-walk when first segment is 'icons'", () => {
      // Shape an existing file under spaces/<space>/icons/foo.png — the
      // walk would otherwise find it. The guard short-circuits that.
      mkdirSync(join(layout.spacesDir, "home", "icons"), { recursive: true });
      const file = join(layout.spacesDir, "home", "icons", "foo.png");
      writeFileSync(file, "x");
      // The fixedCandidates loop will check OYSTER_HOME/icons/foo.png and
      // SPACES_DIR/icons/foo.png — neither exists, so we'd normally fall
      // through. But firstSegment === "icons" short-circuits the walk.
      expect(resolveArtifactsUrl("icons/foo.png", layout)).toBeNull();
    });

    it("returns null gracefully when SPACES_DIR is missing entirely", () => {
      rmSync(layout.spacesDir, { recursive: true, force: true });
      expect(resolveArtifactsUrl("anything/icon.png", layout)).toBeNull();
    });

    it("returns null when no space directory contains the requested bundle", () => {
      mkdirSync(join(layout.spacesDir, "home"), { recursive: true });
      mkdirSync(join(layout.spacesDir, "work"), { recursive: true });
      expect(resolveArtifactsUrl("does-not-exist/icon.png", layout)).toBeNull();
    });
  });
});

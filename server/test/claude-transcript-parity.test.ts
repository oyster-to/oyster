import { describe, it, expect } from "vitest";
import { renderEvent, displayTouchPath } from "../src/watchers/claude-code.js";
import { isClaudeProtocolArtifact } from "../src/utils/claude-protocol-artifacts.js";

const CWD = "/Users/test/Dev/proj";

describe("renderEvent parity", () => {
  it("renders a plain user message", () => {
    expect(renderEvent({ type: "user", message: { content: "hello world" } }))
      .toEqual({ role: "user", text: "hello world" });
  });

  it("renders a tool_result wrapper (string content)", () => {
    const ev = { type: "user", message: { content: [{ type: "tool_result", content: "ok done" }] } };
    expect(renderEvent(ev)).toEqual({ role: "tool_result", text: "ok done" });
  });

  it("renders a tool_result wrapper (array content)", () => {
    const ev = { type: "user", message: { content: [{ type: "tool_result", content: [{ text: "a" }, { text: "b" }] }] } };
    expect(renderEvent(ev)).toEqual({ role: "tool_result", text: "ab" });
  });

  it("renders assistant text + tool_use with file path relative to cwd", () => {
    const ev = {
      type: "assistant",
      message: { content: [
        { type: "text", text: "Editing now." },
        { type: "tool_use", name: "Edit", input: { file_path: `${CWD}/src/a.ts` } },
      ] },
    };
    expect(renderEvent(ev, CWD)).toEqual({ role: "assistant", text: "Editing now. [Edit src/a.ts]" });
  });

  it("renders a pure tool_use turn as role tool", () => {
    const ev = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } };
    expect(renderEvent(ev, CWD)).toEqual({ role: "tool", text: "[Bash]" });
  });

  it("renders empty assistant turns as (thinking)", () => {
    // Only truly-empty content (no text blocks with any characters) triggers (thinking).
    // A whitespace-only text block is still truthy and passes through as-is.
    const ev = { type: "assistant", message: { content: [{ type: "thinking", thinking: "internal" }] } };
    expect(renderEvent(ev)).toEqual({ role: "assistant", text: "(thinking)" });
  });

  it("renders system events as subtype: content", () => {
    expect(renderEvent({ type: "system", subtype: "warn", content: "low disk" }))
      .toEqual({ role: "system", text: "warn: low disk" });
  });

  it("skips unknown event types", () => {
    expect(renderEvent({ type: "file-history-snapshot", snapshot: {} })).toBeNull();
    expect(renderEvent({ type: "summary", summary: "..." })).toBeNull();
  });

  it("classifies protocol artifacts", () => {
    expect(isClaudeProtocolArtifact("<command-name>/exit</command-name>")).toBe(true);
    expect(isClaudeProtocolArtifact("  <system-reminder>x</system-reminder>")).toBe(true);
    expect(isClaudeProtocolArtifact("local_command: foo")).toBe(true);
    expect(isClaudeProtocolArtifact("normal message about <command-name>")).toBe(false);
  });
});

describe("displayTouchPath parity", () => {
  it("relativises paths under cwd", () => {
    expect(displayTouchPath(`${CWD}/deep/file.ts`, CWD)).toBe("deep/file.ts");
  });
  it("falls back to absolute for unrelated paths", () => {
    expect(displayTouchPath("/etc/hosts", CWD)).toBe("/etc/hosts");
  });
  it("collapses the home dir to ~", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    expect(displayTouchPath(`${home}/notes.md`, null)).toBe("~/notes.md");
  });
});

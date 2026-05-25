import { describe, it, expect } from "vitest";
import { renderEvent, artifactTouchFromToolUse } from "../src/watchers/claude-code.js";

const toolUse = (name: string, file: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: { file_path: file } }] },
});

const notebookEdit = (notebookPath: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: notebookPath } }] },
});

describe("renderEvent embeds relative file paths", () => {
  it("renders a Write under cwd as a relative path", () => {
    const r = renderEvent(toolUse("Write", "/repo/src/App.jsx"), "/repo");
    expect(r?.text).toContain("App.jsx");
    expect(r?.text).toBe("[Write src/App.jsx]");
  });
  it("collapses a path under HOME but outside cwd to ~", () => {
    const home = process.env.HOME!;
    const r = renderEvent(toolUse("Read", `${home}/.claude/settings.json`), "/repo");
    expect(r?.text).toBe("[Read ~/.claude/settings.json]");
  });
  it("covers Edit / MultiEdit / NotebookEdit", () => {
    expect(renderEvent(toolUse("Edit", "/repo/a.md"), "/repo")?.text).toBe("[Edit a.md]");
    expect(renderEvent(toolUse("MultiEdit", "/repo/a.md"), "/repo")?.text).toBe("[MultiEdit a.md]");
    // NotebookEdit uses notebook_path (not file_path) — path must still be embedded.
    expect(renderEvent(notebookEdit("/repo/n.ipynb"), "/repo")?.text).toBe("[NotebookEdit n.ipynb]");
  });
  it("still renders non-path tool calls and prose unchanged", () => {
    const bash = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } };
    expect(renderEvent(bash, "/repo")?.text).toBe("[Bash]");
  });
  it("renders without cwd (backward-compat) as an absolute path", () => {
    const r = renderEvent(toolUse("Write", "/repo/src/App.jsx"));
    expect(r?.text).toBe("[Write /repo/src/App.jsx]");
  });
});

describe("artifactTouchFromToolUse — tool coverage", () => {
  const block = (name: string, input: Record<string, string>) => ({
    type: "tool_use",
    name,
    input,
  });

  it("MultiEdit with file_path → modify", () => {
    const t = artifactTouchFromToolUse(block("MultiEdit", { file_path: "/repo/a.md" }));
    expect(t).toEqual({ path: "/repo/a.md", role: "modify" });
  });

  it("NotebookEdit with notebook_path → modify", () => {
    const t = artifactTouchFromToolUse(block("NotebookEdit", { notebook_path: "/repo/n.ipynb" }));
    expect(t).toEqual({ path: "/repo/n.ipynb", role: "modify" });
  });

  it("Edit, Write, Read continue to work as before", () => {
    expect(artifactTouchFromToolUse(block("Edit", { file_path: "/f.md" }))).toEqual({ path: "/f.md", role: "modify" });
    expect(artifactTouchFromToolUse(block("Write", { file_path: "/f.md" }))).toEqual({ path: "/f.md", role: "create" });
    expect(artifactTouchFromToolUse(block("Read", { file_path: "/f.md" }))).toEqual({ path: "/f.md", role: "read" });
  });

  it("unknown tool → null", () => {
    expect(artifactTouchFromToolUse(block("Bash", { command: "ls" }))).toBeNull();
  });
});

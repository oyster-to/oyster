import { describe, it, expect } from "vitest";
import { renderEvent } from "../src/watchers/claude-code.js";

const toolUse = (name: string, file: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: { file_path: file } }] },
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
    expect(renderEvent(toolUse("NotebookEdit", "/repo/n.ipynb"), "/repo")?.text).toBe("[NotebookEdit n.ipynb]");
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

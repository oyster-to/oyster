import { describe, it, expect } from "vitest";
import { classifyOutput } from "../src/output-classifier.js";

describe("classifyOutput", () => {
  it("classifies allowed output types by extension", () => {
    expect(classifyOutput("/r/report.md")).toBe("notes");
    expect(classifyOutput("/r/data.csv")).toBe("table");
    expect(classifyOutput("/r/deck.pdf")).toBe("deck");
    expect(classifyOutput("/r/diagram.mmd")).toBe("diagram");
    expect(classifyOutput("/r/page.html")).toBe("wireframe");
    expect(classifyOutput("/r/nb.ipynb")).toBe("notes"); // .ipynb → notes (no "notebook" kind)
  });
  it("rejects source code and unknown extensions", () => {
    expect(classifyOutput("/r/src/App.tsx")).toBeNull();
    expect(classifyOutput("/r/main.py")).toBeNull();
    expect(classifyOutput("/r/Makefile")).toBeNull();
    expect(classifyOutput("/r/data.bin")).toBeNull();
  });
  it("rejects images in v1", () => {
    expect(classifyOutput("/r/logo.png")).toBeNull();
    expect(classifyOutput("/r/icon.svg")).toBeNull();
  });
  it("applies the secret/noise/vendor deny-list even to allowed extensions", () => {
    expect(classifyOutput("/r/.env")).toBeNull();
    expect(classifyOutput("/r/secrets/notes.md")).toBeNull();
    expect(classifyOutput("/r/node_modules/foo/readme.md")).toBeNull();
    expect(classifyOutput("/r/dist/index.html")).toBeNull();
    expect(classifyOutput("/r/.cache/x.md")).toBeNull();
    expect(classifyOutput("/tmp/scratch.md")).toBeNull();
    expect(classifyOutput("/r/.git/COMMIT_EDITMSG.md")).toBeNull();
    expect(classifyOutput(process.env.HOME + "/.ssh/notes.md")).toBeNull();
    // .key is denied by DENY_NAME (private keys); Keynote bundles aren't single files.
    expect(classifyOutput("/r/presentation.key")).toBeNull();
  });
  it("handles Windows backslash separators correctly", () => {
    // Vendor path with backslashes → denied
    expect(classifyOutput("C:\\repo\\node_modules\\foo\\readme.md")).toBeNull();
    // Clean output path with backslashes → classified
    expect(classifyOutput("C:\\repo\\report.md")).toBe("notes");
  });
});

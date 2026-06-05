// claude-transcript.ts — pure JSONL→event transform for Claude Code session
// transcripts. Shared between the local server's ingest watcher
// (server/src/watchers/claude-code.ts) and the cloud worker's read path
// (infra/oyster-cloud), so local and remote rendering cannot diverge.
//
// SCOPE GUARD: parsing + rendering ONLY. Display-state, output
// classification and artifact registration stay in server/src — if a
// change here needs a DB type or a node API, it belongs on the server.
// Runs in Node and in Workers: no node:* imports, no process.env.

export type TranscriptRole = "user" | "assistant" | "tool" | "tool_result" | "system";

export interface RenderedEvent {
  role: TranscriptRole;
  text: string;
}

export function safeParse(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Claude Code wraps slash-command machinery in two shapes:
//
//   1. Pseudo-`user` messages — `<command-name>/exit</command-name>`,
//      `<local-command-stdout>Goodbye!`, `<system-reminder>The user named
//      this session "…"</system-reminder>`.
//   2. `system` events with `subtype = "local_command"` — renderEvent
//      stringifies these as `local_command: <command-name>…` (the wrapper
//      tag is no longer the leading token, so the prefix checks above miss
//      them). See #536.
//
// They were never typed by the user and were never said by the assistant;
// they're protocol artefacts. We classify them at ingest so the transcript
// reader and search index can ignore them while the raw rows stay on disk.
//
// Match is intentionally prefix-only: a real message that happens to *contain*
// these strings (e.g. someone pasting a snippet about slash-commands) should
// still render. Only events whose leading non-whitespace token is one of these
// wrappers, or whose text begins with the `local_command:` subtype label,
// get classified out.
//
// Assistant messages can legitimately echo a slash command (`/rename ...`).
// Those start with `/`, never match any of the prefixes below, and stay
// visible regardless of the caller's role gate.
export function isClaudeProtocolArtifact(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<local-command-")
    || trimmed.startsWith("<command-")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("local_command:")
  );
}

/** Display form for a touched file path: relative to the session cwd when
 *  under it; else ~-collapsed when `home` is provided; else absolute.
 *  Portable replacement for the node:path version — a pure prefix check,
 *  equivalent for the normalized absolute paths Claude Code emits. */
export function displayTouchPath(filePath: string, cwd?: string | null, home?: string | null): string {
  if (cwd) {
    const base = cwd.endsWith("/") ? cwd : cwd + "/";
    if (filePath.startsWith(base) && filePath.length > base.length) {
      return filePath.slice(base.length);
    }
  }
  if (home) {
    const fp = filePath.replace(/\\/g, "/");
    const h = home.replace(/\\/g, "/");
    if (fp === h || fp.startsWith(h + "/")) return "~" + fp.slice(h.length);
  }
  return filePath;
}

// Map a raw JSONL event to a (role, text) pair the home feed can render.
// Returns null for events we deliberately skip (file-history-snapshot,
// last-prompt, attachment metadata, etc — useful in `raw` only).
export function renderEvent(ev: Record<string, any>, cwd?: string | null, home?: string | null): RenderedEvent | null {
  switch (ev.type) {
    case "user": {
      const content = ev.message?.content;
      if (typeof content === "string") {
        return { role: "user", text: content };
      }
      if (Array.isArray(content)) {
        // user-typed array events are tool_result wrappers
        const first = content.find((b) => b?.type === "tool_result");
        if (first) {
          const inner = typeof first.content === "string"
            ? first.content
            : Array.isArray(first.content)
              ? first.content
                  .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
                  .join("")
              : "";
          return { role: "tool_result", text: inner || "(tool result)" };
        }
      }
      return null;
    }
    case "assistant": {
      const blocks = ev.message?.content;
      if (!Array.isArray(blocks)) return null;
      const hasText = blocks.some(
        (b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
      );
      const hasToolUse = blocks.some((b: any) => b?.type === "tool_use" && typeof b.name === "string");
      // Pure tool-call turns (no text blocks, only tool_use) are tool calls
      // semantically — the "ASSISTANT [Bash]" rendering was misleading. Mark
      // them as `tool` so the inspector renders them as collapsible tool
      // turns, matching tool_result on the other side.
      if (!hasText && hasToolUse) {
        const toolTexts = blocks
          .filter((b: any) => b?.type === "tool_use" && typeof b.name === "string")
          .map((b: any) => {
            const filePath = typeof b.input?.file_path === "string"
              ? b.input.file_path
              : typeof b.input?.notebook_path === "string"
                ? b.input.notebook_path
                : null;
            return filePath ? `[${b.name} ${displayTouchPath(filePath, cwd, home)}]` : `[${b.name}]`;
          });
        return { role: "tool", text: toolTexts.join(" ") };
      }
      const text = blocks
        .map((b: any) => {
          if (b?.type === "text" && typeof b.text === "string") return b.text;
          if (b?.type === "tool_use" && typeof b.name === "string") {
            const filePath = typeof b.input?.file_path === "string"
              ? b.input.file_path
              : typeof b.input?.notebook_path === "string"
                ? b.input.notebook_path
                : null;
            return filePath ? `[${b.name} ${displayTouchPath(filePath, cwd, home)}]` : `[${b.name}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");
      // Pure-thinking turns produce empty text — store the marker so timeline
      // doesn't silently lose them.
      return { role: "assistant", text: text || "(thinking)" };
    }
    case "system": {
      const subtype = typeof ev.subtype === "string" ? ev.subtype : "system";
      const content = typeof ev.content === "string" ? ev.content : "";
      return { role: "system", text: content ? `${subtype}: ${content}` : subtype };
    }
    default:
      return null;
  }
}

// Chat event fan-out. We maintain a single upstream subscription to
// opencode's /global/event SSE endpoint (in opencode-manager) and emit each
// event into the shared /api/ui/events stream as a `{command:"chat"}`
// envelope — one SSE connection per tab instead of a dedicated chat stream.
// (Chrome caps HTTP/1.1 at 6 connections per origin; with two streams per
// tab, three Oyster tabs stalled every fetch on the origin.) This module
// also lets us inject server-originated synthetic events (e.g. from stderr
// pattern matches in #203) alongside proxied ones.

type SyntheticEvent = { type: string; properties?: Record<string, unknown> };

// Injected by index.ts at startup (wraps broadcastUiEvent). Indirection
// avoids a circular import — index.ts owns the ui-events client set.
let sink: ((event: unknown) => void) | null = null;

export function setChatEventSink(fn: (event: unknown) => void) {
  sink = fn;
}

/** Emit one opencode (or synthetic) chat event to all connected browsers
 *  via the shared ui-events stream. No-op before the sink is wired. */
export function emitChatEvent(event: unknown) {
  sink?.(event);
}

export function broadcastSynthetic(event: SyntheticEvent) {
  emitChatEvent(event);
}

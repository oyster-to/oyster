// Shared EventSource subscription for `/api/ui/events`.
import { apiPath } from "./http";
import { caps } from "../caps";
//
// Multiple components (App, OnboardingDock) care about different slices of
// the same SSE stream — a per-component `new EventSource(...)` would open
// N connections to the same endpoint and parse every message N times. This
// module opens a single connection on first subscribe and closes it when
// the last subscribers unsubscribes.
//
// Cloud mode has no SSE endpoint. When caps.hasSse is false, we run a
// visible-tab poller that emits a synthetic `session_changed` every 12 s so
// the UI stays roughly fresh without a persistent connection.

export interface UiEvent {
  command: string;
  payload: unknown;
}

type Listener = (event: UiEvent) => void;

let es: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 12_000;
const listeners = new Set<Listener>();

function emit(event: UiEvent) {
  for (const l of listeners) {
    try { l(event); } catch { /* isolate one bad listener from others */ }
  }
}

function handleMessage(e: MessageEvent) {
  let parsed: UiEvent;
  try {
    parsed = JSON.parse(e.data) as UiEvent;
  } catch {
    return; // malformed event — drop
  }
  emit(parsed);
}

function startPoll() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    if (listeners.size > 0) {
      // id: "" is a broadcast sentinel — id-filtered consumers (SessionInspector
      // live-update) deliberately ignore it; the inspector's own manifest poll
      // drives transcript freshness in cloud mode.
      emit({ command: "session_changed", payload: { id: "" } });
    }
  }, POLL_INTERVAL_MS);
}

function stopPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensureConnection() {
  if (!caps.hasSse) {
    // Polling path: start lazily, pause when hidden.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    startPoll();
    return;
  }
  if (es && es.readyState !== EventSource.CLOSED) return;
  if (es) es.close();
  es = new EventSource(apiPath("/api/ui/events"));
  es.onmessage = handleMessage;
  // EventSource auto-reconnects on transport errors, but a half-open
  // connection (server crash, proxy timeout) can leave readyState stuck.
  // Force a fresh connect on error so listeners aren't silently stranded.
  es.onerror = () => {
    if (es && es.readyState === EventSource.CLOSED) {
      es = null;
      if (listeners.size > 0) ensureConnection();
    }
  };
}

// When the tab returns to the foreground, replay a synthetic event so
// any listener that refetches on, say, `session_changed` gets fresh data
// — covers the case where the OS or proxy dropped our connection while
// the tab was backgrounded and we missed real events. Cheap: each
// refetch is a small JSON GET.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      // Pause the poller while hidden to avoid wasted requests.
      if (!caps.hasSse) stopPoll();
      return;
    }
    // Tab is now visible — reconnect SSE or restart poll, then freshen.
    if (listeners.size > 0) ensureConnection();
    emit({ command: "session_changed", payload: { id: "" } });
  });
}

export function subscribeUiEvents(listener: Listener): () => void {
  listeners.add(listener);
  ensureConnection();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (es) {
        es.close();
        es = null;
      }
      stopPoll();
    }
  };
}

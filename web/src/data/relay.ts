// relay.ts — device relay status store + helpers for the cloud remote view
// (spec 2026-06-07-device-relay-design). The worker's per-user RelayDO
// tracks which of the user's devices hold a live socket; this module polls
// GET /api/relay/status (30s, visibility-aware — mirrors ui-events.ts'
// cloud poller) and exposes:
//
//   subscribeRelay(fn)        — store subscription for UI (presence chip)
//   getRelayState()           — current snapshot
//   freshRelayState(signal)   — snapshot ≤10s old, fetching if needed
//                               (data-layer callers: artifacts enrichment,
//                               ⌘K fan-out)
//   relayPath(deviceId, path) — /api/relay/d/<id><path>
//   disable/enableRelayDevice — the per-device kill switch
//
// Everything no-ops outside cloud mode.

import { caps } from "../caps";
import { getJson, postEmpty, apiPath } from "./http";

export interface RelayDevice {
  device_id: string;
  device_label: string | null;
  connected_at: number;
  /** False until the device's hello frame lands — not forwardable yet. */
  ready: boolean;
}

export interface RelayDisabledDevice {
  device_id: string;
  device_label: string | null;
  disabled_at: number;
}

export interface RelayState {
  online: RelayDevice[];
  disabled: RelayDisabledDevice[];
}

const POLL_INTERVAL_MS = 30_000;
/** freshRelayState reuses the last poll within this window so data-layer
 *  callers (artefact list, ⌘K) don't add a status request per call. */
const FRESH_TTL_MS = 10_000;

let state: RelayState = { online: [], disabled: [] };
let fetchedAt = 0;
let inFlight: Promise<RelayState> | null = null;
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const fn of listeners) {
    try { fn(); }
    catch (err) {
      // One broken subscriber must not starve the others or break the
      // poll flow that triggered the emit (same posture as ui-events).
      console.warn("[relay] listener failed:", err);
    }
  }
}

/** Combine a caller's signal with a per-request timeout — used by the
 *  fan-out callers (artefact enrichment, ⌘K) so one wedged device can't
 *  stall a whole surface. AbortSignal.any is baseline in the browsers the
 *  cloud build targets; the fallback drops the timeout, never the signal. */
export function withRelayTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  if (typeof AbortSignal.any !== "function" || typeof AbortSignal.timeout !== "function") return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function fetchStatus(signal?: AbortSignal): Promise<RelayState> {
  const data = await getJson<RelayState>(apiPath("/api/relay/status"), signal);
  state = {
    online: data.online ?? [],
    disabled: data.disabled ?? [],
  };
  fetchedAt = Date.now();
  emit();
  return state;
}

export function getRelayState(): RelayState {
  return state;
}

/** Online devices that can actually serve requests. */
export function onlineRelayDevices(): RelayDevice[] {
  return state.online.filter((d) => d.ready);
}

/** A snapshot no older than FRESH_TTL_MS, fetching if needed. Coalesces
 *  concurrent callers onto one request. Returns the stale snapshot on
 *  fetch failure — relay is progressive enhancement; callers degrade to
 *  the mirror, never to an error. */
export async function freshRelayState(signal?: AbortSignal): Promise<RelayState> {
  if (!caps.cloud) return state;
  if (Date.now() - fetchedAt < FRESH_TTL_MS) return state;
  if (!inFlight) {
    inFlight = fetchStatus(signal).finally(() => { inFlight = null; });
  }
  try {
    return await inFlight;
  } catch {
    return state;
  }
}

export function relayPath(deviceId: string, path: string): string {
  return apiPath(`/api/relay/d/${encodeURIComponent(deviceId)}${path}`);
}

export async function disableRelayDevice(deviceId: string): Promise<void> {
  await postEmpty(apiPath(`/api/relay/devices/${encodeURIComponent(deviceId)}/disable`));
  fetchedAt = 0;
  void freshRelayState();
}

export async function enableRelayDevice(deviceId: string): Promise<void> {
  await postEmpty(apiPath(`/api/relay/devices/${encodeURIComponent(deviceId)}/enable`));
  fetchedAt = 0;
  void freshRelayState();
}

function startPoll(): void {
  if (pollTimer !== null) return;
  void freshRelayState();
  pollTimer = setInterval(() => {
    if (listeners.size === 0) return;
    fetchedAt = 0; // force a real fetch each tick
    void freshRelayState();
  }, POLL_INTERVAL_MS);
}

function stopPoll(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

/** Subscribe to relay state changes. Starts the poller on the first
 *  subscriber (cloud only); stops on the last unsubscribe. Pauses while
 *  the tab is hidden, refreshes immediately on return — same posture as
 *  ui-events.ts' cloud poll. */
export function subscribeRelay(listener: () => void): () => void {
  if (!caps.cloud) return () => { /* no-op outside cloud */ };
  listeners.add(listener);
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    startPoll();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopPoll();
  };
}

if (caps.cloud && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (listeners.size > 0) { fetchedAt = 0; startPoll(); void freshRelayState(); }
    } else {
      stopPoll();
    }
  });
}

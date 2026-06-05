// cloud-sessions.ts — maps the oyster-cloud worker's snake_case session
// metadata into the local Session shape so the component tree is unchanged.
// Field mapping mirrors the local server's own cloud-merge
// (server/src/routes/sessions.ts:379-415) — keep them aligned.
import type { Session } from "../../../shared/types";
import { getJson, apiPath } from "./http";

interface CloudSessionMeta {
  session_id: string;
  device_id: string | null;
  device_label: string | null;
  agent: string;
  title: string | null;
  state: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  has_bytes: boolean;
  total_bytes: number;
  active_device_id: string | null;
  space_id?: string | null;
  project_id?: string | null;
}

function toSession(m: CloudSessionMeta): Session {
  return {
    id: m.session_id,
    spaceId: m.space_id ?? null,
    projectId: m.project_id ?? null,
    cwd: m.cwd,
    agent: m.agent,
    title: m.title,
    state: m.state,
    displayState: m.state,  // no probe evidence remotely; state is the signal
    displayReason: m.device_label ?? "",
    startedAt: m.started_at,
    endedAt: m.ended_at,
    model: m.model,
    lastEventAt: m.last_event_at,
    originDeviceId: m.device_id,
    originDeviceLabel: m.device_label,
    jsonlAvailableLocally: false,
    hasBytes: m.has_bytes,
    activeDeviceId: m.active_device_id,
    activeDeviceLabel: null,
    terminalId: null,
    terminalAttachedClients: 0,
    // cast: cloud metadata carries agent/state as plain strings; runtime
    // values match the unions
  } as Session;
}

let cache: { at: number; sessions: Session[] } | null = null;
const CACHE_MS = 3_000; // collapse the fetchSessions + fetchSession(id) pair

export async function fetchCloudSessions(signal?: AbortSignal): Promise<Session[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.sessions;
  const data = await getJson<{ sessions: CloudSessionMeta[] }>(
    apiPath("/api/sessions/metadata"), signal,
  );
  const sessions = (data.sessions ?? []).map(toSession);
  if (!signal?.aborted) cache = { at: Date.now(), sessions };
  return sessions;
}

/** Exported so sessions-api.ts can wrap the 404 into SessionNotFoundError
 *  without creating a circular import (the error class lives there). */
export class CloudSessionNotFoundError extends Error {
  sessionId: string;
  constructor(id: string) {
    super(`Cloud session not found: ${id}`);
    this.sessionId = id;
    this.name = "CloudSessionNotFoundError";
  }
}

export async function fetchCloudSession(id: string, signal?: AbortSignal): Promise<Session> {
  const all = await fetchCloudSessions(signal);
  const s = all.find((x) => x.id === id);
  if (!s) throw new CloudSessionNotFoundError(id);
  return s;
}

/** Cheap liveness probe for the open inspector: manifest is D1-only on the
 *  worker (no R2 decrypt). Returns total plaintext size. */
export async function fetchCloudSessionSize(id: string, signal?: AbortSignal): Promise<number> {
  const m = await getJson<{ total_size: number }>(
    apiPath(`/api/sessions/bytes/${encodeURIComponent(id)}/manifest`), signal,
  );
  return m.total_size ?? 0;
}

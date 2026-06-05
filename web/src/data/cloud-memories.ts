// cloud-memories.ts — the worker stores memories as an EVENT LOG
// (created/forgotten/purged); there is no materialized read API. Fold the
// log into current state client-side: a memory is live iff it has a
// created event with a payload and no forgotten/purged tombstone.
import type { Memory } from "./memories-api"; // Memory lives there, NOT in shared/types
import { getJson, apiPath } from "./http";

interface MemoryEvent {
  event_id: string;
  memory_id: string;
  event_type: "memory_created" | "memory_forgotten" | "memory_purged";
  space_id: string | null;
  created_at: number;
  payload?: { content: string | null; tags: string[]; purged_at: number | null };
}

export async function fetchCloudMemories(signal?: AbortSignal): Promise<Memory[]> {
  const data = await getJson<{ events: MemoryEvent[] }>(
    apiPath("/api/memories/events"), signal,
  );
  const dead = new Set<string>();
  const live = new Map<string, Memory>();
  for (const ev of data.events ?? []) {
    if (ev.event_type !== "memory_created") { dead.add(ev.memory_id); continue; }
    if (!ev.payload || ev.payload.content == null || ev.payload.purged_at != null) continue;
    live.set(ev.memory_id, {
      id: ev.memory_id,
      content: ev.payload.content,
      tags: ev.payload.tags ?? [],
      space_id: ev.space_id,
      created_at: new Date(ev.created_at).toISOString(),
      source_session_id: null, // not carried by the sync event log
    });
  }
  for (const id of dead) live.delete(id);
  return [...live.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

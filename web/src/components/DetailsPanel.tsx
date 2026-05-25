import { useEffect, useState, useRef } from "react";
import { fetchSessionsForArtifact } from "../data/artifacts-api";
import type { SessionJoinedForArtifact } from "../data/artifacts-api";
import type { Artifact } from "../data/artifacts-api";
import { InspectorPanel } from "./InspectorPanel";

interface Props {
  artifact: Artifact | null;
  onClose: () => void;
}

export function DetailsPanel({ artifact, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionJoinedForArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!artifact) return;
    const id = ++reqId.current;
    setSessions(null);
    setError(null);
    const ac = new AbortController();
    fetchSessionsForArtifact(artifact.id, ac.signal)
      .then((rows) => {
        if (id !== reqId.current) return;
        setSessions(rows);
      })
      .catch((err) => {
        if (id !== reqId.current || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [artifact?.id]);

  return (
    <InspectorPanel active={artifact ? { kind: "artefact", id: artifact.id } : null} onClose={onClose}>
      {artifact && (
        <>
          <header className="inspector-header">
            <div className="inspector-meta">
              <span>Details</span>
              <button type="button" className="close" onClick={onClose} aria-label="Close details">✕</button>
            </div>
            <div className="inspector-title">{artifact.label}</div>
          </header>
          <div className="inspector-body">
            <table className="details-table">
              <tbody>
                <tr>
                  <th>Kind</th>
                  <td>{artifact.artifactKind}</td>
                </tr>
                <tr>
                  <th>Origin</th>
                  <td>{artifact.sourceOrigin ?? "—"}</td>
                </tr>
                <tr>
                  <th>Path</th>
                  <td>
                    {artifact.path
                      ? <code className="details-path">{artifact.path}</code>
                      : <span className="inspector-empty">—</span>}
                  </td>
                </tr>
                <tr>
                  <th>Registered</th>
                  <td>{formatRel(artifact.createdAt)}</td>
                </tr>
              </tbody>
            </table>

            <div className="details-section-label">Source sessions</div>
            {error && <div className="inspector-error">Couldn't load sessions: {error}</div>}
            {!error && sessions === null && <div className="inspector-empty">Loading…</div>}
            {!error && sessions !== null && sessions.length === 0 && (
              <div className="inspector-empty">No linked sessions yet.</div>
            )}
            {!error && sessions && sessions.length > 0 && sessions.map((row) => (
              <div key={row.id} className="details-session-row">
                <span className={`role-chip ${row.role}`}>{row.role}</span>
                <span className="details-session-title">
                  {row.session.title ?? <em>Untitled</em>}
                </span>
                <span className="details-session-when">{formatRel(row.whenAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </InspectorPanel>
  );
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

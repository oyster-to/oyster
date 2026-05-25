// Session row — minimum-deviation layout for both views.
//   FULL and COMPACT share the same .home-row grid skeleton.
//   FULL only adds:
//     - .home-row--full wrapper modifier (bumps title to 14.5px / weight 500)
//     - an optional indented .sr-extra line below the row showing inline
//       artifact chips, rendered only when the session has artifacts attributed.
//
// Artifact chips ride on the session that produced them, sourced from
// session.recentArtifacts (populated server-side from session_artifacts —
// create/modify only, top 3, whenAt DESC). Absent on remote sessions, in
// which case the row degrades to the COMPACT layout (no extra line).
import type { Session } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import {
  AGENT_PIP_CLASS, activeWriterChipFor, formatRelative,
  originDeviceChipFor,
} from "./utils";
import type { PresenceInfo } from "../../hooks/useTerminalPresence";

export type SessionRowView = "full" | "compact";

interface SessionRowProps {
  session: Session;
  view: SessionRowView;
  spaces: Space[];
  /** Local device id; drives the cross-device chip. See SessionTile. */
  myDeviceId: string | null;
  /** Presence info from useTerminalPresence; undefined when no live terminal. */
  livePresence?: PresenceInfo;
  onOpen?: (id: string) => void;
  /** Focus an already-open terminal window for this session. */
  onTerminalFocus?: (terminalId: string) => void;
  /** Restore a minimised terminal window for this session. */
  onTerminalRestore?: (sessionId: string, terminalId: string) => void;
  /** Resume a non-live session (spawns `claude --resume <id>`). */
  onResume?: (sessionId: string) => void;
  /** Open an artefact (by id) in the viewer — backs the artefact chips. */
  onOpenArtifact?: (artifactId: string) => void;
}

export function SessionRow({
  session,
  view,
  spaces,
  myDeviceId,
  livePresence,
  onOpen,
  onTerminalFocus,
  onTerminalRestore,
  onResume,
  onOpenArtifact,
}: SessionRowProps) {
  const time = formatRelative(session.lastEventAt) ?? "—";
  const hasTitle = !!session.title;
  const title = session.title ?? "Untitled";
  const cwdBasename = session.cwd
    ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd
    : "";
  const remoteChip = originDeviceChipFor(session, myDeviceId);
  const activeChip = activeWriterChipFor(session, myDeviceId);

  const handleRowActivate = () => { if (onOpen) onOpen(session.id); };

  // Prefer space label when the session belongs to a registered space.
  const spaceLabel = session.spaceId
    ? (spaces.find((s) => s.id === session.spaceId)?.displayName ?? null)
    : null;
  const projectLabel = (spaceLabel ?? cwdBasename) || "—";
  const isManual = session.assignmentMode === "manual";
  const rowExtraClass = livePresence
    ? (livePresence.state === "attached" ? " sr--attached" : " sr--running")
    : "";
  const statusDotClass = livePresence
    ? (session.displayState === "waiting"
        ? "rd--managed-waiting"
        : (livePresence.state === "attached" ? "rd--attached" : "rd--running"))
    : session.displayState;

  const canConnect = livePresence
    ? (livePresence.state === "attached" ? !!onTerminalFocus : !!onTerminalRestore)
    : false;
  const canResume = !livePresence && !!onResume;

  const handleConnect = () => {
    if (!livePresence) return;
    if (livePresence.state === "attached") onTerminalFocus?.(livePresence.terminalId);
    else onTerminalRestore?.(session.id, livePresence.terminalId);
  };

  const fullModifier = view === "full" ? " home-row--full" : "";
  const hasExtra = view === "full" && !!session.recentArtifacts && session.recentArtifacts.length > 0;

  const cardClass = view === "full" ? "sr-card sr-card--full" : "sr-card";

  return (
    <div className={cardClass}>
      <div
        className={`home-row${fullModifier}${rowExtraClass}`}
        onClick={handleRowActivate}
        onKeyDown={onOpen ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowActivate(); }
        } : undefined}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
      >
        <span className={`home-row-status ${statusDotClass}`} title={session.displayReason || undefined} />
        <span className="home-row-space" title={session.cwd ?? undefined}>{projectLabel}</span>
        <span className="home-row-title">
          <span className="home-row-title-inner" title={title}>
            {remoteChip && (
              <span className="home-remote-chip" title={remoteChip.titleTooltip}>
                <span aria-hidden="true">↗</span> {remoteChip.label}
              </span>
            )}
            {activeChip && (
              <span className="home-active-chip" title={activeChip.titleTooltip}>
                {activeChip.label}
              </span>
            )}
            {isManual && (
              <span className="home-manual-chip" title="Pinned manually — Oyster's heuristic won't reassign this.">
                pinned
              </span>
            )}
            {hasTitle ? title : <span className="session-untitled">{title}</span>}
          </span>
          {livePresence && canConnect && (
            <button
              type="button"
              className="sl-chip sl-chip--connect"
              onClick={(e) => { e.stopPropagation(); handleConnect(); }}
              title={livePresence.state === "attached" ? "Bring the open terminal forward" : "Restore this minimised terminal"}
            >
              Connect
            </button>
          )}
          {canResume && (
            <button
              type="button"
              className="sl-chip sl-chip--resume"
              onClick={(e) => { e.stopPropagation(); onResume!(session.id); }}
              title="Start a new claude --resume in this session's folder"
            >
              Resume
            </button>
          )}
        </span>
        <span className={`home-row-agent ${AGENT_PIP_CLASS[session.agent]}`}>
          <span className="home-agent-pip" />
          {session.agent}
        </span>
        <span className="home-row-reason" title={session.displayReason || undefined}>{session.displayReason}</span>
        <span className="home-row-time">{time}</span>
      </div>
      {hasExtra && (
        <div className="sr-extra">
          {session.recentArtifacts!.map((a) => (
            <button
              key={a.artifactId}
              type="button"
              className="sr-artifact-chip"
              onClick={(e) => { e.stopPropagation(); onOpenArtifact?.(a.artifactId); }}
              title={`Open ${a.label}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

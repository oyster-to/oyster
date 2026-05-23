// Session row, two layouts.
//   FULL    = two-line rich row (project, agent, reason, artifact chips inline).
//             Default view.
//   COMPACT = single-line table-style row (the existing home-row layout).
//
// Artifact chips ride on the session that produced them. Because
// Artifact.sessionId doesn't exist on the current wire type, the caller
// may pass an empty array — rows render without chips in that case.
import { GitBranch } from "lucide-react";
import type { Session } from "../../data/sessions-api";
import type { Space } from "../../../../shared/types";
import type { Artifact } from "../../../../shared/types";
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
  /** Artifacts attached to this session (empty when attribution unavailable). */
  artifacts?: Artifact[];
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
}

function pipClassForState(state: Session["displayState"]): string {
  switch (state) {
    case "active":      return "pip-green";
    case "waiting":     return "pip-amber";
    case "disconnected":return "pip-red";
    case "dormant":
    case "done":
    default:            return "pip-dim";
  }
}

function stateBadgeText(state: Session["displayState"]): string {
  if (state === "active")       return "active";
  if (state === "waiting")      return "waiting";
  if (state === "disconnected") return "disconnected";
  return "";
}

function stateBadgeClass(state: Session["displayState"]): string {
  if (state === "active")       return "live";
  if (state === "waiting")      return "waiting";
  if (state === "disconnected") return "warning";
  return "";
}

export function SessionRow({
  session,
  view,
  spaces,
  artifacts,
  myDeviceId,
  livePresence,
  onOpen,
  onTerminalFocus,
  onTerminalRestore,
  onResume,
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

  // ── COMPACT view (existing table-style) ──────────────────────────────
  if (view === "compact") {
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

    return (
      <div
        className={`home-row${rowExtraClass}`}
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
    );
  }

  // ── FULL view ─────────────────────────────────────────────────────────
  const pipClass = pipClassForState(session.displayState);
  const badgeText = stateBadgeText(session.displayState);
  const badgeClass = stateBadgeClass(session.displayState);

  return (
    <div
      className="session-row-full"
      onClick={handleRowActivate}
      onKeyDown={onOpen ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowActivate(); }
      } : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className="srf-time">{time}</div>
      <div className="srf-main">
        <div className="srf-line1">
          <span className={`srf-pip ${pipClass}`} />
          <span className={`srf-title${!hasTitle ? " untitled" : ""}`} title={title}>
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
            {title}
          </span>
          {badgeText && (
            <span className={`srf-state-badge${badgeClass ? ` ${badgeClass}` : ""}`}>{badgeText}</span>
          )}
        </div>
        <div className="srf-line2">
          {cwdBasename && (
            <span className="srf-project">
              <GitBranch className="branch-icon" size={10} strokeWidth={2} aria-hidden="true" />
              {cwdBasename}
            </span>
          )}
          <span className="srf-sep">·</span>
          <span className={`srf-agent srf-agent--${AGENT_PIP_CLASS[session.agent]}`}>
            <span className="srf-agent-pip" />
            {session.agent}
          </span>
          {session.displayReason && (
            <>
              <span className="srf-sep">·</span>
              <span className="srf-reason">{session.displayReason}</span>
            </>
          )}
          {artifacts && artifacts.length > 0 && artifacts.slice(0, 3).map((a) => (
            <span
              key={a.id}
              className="srf-artifact-chip"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="srf-artifact-chip-glyph">¶</span>{a.label}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="srf-action"
        onClick={(e) => { e.stopPropagation(); onOpen?.(session.id); }}
      >
        Open
      </button>
    </div>
  );
}

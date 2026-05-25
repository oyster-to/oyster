import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { Folder, FolderPlus, Shield } from "lucide-react";
import type { Session, SessionState, DisplayState } from "../../data/sessions-api";
import type { Artifact, Space } from "../../../../shared/types";
import { useMemories } from "../../hooks/useMemories";
import { useAuthSignedIn } from "../../hooks/useAuthSignedIn";
import { useMyDeviceId } from "../../hooks/useMyDeviceId";
import { useSpaceProjects } from "../../hooks/useSpaceProjects";
import { parseTimestamp } from "../../utils/parseTimestamp";
import { AuthBadge } from "../AuthBadge";
import { Desktop } from "../Desktop";
import { InspectorPanel, type ActivePanel } from "../InspectorPanel";
import { SessionInspector } from "../SessionInspector";
import { ArtefactInspector } from "../ArtefactInspector";
import { ConfirmModal } from "../ConfirmModal";
import { PromptModal } from "../PromptModal";
import { SpaceContextMenu } from "../SpaceContextMenu";
import { SessionRow } from "./SessionRow";
import { ArtefactTable } from "./ArtefactTable";
import { ShowMore } from "./ShowMore";
import { AddMemoryForm } from "./AddMemoryForm";
import { ProjectTileGrid } from "./ProjectTileGrid";
import { AttachFolderForm } from "./AttachFolderForm";
import { AttachOrphanPopover } from "./AttachOrphanPopover";
import { MemoryCard } from "./MemoryCard";
import { VaultInfo } from "./VaultInfo";
import { homeRelative, renderPipCounts, stateColor } from "./utils";
import { VAULT, type ArtefactSource, type StateFilter } from "./types";
import { attachFolder, fetchAllProjects } from "../../data/projects-api";
import { ProjectTile } from "./ProjectTile";
import { useFetched } from "../../hooks/useFetched";
import { createSpace } from "../../data/spaces-api";
import { deleteMemory, type Memory } from "../../data/memories-api";
import { ApiError } from "../../data/http";
import { useTerminalPresence } from "../../hooks/useTerminalPresence";
import type { WindowState } from "../../stores/windows";
import { RunningTerminalsPill } from "../Topbar/RunningTerminalsPill";
import { NewSessionPill } from "../Topbar/NewSessionPill";
import { OnboardingDock } from "../OnboardingDock";
import "./Home.css";

interface Props {
  activeSpace: string;
  spaces: Space[];
  desktopProps: Omit<Parameters<typeof Desktop>[0], "isHero">;
  onSpaceChange: (space: string) => void;
  onPromoteFolderToSpace?: (path: string) => Promise<Space | null>;
  /** Removing the last folder from a real space collapses the space —
   *  Home delegates the delete (+ redirect) to App so spaces state
   *  stays consistent. */
  onSpaceDelete?: (spaceId: string) => Promise<void> | void;
  /** Used by the breadcrumb-pill context menu (rename). */
  onSpaceUpdate?: (id: string, fields: { displayName?: string; color?: string }) => void;
  /** Spawn an in-app Claude PTY in the given project's recent path. */
  onLaunchClaude?: (projectId: string) => void;
  /** Resume a session in an Oyster terminal (`claude --resume <id>`). */
  onLaunchClaudeFromSession?: (sessionId: string) => void;
  /** Launch a remote (cross-device) session in an Oyster terminal once
   *  reassemble has completed. Threaded to ResumeDialog via SessionInspector. */
  onOpenRemoteInOyster?: (sessionId: string) => Promise<import("../SessionInspector/ResumeDialog").OpenInOysterResult>;
  /** Running-terminals pill: client-side window list for presence fusion. */
  terminalWindows?: WindowState[];
  /** Running-terminals pill: focus an already-open terminal window. */
  onTerminalFocus?: (terminalId: string) => void;
  /** Running-terminals pill: restore a minimised terminal. */
  onTerminalRestore?: (sessionId: string, terminalId: string) => void;
  /** Running-terminals pill: stop (DELETE) a running terminal. */
  onTerminalStop?: (terminalId: string) => Promise<void>;
  /** Open an artefact (by id) in the viewer — backs session-row artefact chips. */
  onOpenArtifact?: (artifactId: string) => void;
  /** Sessions feed — hoisted to App to avoid duplicate SSE-triggered refetches. */
  sessions: Session[];
  sessionsLoading?: boolean;
  sessionsError?: Error | null;
  /** Open the new-session palette. When omitted, the pill is hidden
   *  (e.g. in test contexts that don't wire it up). */
  onOpenNewSession?: () => void;
  /** Focus / restore the live terminal for a session id. Threaded into
   *  SessionInspector so the primary action can read "Connect" when a
   *  live PTY exists. */
  onConnectSession?: (sessionId: string) => void;
  /** Real, user-created space count — drives the OnboardingDock's
   *  Spaces-step auto-tick. App owns the FORCE_ONBOARDING dev override
   *  and the meta-space filtering, then passes the number through. */
  userSpaceCount?: number;
  /** Global count of live publications — drives the OnboardingDock's
   *  Publish-step auto-tick (bidirectional, like userSpaceCount). App
   *  computes it from the unscoped artefact pile so a space pill can't
   *  hide a publication that lives in another space. */
  publishedCount?: number;
}

const ARTEFACT_SOURCE_ORDER: ArtefactSource[] = ["all", "manual", "ai_generated", "discovered", "published", "pinned"];
const ARTEFACT_SOURCE_LABELS: Record<ArtefactSource, string> = {
  all: "all",
  manual: "mine",
  ai_generated: "from agents",
  discovered: "linked",
  published: "published",
  pinned: "pinned",
};

// Mirrors PublishedChip's live-check. A publication exists once a share token
// has been minted; unpublishedAt becomes non-null when the publication is retired.
const isLivePublication = (a: Artifact): boolean =>
  a.publication != null && a.publication.unpublishedAt == null;

// Artefacts list cap. Matches Sessions (10) so both sections stay
// compact and the table view doesn't dump dozens of rows at once;
// Show more pages an extra ten in.
const ARTEFACTS_PREVIEW = 10;

// Persists a view toggle to localStorage so it survives reloads.
// Generic so callers can use any string-union type they need.
// Returns a useState-shaped pair so callsites stay one-liner.
function useStickyView<T extends string>(key: string, defaultValue: T, valid: ReadonlyArray<T>): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const stored = window.localStorage.getItem(key);
      return (stored !== null && valid.includes(stored as T)) ? (stored as T) : defaultValue;
    } catch {
      // Safari private browsing / storage disabled — fall through to default
      return defaultValue;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      window.localStorage.setItem(key, v);
    } catch {
      // private browsing / disabled storage — fine, just lose persistence
    }
  };
  return [value, set];
}

// "live" is a preset bundling active+waiting+disconnected (everything that
// isn't archived). It's the default because that's the common case — done
// is review/history, not active inventory. The dot after "live" indicates
// the live cluster ends; the per-state chips after it are for fine-grained
// filtering.
const FILTER_ORDER: StateFilter[] = ["live-terminals", "live", "active", "waiting", "done", "all"];
const LIVE_STATES: SessionState[] = ["active", "waiting"];

const EMPTY_COUNTS = { total: 0, running: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };

// Sessions list cap. Busy spaces can run dozens of concurrent sessions
// and previously pushed Artefacts below the fold; ten keeps the section
// compact in both icon and table views and Show more surfaces the rest.
const SESSIONS_PREVIEW = 10;

// Memory list shows this many rows by default; user clicks "Show all N"
// to expand. Five is small enough to fit alongside Sessions and Artefacts
// without scroll-thrash, large enough that single-space views (typically
// <5 memories) stay fully visible.
const MEMORIES_PREVIEW = 5;

const FILTER_LABELS: Record<StateFilter, string> = {
  live: "live",
  "live-terminals": "running",
  active: "active",
  waiting: "waiting",
  disconnected: "disconnected",
  done: "done",
  all: "all",
};

export function Home({ activeSpace, spaces, desktopProps, onSpaceChange, onPromoteFolderToSpace, onSpaceDelete, onSpaceUpdate, onLaunchClaude, onLaunchClaudeFromSession, onOpenRemoteInOyster, terminalWindows, onTerminalFocus, onTerminalRestore, onTerminalStop, onOpenArtifact, onOpenNewSession, onConnectSession, sessions, sessionsLoading: loading, sessionsError: error, userSpaceCount, publishedCount }: Props) {
  const presence = useTerminalPresence(sessions, terminalWindows ?? []);
  const signedIn = useAuthSignedIn();
  const myDevice = useMyDeviceId();
  const myDeviceId = myDevice?.deviceId ?? null;
  const [signingIn, setSigningIn] = useState(false);
  const {
    memories,
    loading: memoriesLoading,
    error: memoriesError,
    refresh: refreshMemories,
  } = useMemories();
  // Space sources only fetch when scoped to a real space — Home / Elsewhere
  // / All / Archived don't have a single source list. Identifies the
  // "zero sources attached" pitfall (#266) at a glance.
  const isMetaScope = activeSpace === "home" || activeSpace === "__all__" || activeSpace === "__archived__";
  const projectsSpaceId = !isMetaScope ? activeSpace : null;
  const {
    projects: spaceProjects,
    loading: spaceProjectsLoading,
    error: spaceProjectsError,
    refresh: refreshSpaceProjects,
  } = useSpaceProjects(projectsSpaceId);
  // All projects across all spaces — used by the Home-view tile strip.
  // Only fetched when on Home (enabled when isMetaScope and not Elsewhere).
  const {
    data: allProjects,
    refresh: refreshAllProjects,
  } = useFetched<import("../../data/projects-api").Project[]>(
    fetchAllProjects,
    [],
    { enabled: isMetaScope, ssEvent: "session_changed" },
  );
  const [showAttachForm, setShowAttachForm] = useState(false);
  // Reset the attach form whenever scope changes so it doesn't carry
  // across spaces.
  useEffect(() => { setShowAttachForm(false); }, [projectsSpaceId]);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [sessionsView, setSessionsView] = useStickyView("oyster.home.sessionsView", "full", ["full", "compact"] as const);
  const [artefactsView, setArtefactsView] = useStickyView("oyster.home.artefactsView", "icons", ["icons", "table"] as const);
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const [pendingMemoryDelete, setPendingMemoryDelete] = useState<Memory | null>(null);

  // Local "Elsewhere" scope: filters Sessions to those whose spaceId is null
  // (claude/codex sessions started in folders that aren't attached to any
  // registered space). Only applies in Home view; navigating to a real space
  // resets it.
  const [showElsewhere, setShowElsewhere] = useState(false);
  // Vault info page (cloud-sync teaser). Sits next to Home in the breadcrumb;
  // mutually exclusive with showElsewhere and resets when navigating away
  // from Home, same lifecycle as showElsewhere.
  const [showVault, setShowVault] = useState(false);
  // Memories collapse: long lists are noisy on Home. Default to 5 rows;
  // "Show all" expands. Resets when the user changes scope so a different
  // space starts collapsed too.
  const [memoriesLimit, setMemoriesLimit] = useState(MEMORIES_PREVIEW);
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const lastAutoReconcileRef = useRef<number>(0);
  const AUTO_THROTTLE_MS = 10_000;
  const [sessionsLimit, setSessionsLimit] = useState(SESSIONS_PREVIEW);
  // Artefact source filter (#280) + 3-row collapse. Reset on scope change
  // so each space starts compact and at "all".
  const [artefactSource, setArtefactSource] = useState<ArtefactSource>("all");
  const [artefactsLimit, setArtefactsLimit] = useState(ARTEFACTS_PREVIEW);
  // Cwd-based tile filter: drives session narrowing on both Home default
  // and showElsewhere. Lives alongside selectedProjectId; resets when scope changes.
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  // Cwd of the orphan tile currently mid-promotion (or mid-attach). Disables
  // every FolderPlus button so a slow server response can't kick off a
  // duplicate; also gates the picker popover. Set while either flow runs.
  const [promotingCwd, setPromotingCwd] = useState<string | null>(null);
  // Orphan attach picker. Anchored to the FolderPlus button on the matching
  // tile; rendered via portal alongside SpaceContextMenu at the end of the
  // tree so it overlays cleanly.
  const [attachPicker, setAttachPicker] = useState<{ cwd: string; rect: DOMRect } | null>(null);
  // Space-delete confirm. Set to a real space id to open. Two entry points
  // share this state: the empty-shell banner button (acts on the active
  // space) and the breadcrumb-pill context menu (acts on the clicked one).
  const [spaceToDelete, setSpaceToDelete] = useState<string | null>(null);
  // Right-click context menu on a breadcrumb pill — owns rename / color /
  // delete entry points. Anchored by the clicked pill's bounding rect.
  const [pillCtx, setPillCtx] = useState<{ spaceId: string; rect: DOMRect } | null>(null);
  // Project-tile filter: null = "All" (no folder scope), "__vault__" =
  // native artefacts, otherwise a source_id. The tile grid is the canonical
  // surface for switching between folders; selection is exclusive.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [addSpaceOpen, setAddSpaceOpen] = useState(false);

  const triggerSetupScan = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/scan", { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        alert(`Couldn't scan for spaces: ${text || res.statusText}`);
      }
      // Success: the SetupProposalPanel mounts automatically via the SSE
      // event the server emits — no further client work needed here.
    } catch (err) {
      alert(`Couldn't scan for spaces: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const isHomeView = activeSpace === "home";
  const isAllView = activeSpace === "__all__";
  const isArchivedView = activeSpace === "__archived__";
  const isMetaView = isHomeView || isAllView || isArchivedView;
  const scopedSpace = !isMetaView ? activeSpace : null;

  // Reset Elsewhere scope when we navigate away from Home (e.g. user clicks
  // a real space card or chat-bar pill).
  useEffect(() => {
    if (!isHomeView) {
      setShowElsewhere(false);
      setShowVault(false);
    }
  }, [isHomeView]);

  const showVaultPage = showVault && isHomeView;

  // Collapse limits + filter reset on scope change — switching from a
  // 60-item Home view to a single-space view shouldn't carry over either
  // the "show more" depth, source filter, or tile selection. Exception:
  // the Active-projects jump arrow lets the user "open this space with
  // this project pre-selected" — the click stashes a source_id in the
  // pending ref before triggering onSpaceChange, and this effect honours
  // it instead of the default null reset.
  const pendingFolderSelection = useRef<string | null>(null);
  useEffect(() => {
    setMemoriesLimit(MEMORIES_PREVIEW);
    setArtefactsLimit(ARTEFACTS_PREVIEW);
    setSessionsLimit(SESSIONS_PREVIEW);
    setArtefactSource("all");
    if (pendingFolderSelection.current) {
      setSelectedProjectId(pendingFolderSelection.current);
      pendingFolderSelection.current = null;
    } else {
      setSelectedProjectId(null);
    }
    setSelectedCwd(null);
  }, [scopedSpace, showElsewhere, isHomeView]);

  // Auto-reset the live-terminals filter if there are no live terminals
  // (e.g. the last terminal was stopped, or the user switched to a space
  // with none). Without this the pill disappears but the filter sticks,
  // leaving a silently empty session list.
  useEffect(() => {
    if (stateFilter === "live-terminals" && presence.totalLive === 0) {
      setStateFilter("all");
    }
  }, [stateFilter, presence.totalLive]);

  const scopedSessions = useMemo(() => {
    if (showElsewhere && isHomeView) return sessions.filter((s) => s.spaceId === null);
    return scopedSpace ? sessions.filter((s) => s.spaceId === scopedSpace) : sessions;
  }, [sessions, scopedSpace, showElsewhere, isHomeView]);

  // Folder-narrowed sessions: when a project tile is selected, sessions
  // filter to that source (or sessions without a source for VAULT, or
  // by cwd when a cwd-based tile is picked on Home or showElsewhere).
  const folderScopedSessions = useMemo(() => {
    if (selectedCwd) return scopedSessions.filter((s) => s.cwd === selectedCwd);
    if (selectedProjectId === VAULT) return scopedSessions.filter((s) => !s.projectId);
    if (selectedProjectId) return scopedSessions.filter((s) => s.projectId === selectedProjectId);
    return scopedSessions;
  }, [scopedSessions, selectedProjectId, selectedCwd]);

  const stateCounts = useMemo(() => {
    // Bucket by `displayState` (the wire's 5-state projection) so dormant
    // rows count toward the same "done" chip as cleanly-exited and PTY-
    // exited rows — they all read as grey on the surface.
    const counts: Record<StateFilter, number> & { dormant: number } = { live: 0, "live-terminals": 0, active: 0, waiting: 0, disconnected: 0, done: 0, dormant: 0, all: folderScopedSessions.length };
    for (const s of folderScopedSessions) counts[s.displayState]++;
    counts.done += counts.disconnected + counts.dormant;
    counts.disconnected = 0;
    counts.live = counts.active + counts.waiting;
    counts["live-terminals"] = folderScopedSessions.filter((s) => presence.byId[s.id] != null).length;
    return counts;
  }, [folderScopedSessions, presence.byId]);

  const visibleSessions = useMemo(() => {
    let list: typeof folderScopedSessions;
    if (stateFilter === "all") list = folderScopedSessions;
    else if (stateFilter === "live") list = folderScopedSessions.filter((s) => LIVE_STATES.includes(s.state));
    else if (stateFilter === "live-terminals") list = folderScopedSessions.filter((s) => presence.byId[s.id] != null);
    // "done" chip folds in disconnected + dormant so the list matches the count.
    else if (stateFilter === "done") list = folderScopedSessions.filter((s) => s.state === "done" || s.state === "disconnected" || s.displayState === "dormant");
    else list = folderScopedSessions.filter((s) => s.displayState === stateFilter);
    // Pin live (open terminal) rows to the top; within each group preserve
    // descending last-activity order.
    return list.slice().sort((a, b) => {
      const aLive = presence.byId[a.id] ? 0 : 1;
      const bLive = presence.byId[b.id] ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      return (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "");
    });
  }, [folderScopedSessions, stateFilter, presence.byId]);

  // Per-space session counts + a separate orphan tally (sessions with
  // spaceId === null) + a grand total for the Home card. Buckets by
  // `displayState` so dormant rows fold into `done` — matches the home
  // chip semantics where `disconnected` means the 30min–8h band only.
  const { sessionCountsBySpace, orphanCounts, totalCounts } = useMemo(() => {
    const bySpace: Record<string, { total: number; running: number; active: number; waiting: number; disconnected: number; done: number }> = {};
    const orphans = { total: 0, running: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    const total = { total: 0, running: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
    const bump = (c: { active: number; waiting: number; disconnected: number; done: number }, ds: DisplayState) => {
      if (ds === "dormant") c.done++;
      else c[ds]++;
    };
    for (const s of sessions) {
      total.total++;
      bump(total, s.displayState);
      if (presence.byId[s.id]) total.running++;
      if (s.spaceId) {
        const c = bySpace[s.spaceId] ?? { total: 0, running: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
        c.total++;
        bump(c, s.displayState);
        if (presence.byId[s.id]) c.running++;
        bySpace[s.spaceId] = c;
      } else {
        orphans.total++;
        bump(orphans, s.displayState);
        if (presence.byId[s.id]) orphans.running++;
      }
    }
    return { sessionCountsBySpace: bySpace, orphanCounts: orphans, totalCounts: total };
  }, [sessions, presence.byId]);

  // Per-project live-session counts, keyed by project_id. Used by
  // ProjectTileGrid so a project tile can show "1 active · 1 waiting"
  // when sessions are running for that project.
  const sessionCountsByProject = useMemo(() => {
    const out: Record<string, { running: number; active: number; waiting: number; disconnected: number; done: number }> = {};
    for (const s of sessions) {
      if (!s.projectId) continue;
      const isRunning = presence.byId[s.id] != null;
      const isDone = (s.displayState === "done" || s.displayState === "dormant") && !isRunning;
      const c = out[s.projectId] ?? { running: 0, active: 0, waiting: 0, disconnected: 0, done: 0 };
      if (isDone) {
        c.done++;
      } else {
        if (isRunning) c.running++;
        if (s.displayState === "active") c.active++;
        else if (s.displayState === "waiting") c.waiting++;
        else if (s.displayState === "disconnected") c.disconnected++;
      }
      out[s.projectId] = c;
    }
    return out;
  }, [sessions, presence.byId]);

  // Orphan-cwd "projects" on Elsewhere — sessions whose cwd doesn't
  // match any registered source still came from somewhere. Group by
  // cwd so the user can see at a glance which rogue folders have
  // activity, not just an undifferentiated session list.
  const orphanCwdGroups = useMemo(() => {
    if (!showElsewhere || !isHomeView) return [];
    const map = new Map<string, {
      cwd: string;
      counts: { active: number; waiting: number; disconnected: number; done: number };
      lastEventAt: number;
    }>();
    for (const s of sessions) {
      if (s.spaceId !== null || !s.cwd) continue;
      // Group separator-equivalent Windows paths under one tile: local
      // sessions write forward-slashed cwds while remote_sessions can hold
      // the raw backslash form pushed from the origin device, so the same
      // folder would otherwise render twice. Drive letter is lowercased
      // because Windows treats the volume case-insensitively.
      const key = s.cwd.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase() + ":");
      let entry = map.get(key);
      if (!entry) {
        entry = {
          cwd: s.cwd,
          counts: { active: 0, waiting: 0, disconnected: 0, done: 0 },
          lastEventAt: 0,
        };
        map.set(key, entry);
      }
      // Bucket by displayState; fold dormant into `done` so a grey row
      // doesn't bump the disconnected count.
      if (s.displayState === "dormant") entry.counts.done++;
      else entry.counts[s.displayState]++;
      const t = parseTimestamp(s.lastEventAt);
      if (Number.isFinite(t) && t > entry.lastEventAt) entry.lastEventAt = t;
    }
    return [...map.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }, [sessions, showElsewhere, isHomeView]);

  // Drop meta-spaces from the Spaces summary cards: the chat bar already
  // renders Home as its own pill, so a `home` row in the spaces table would
  // surface a redundant card. __all__ and __archived__ are similar.
  // Sort by most recent session activity desc; spaces with no sessions
  // fall to the bottom in their original (alphabetical) order. Home and
  // Elsewhere cards are rendered around this list — always first / always
  // last regardless of activity.
  // Stable breadcrumb order: bucket by strongest signal (green → amber →
  // red → quiet), then alphabetise within each bucket. Sorting by
  // last-activity caused pill order to flip every time a session updated,
  // which made re-finding a space a chore.
  const realSpaces = useMemo(() => {
    const filtered = spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__");
    const rank = (id: string): number => {
      const c = sessionCountsBySpace[id] ?? EMPTY_COUNTS;
      if (c.active > 0) return 0;
      if (c.waiting > 0) return 1;
      if (c.disconnected > 0) return 2;
      return 3;
    };
    return [...filtered].sort((a, b) => {
      const ra = rank(a.id), rb = rank(b.id);
      if (ra !== rb) return ra - rb;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [spaces, sessionCountsBySpace]);

  // Memories scope mirrors the server `list(space_id)` semantics: a real
  // space includes both memories explicitly tagged with that space AND
  // global memories (no space_id) — globals are meant to apply everywhere,
  // and the agent's `recall(query, space_id)` already returns scope+global,
  // so the human-browsing surface should match.
  // Elsewhere narrows to memories not bound to any currently-known space
  // (orphans + memories pointing at deleted spaces).
  const scopedMemories = useMemo(() => {
    if (showElsewhere && isHomeView) {
      const real = new Set(spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__").map((s) => s.id));
      return memories.filter((m) => !m.space_id || !real.has(m.space_id));
    }
    return scopedSpace
      ? memories.filter((m) => !m.space_id || m.space_id === scopedSpace)
      : memories;
  }, [memories, scopedSpace, showElsewhere, isHomeView, spaces]);

  // When scoped to Elsewhere, artefacts should mirror the sessions filter:
  // anything not attributed to a known real space (null spaceId or a stale
  // pointer to a deleted space). App.tsx hands us all artefacts on home —
  // we narrow them locally so artefacts and sessions tell the same story.
  const realSpaceIds = useMemo(() => new Set(realSpaces.map((s) => s.id)), [realSpaces]);
  // Destination options for a project tile's "Move to space…" picker.
  const moveSpaceOptions = useMemo(
    () => realSpaces.map((s) => ({ id: s.id, name: s.displayName })),
    [realSpaces],
  );
  // Projects detached from every space (space_id = null) — surfaced under the
  // Unassigned pill so a "removed from space" project stays findable and can
  // be re-filed from its own Move-to-space menu.
  const unassignedProjects = useMemo(
    () => allProjects.filter((p) => p.spaceId == null),
    [allProjects],
  );
  const effectiveDesktopProps = useMemo(() => {
    if (showElsewhere && isHomeView) {
      return {
        ...desktopProps,
        artifacts: desktopProps.artifacts.filter((a) => !a.spaceId || !realSpaceIds.has(a.spaceId)),
      };
    }
    return desktopProps;
  }, [showElsewhere, isHomeView, desktopProps, realSpaceIds]);

  // Source-origin counts over the scoped artefacts (so the chip totals
  // reflect the current space pill, not the global pile).
  const artefactSourceCounts = useMemo(() => {
    const counts: Record<ArtefactSource, number> = { all: 0, manual: 0, ai_generated: 0, discovered: 0, published: 0, pinned: 0 };
    counts.all = effectiveDesktopProps.artifacts.length;
    for (const a of effectiveDesktopProps.artifacts) {
      const o = a.sourceOrigin ?? "manual";
      if (o === "manual" || o === "ai_generated" || o === "discovered") counts[o]++;
      if (isLivePublication(a)) counts.published++;
      if (a.pinnedAt != null) counts.pinned++;
    }
    return counts;
  }, [effectiveDesktopProps.artifacts]);

  const [projectsExpanded, setProjectsExpanded] = useState(false);

  // Collapsed, the Projects strip shows exactly one row. The grid is
  // responsive (auto-fill), so the column count varies with width — measure
  // it from the live grid rather than guessing a fixed number.
  const [projectColumns, setProjectColumns] = useState(4);
  const projectsGridObserver = useRef<ResizeObserver | null>(null);
  const measureProjectColumns = useCallback((el: HTMLDivElement) => {
    const tracks = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
    if (tracks > 0) setProjectColumns(tracks);
  }, []);
  const projectsGridRef = useCallback((el: HTMLDivElement | null) => {
    projectsGridObserver.current?.disconnect();
    if (!el) return;
    measureProjectColumns(el);
    const ro = new ResizeObserver(() => measureProjectColumns(el));
    ro.observe(el);
    projectsGridObserver.current = ro;
  }, [measureProjectColumns]);

  // Recency per project (max lastEventAt across its sessions).
  const lastActivityByProject = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sessions) {
      if (!s.projectId) continue;
      const t = parseTimestamp(s.lastEventAt);
      if (!Number.isFinite(t)) continue;
      if (t > (out[s.projectId] ?? 0)) out[s.projectId] = t;
    }
    return out;
  }, [sessions]);

  // Total per project (live + done) — only used as the final tiebreaker.
  const sessionTotalsByProject = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [pid, c] of Object.entries(sessionCountsByProject)) {
      out[pid] = (c.running ?? 0) + (c.active ?? 0) + (c.waiting ?? 0) + (c.disconnected ?? 0) + (c.done ?? 0);
    }
    return out;
  }, [sessionCountsByProject]);

  // Sort by action-relevance: hasLive desc → hasWaiting desc → lastActivity desc → total desc.
  const sortedProjects = useMemo(() => {
    const score = (id: string) => {
      const c = sessionCountsByProject[id] ?? {};
      return {
        hasLive: ((c.running ?? 0) + (c.active ?? 0)) > 0 ? 1 : 0,
        hasWaiting: ((c.waiting ?? 0) + (c.disconnected ?? 0)) > 0 ? 1 : 0,
        lastActivity: lastActivityByProject[id] ?? 0,
        total: sessionTotalsByProject[id] ?? 0,
      };
    };
    // Filed projects only — those detached from every space (space_id null)
    // live under the Unassigned pill, mirroring how orphan sessions are
    // segregated out of the Home view.
    return allProjects.filter((p) => p.spaceId != null).sort((a, b) => {
      const sa = score(a.id);
      const sb = score(b.id);
      if (sa.hasLive !== sb.hasLive) return sb.hasLive - sa.hasLive;
      if (sa.hasWaiting !== sb.hasWaiting) return sb.hasWaiting - sa.hasWaiting;
      if (sa.lastActivity !== sb.lastActivity) return sb.lastActivity - sa.lastActivity;
      return sb.total - sa.total;
    });
  }, [allProjects, sessionCountsByProject, lastActivityByProject, sessionTotalsByProject]);

  const visibleProjects = projectsExpanded
    ? sortedProjects
    : sortedProjects.slice(0, projectColumns);

  const hiddenCount = sortedProjects.length - visibleProjects.length;

  // Per-project artefact counts for the tile badges. Includes the VAULT
  // bucket (artefacts with no project binding) so ProjectTileGrid can
  // render the Vault tile when there's anything in it. Returns {} only
  // when the artefact list is empty.
  const projectArtefactCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of effectiveDesktopProps.artifacts) {
      const key = a.projectId ?? VAULT;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [effectiveDesktopProps.artifacts]);

  // Filter + collapse to an incremental preview. Each "Show more" click
  // grows artefactsLimit by ARTEFACTS_PREVIEW; the cap applies to both
  // icon and table views so busy spaces don't push later sections far
  // below the fold.
  const filteredArtefacts = useMemo(() => {
    let list = effectiveDesktopProps.artifacts;
    if (selectedProjectId === VAULT) {
      list = list.filter((a) => !a.projectId);
    } else if (selectedProjectId) {
      list = list.filter((a) => a.projectId === selectedProjectId);
    }
    if (artefactSource === "published") {
      list = list.filter(isLivePublication);
    } else if (artefactSource === "pinned") {
      list = list.filter((a) => a.pinnedAt != null);
    } else if (artefactSource !== "all") {
      list = list.filter((a) => (a.sourceOrigin ?? "manual") === artefactSource);
    }
    // Pinned-first within the active scope (#387), then most-recent
    // first. Sorting by createdAt here (not just inside ArtefactTable)
    // means the artefactsLimit slice picks the freshest rows; each
    // view (icon = alpha, table = createdAt DESC) can still re-arrange
    // that sliced set however it wants.
    list = [...list].sort((a, b) => {
      const ap = a.pinnedAt ?? 0;
      const bp = b.pinnedAt ?? 0;
      if (ap !== bp) return bp - ap;
      const ta = parseTimestamp(a.createdAt);
      const tb = parseTimestamp(b.createdAt);
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    return list;
  }, [effectiveDesktopProps.artifacts, artefactSource, selectedProjectId]);
  const visibleArtefacts = useMemo(
    () => filteredArtefacts.slice(0, artefactsLimit),
    [filteredArtefacts, artefactsLimit],
  );
  const filteredArtefactsTotal = filteredArtefacts.length;

  // Resolve the active artefact against the FULL artifact list, not the
  // showElsewhere-filtered one. Cross-navigating from a session inspector
  // to an artefact in a different scope (e.g. clicking a registered-space
  // artefact while the user is in Elsewhere mode) shouldn't close the panel.
  const activeArtefact = activePanel?.kind === "artefact"
    ? desktopProps.artifacts.find((a) => a.id === activePanel.id)
    : null;

  // Close the panel if the active artefact disappears (e.g. archived from under the inspector)
  useEffect(() => {
    if (activePanel?.kind === "artefact" && !activeArtefact) {
      setActivePanel(null);
    }
  }, [activePanel, activeArtefact]);

  // Allow App-level surfaces (Spotlight, etc.) to request a session
  // inspector via a window event — saves threading a callback through
  // the App→Home prop boundary just for this one cross-cutting hook.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string; eventId?: number; query?: string }>).detail;
      if (detail && typeof detail.id === "string") {
        setActivePanel({
          kind: "session",
          id: detail.id,
          focusEventId: typeof detail.eventId === "number" ? detail.eventId : undefined,
          initialSearchQuery: typeof detail.query === "string" && detail.query.length > 0
            ? detail.query
            : undefined,
        });
      }
    };
    window.addEventListener("oyster:open-session", handler);
    return () => window.removeEventListener("oyster:open-session", handler);
  }, []);

  // Manual refresh: calls reconcile immediately (bypasses throttle), then
  // refreshes the memories list on success.
  const handleManualReconcile = useCallback(async () => {
    if (reconciling) return;
    setReconciling(true);
    setLastSyncMessage(null);
    try {
      const res = await fetch("/api/memories/reconcile?reason=manual", { method: "POST" });
      if (res.ok) {
        const data = await res.json() as { applied?: number; status?: string };
        await refreshMemories();
        const msg = data.applied && data.applied > 0
          ? `Pulled ${data.applied} update${data.applied === 1 ? "" : "s"}`
          : "Synced";
        setLastSyncMessage(msg);
        setTimeout(() => setLastSyncMessage(null), 3000);
        // Reset the auto throttle so lifecycle events respect the 10s window
        lastAutoReconcileRef.current = Date.now();
      }
    } catch (err) {
      console.warn("[memory] manual reconcile failed:", err);
    } finally {
      setReconciling(false);
    }
  }, [reconciling, refreshMemories]);

  // Lifecycle-triggered reconcile: focus, visibilitychange, online, panel-open.
  // Throttled to once per 10s so rapid events don't pile up.
  const triggerLifecycleReconcile = useCallback((reason: string) => {
    const now = Date.now();
    if (now - lastAutoReconcileRef.current < AUTO_THROTTLE_MS) return;
    lastAutoReconcileRef.current = now;
    fetch(`/api/memories/reconcile?reason=${reason}`, { method: "POST" })
      .then((r) => r.ok ? r.json() : null)
      .then((data: { applied?: number } | null) => {
        if (data?.applied && data.applied > 0) refreshMemories();
      })
      .catch((err) => console.warn("[memory] lifecycle reconcile failed:", err));
  }, [refreshMemories]);

  useEffect(() => {
    const onFocus = () => triggerLifecycleReconcile("focus");
    const onVisibility = () => {
      if (document.visibilityState === "visible") triggerLifecycleReconcile("visible");
    };
    const onOnline = () => triggerLifecycleReconcile("online");

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [triggerLifecycleReconcile]);

  // Trigger reconcile when the Memories section becomes visible (panel open /
  // scope navigation mounts this component).
  useEffect(() => {
    triggerLifecycleReconcile("panel-open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSpaceRow = scopedSpace ? spaces.find((s) => s.id === scopedSpace) : null;
  const eyebrow = isHomeView ? (showElsewhere ? "Unassigned" : "Home")
    : isAllView ? "All"
    : isArchivedView ? "Archived"
    : activeSpaceRow?.displayName ?? scopedSpace ?? "";

  return (
    <div className="home">
      <div className="home-glow" />
      <div className="home-orb" />
      <div className="home-grain" />

      <div className="home-scroll">
        {/* Top space nav — stable on every screen. Pills carry numbered
            badges for non-zero active/waiting/disconnected counts so the
            at-a-glance dashboard info lives in the nav itself; no need
            for a separate "Spaces" content section that would just
            duplicate the same data. The leftmost slot is the account
            chip (avatar when signed-in / "Sign in" when signed-out) so
            identity + navigation share one sticky bar at the top of
            every view. Always renders, so the Sign-in CTA is reachable
            even on a brand-new workspace with no spaces yet. */}
        <nav className="home-breadcrumb" aria-label="Account and spaces">
            <LayoutGroup id="home-breadcrumb">
            <div className="home-breadcrumb-inner">
            <AuthBadge />
            <button
              type="button"
              className={`home-breadcrumb-pill home-breadcrumb-pill--home${isHomeView && !showElsewhere && !showVault ? " selected" : ""}`}
              onClick={() => { onSpaceChange("home"); setShowElsewhere(false); setShowVault(false); }}
              onContextMenu={(e) => e.preventDefault()}
              title={`${totalCounts.active} active · ${totalCounts.waiting} waiting · ${totalCounts.disconnected} disconnected · ${totalCounts.done} done`}
            >
              {isHomeView && !showElsewhere && !showVault && (
                <motion.span
                  layoutId="home-breadcrumb-bg"
                  className="home-breadcrumb-pill-bg"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style={{ position: "relative", zIndex: 1 }}>
                <path d="M11.03 2.59a1.5 1.5 0 0 1 1.94 0l7.5 6.363A1.5 1.5 0 0 1 21 10.097V19.5a2.5 2.5 0 0 1-2.5 2.5H15v-4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4H5.5A2.5 2.5 0 0 1 3 19.5v-9.403a1.5 1.5 0 0 1 .53-1.137l7.5-6.37Z"/>
              </svg>
            </button>
            <button
              type="button"
              className={`home-breadcrumb-pill home-breadcrumb-pill--vault${showVaultPage ? " selected" : ""}`}
              onClick={() => { onSpaceChange("home"); setShowElsewhere(false); setShowVault(true); }}
              onContextMenu={(e) => e.preventDefault()}
              title="Oyster Pro — coming soon"
              aria-label="Oyster Pro"
            >
              {showVaultPage && (
                <motion.span
                  layoutId="home-breadcrumb-bg"
                  className="home-breadcrumb-pill-bg"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <Shield size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" style={{ position: "relative", zIndex: 1 }} />
            </button>
            {realSpaces.map((space) => {
              const counts = sessionCountsBySpace[space.id] ?? EMPTY_COUNTS;
              const tip = [
                counts.running > 0 && `${counts.running} running`,
                counts.active > 0 && `${counts.active} active`,
                counts.waiting > 0 && `${counts.waiting} waiting`,
                counts.done > 0 && `${counts.done} done`,
              ].filter(Boolean).join(" · ") || "no sessions yet";
              const isSelected = scopedSpace === space.id;
              return (
                <button
                  key={space.id}
                  type="button"
                  className={`home-breadcrumb-pill${isSelected ? " selected" : ""}`}
                  onClick={() => onSpaceChange(space.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPillCtx({ spaceId: space.id, rect: e.currentTarget.getBoundingClientRect() });
                  }}
                  title={tip}
                >
                  {isSelected && (
                    <motion.span
                      layoutId="home-breadcrumb-bg"
                      className="home-breadcrumb-pill-bg"
                      transition={{ type: "spring", stiffness: 400, damping: 35 }}
                    />
                  )}
                  {(counts.running > 0 || counts.active > 0 || counts.waiting > 0) && (
                    <span className="home-breadcrumb-badges">
                      {renderPipCounts(counts)}
                    </span>
                  )}
                  <span className="home-breadcrumb-pill-label">{space.displayName}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="home-breadcrumb-pill home-breadcrumb-pill--add"
              onClick={() => {
                if (realSpaces.length === 0) {
                  // First-time: trigger the server-side scan; the SetupProposalPanel
                  // will render via the setup_proposal_ready SSE event.
                  void triggerSetupScan();
                } else {
                  // Power-add: simple name prompt to add another.
                  setAddSpaceOpen(true);
                }
              }}
              title={realSpaces.length === 0 ? "Create your first space" : "Add a space"}
              aria-label={realSpaces.length === 0 ? "Create your first space" : "Add a space"}
            >
              {realSpaces.length === 0 ? (
                <>
                  <span aria-hidden="true">+</span>
                  <span className="home-breadcrumb-pill-label">Space</span>
                </>
              ) : (
                <span aria-hidden="true">+</span>
              )}
            </button>
            {(orphanCounts.total > 0 || unassignedProjects.length > 0) && realSpaces.length > 0 && (
              <button
                type="button"
                className={`home-breadcrumb-pill home-breadcrumb-pill--elsewhere${showElsewhere && isHomeView ? " selected" : ""}`}
                onClick={() => { onSpaceChange("home"); setShowElsewhere(true); setShowVault(false); }}
                onContextMenu={(e) => e.preventDefault()}
                title={[
                  orphanCounts.running > 0 && `${orphanCounts.running} running`,
                  orphanCounts.active > 0 && `${orphanCounts.active} active`,
                  orphanCounts.waiting > 0 && `${orphanCounts.waiting} waiting`,
                  orphanCounts.done > 0 && `${orphanCounts.done} done`,
                ].filter(Boolean).join(" · ") || "Sessions outside any registered space"}
              >
                {showElsewhere && isHomeView && (
                  <motion.span
                    layoutId="home-breadcrumb-bg"
                    className="home-breadcrumb-pill-bg"
                    transition={{ type: "spring", stiffness: 400, damping: 35 }}
                  />
                )}
                {(orphanCounts.running > 0 || orphanCounts.active > 0 || orphanCounts.waiting > 0) && (
                  <span className="home-breadcrumb-badges">
                    {renderPipCounts(orphanCounts)}
                  </span>
                )}
                <span className="home-breadcrumb-pill-label">Unassigned</span>
              </button>
            )}
            </div>
            <div className="home-breadcrumb-inner home-breadcrumb-inner--right-cluster">
              {onTerminalFocus && onTerminalRestore && onTerminalStop && presence.totalLive > 0 && (
                <RunningTerminalsPill
                  presence={presence}
                  sessions={sessions}
                  onFocus={onTerminalFocus}
                  onRestore={onTerminalRestore}
                  onStop={onTerminalStop}
                />
              )}
              {onOpenNewSession && <NewSessionPill onClick={onOpenNewSession} />}
            </div>
            <OnboardingDock userSpaceCount={userSpaceCount} publishedCount={publishedCount} />
            </LayoutGroup>
          </nav>

        {showVaultPage ? (
          <VaultInfo />
        ) : (<>
        <header className="home-header">
          {/* Eyebrow dropped — the breadcrumb above already shows the
              active scope, so a separate "HOME" / "OYSTER" label is
              redundant. */}
          <h1 className="home-title">{isHomeView ? (showElsewhere ? "Unassigned." : "Your work.") : eyebrow}</h1>
          {error && <div className="home-error">Couldn't load sessions: {error.message}</div>}
        </header>

        {/* The rich space-cards grid was removed — pills in the top
            breadcrumb enumerate the spaces with numbered status badges,
            so a parallel content section was duplicate work. The
            home-space-card / home-spaces-section CSS is kept around in
            case the cards return as a settings or dashboard surface. */}

        {isHomeView && !showElsewhere && sortedProjects.length > 0 && (
          <div className="home-section home-projects-section">
            <div className="home-section-head">
              <span className="home-section-label">Projects</span>
              <button
                type="button"
                className="home-organise-btn"
                onClick={triggerSetupScan}
                title="Suggest space groupings from your projects"
              >
                Organise into spaces ✨
              </button>
              <span className="home-section-rule" />
            </div>
            <div className="home-projects-grid" ref={projectsGridRef}>
              {visibleProjects.map((p) => (
                // onSpaceDelete intentionally omitted — Home strip can't collapse spaces.
                // isLastProject/spaceTotalSessions are inert here (willCollapseSpace = false).
                <ProjectTile
                  key={p.id}
                  project={p}
                  artefactCount={projectArtefactCounts[p.id] ?? 0}
                  sessionCounts={sessionCountsByProject[p.id]}
                  selected={selectedProjectId === p.id}
                  onSelect={() => setSelectedProjectId(selectedProjectId === p.id ? null : p.id)}
                  onChanged={refreshAllProjects}
                  isLastProject={false}
                  spaceTotalSessions={0}
                  // otherProjects intentionally empty — Home strip can't merge across spaces
                  otherProjects={[]}
                  spaces={moveSpaceOptions}
                  onLaunchClaude={onLaunchClaude}
                />
              ))}
            </div>
            {hiddenCount > 0 && !projectsExpanded && (
              <div className="home-projects-footer">
                <button
                  type="button"
                  className="home-projects-show-more"
                  onClick={() => setProjectsExpanded(true)}
                >
                  Show all {sortedProjects.length} projects ▾
                </button>
              </div>
            )}
            {projectsExpanded && sortedProjects.length > projectColumns && (
              <div className="home-projects-footer">
                <button
                  type="button"
                  className="home-projects-show-more home-projects-show-more--collapse"
                  onClick={() => setProjectsExpanded(false)}
                >
                  Show less ▴
                </button>
              </div>
            )}
          </div>
        )}

        {isHomeView && showElsewhere && unassignedProjects.length > 0 && (
          <div className="home-section home-projects-section">
            <div className="home-projects-grid">
              {unassignedProjects.map((p) => (
                <ProjectTile
                  key={p.id}
                  project={p}
                  artefactCount={projectArtefactCounts[p.id] ?? 0}
                  sessionCounts={sessionCountsByProject[p.id]}
                  selected={selectedProjectId === p.id}
                  onSelect={() => setSelectedProjectId(selectedProjectId === p.id ? null : p.id)}
                  onChanged={refreshAllProjects}
                  isLastProject={false}
                  spaceTotalSessions={0}
                  // No merge target across the unassigned pool; move-to-space re-files it.
                  otherProjects={[]}
                  spaces={moveSpaceOptions}
                  onLaunchClaude={onLaunchClaude}
                />
              ))}
            </div>
          </div>
        )}

        {isHomeView && showElsewhere && orphanCwdGroups.length > 0 && (
          <div className="home-section home-projects-section">
            <div className="home-projects-grid">
              {orphanCwdGroups.map((p) => {
                const isSelected = selectedCwd === p.cwd;
                // Disable every promote button while *any* promotion is in
                // flight — the click handler also short-circuits in that
                // case, so the disabled state is honest about it.
                const isPromoting = Boolean(promotingCwd);
                return (
                  <div
                    key={p.cwd}
                    className={`home-projects-strip-tile home-projects-strip-tile--orphan${isSelected ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="home-projects-strip-tile-body"
                      onClick={() => setSelectedCwd(isSelected ? null : p.cwd)}
                      title={p.cwd}
                    >
                      <div className="home-projects-strip-name home-projects-strip-name--folder">
                        <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
                        <span>{homeRelative(p.cwd)}</span>
                      </div>
                      <div className="home-projects-strip-counts">
                        {p.counts.active > 0 && <span className="signal"><span className="pip pip-green" />{p.counts.active} active</span>}
                        {p.counts.waiting > 0 && <span className="signal"><span className="pip pip-amber" />{p.counts.waiting} waiting</span>}
                        {p.counts.disconnected > 0 && <span className="signal"><span className="pip pip-red" />{p.counts.disconnected} disconnected</span>}
                        {p.counts.done > 0 && <span className="signal"><span className="pip pip-dim" />{p.counts.done} done</span>}
                      </div>
                    </button>
                    {onPromoteFolderToSpace && (
                      <button
                        type="button"
                        className="home-projects-strip-tile-jump"
                        disabled={isPromoting && attachPicker?.cwd !== p.cwd}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (promotingCwd && attachPicker?.cwd !== p.cwd) return;
                          if (attachPicker?.cwd === p.cwd) {
                            setAttachPicker(null);
                            return;
                          }
                          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                          setAttachPicker({ cwd: p.cwd, rect });
                        }}
                        aria-label={`Attach ${homeRelative(p.cwd)} to a space`}
                        title={`Attach ${homeRelative(p.cwd)} to a space`}
                      >
                        <FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {projectsSpaceId && (
          spaceProjectsError ? (
            <div className="home-spaces-section">
              <div className="home-spaces-grid">
                <div className="home-empty" style={{ gridColumn: "1 / -1" }}>
                  Couldn't load projects: {spaceProjectsError.message}
                </div>
              </div>
            </div>
          ) : spaceProjects.length === 0 && !spaceProjectsLoading ? (
            <div className="home-spaces-section">
              <div className="home-folders-empty">
                <strong>No projects in this space yet.</strong>{" "}
                Sessions started in unclaimed folders land in Elsewhere
                until you claim them into a project.{" "}
                <span className="home-folders-empty-hint">
                  <button
                    type="button"
                    className="home-folders-empty-link"
                    onClick={() => setShowAttachForm(true)}
                  >
                    Add a project
                  </button>.
                  {onSpaceDelete && (
                    <>
                      {" "}If this space was created in error, you can{" "}
                      <button
                        type="button"
                        className="home-folders-empty-link"
                        onClick={() => setSpaceToDelete(projectsSpaceId)}
                      >
                        delete it
                      </button>.
                    </>
                  )}
                </span>
              </div>
              {showAttachForm && (
                <AttachFolderForm
                  spaceId={projectsSpaceId}
                  onAttached={() => {
                    setShowAttachForm(false);
                    refreshSpaceProjects();
                  }}
                  onCancel={() => setShowAttachForm(false)}
                />
              )}
            </div>
          ) : (
            <ProjectTileGrid
              spaceId={projectsSpaceId}
              projects={spaceProjects}
              projectArtefactCounts={projectArtefactCounts}
              sessionCountsByProject={sessionCountsByProject}
              selectedProjectId={selectedProjectId}
              setSelectedProjectId={setSelectedProjectId}
              spaceTotalSessions={scopedSessions.length}
              spaces={moveSpaceOptions}
              showAttachForm={showAttachForm}
              setShowAttachForm={setShowAttachForm}
              onProjectsChanged={refreshSpaceProjects}
              onSpaceDelete={onSpaceDelete}
              onLaunchClaude={onLaunchClaude}
            />
          )
        )}

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Sessions</span>
            <span className="home-section-stats">
              {FILTER_ORDER.map((f) => {
                const count = stateCounts[f];
                if (count === 0 && f !== "all" && f !== "live") return null;
                const isLiveTerminals = f === "live-terminals";
                const showPip = f !== "all" && f !== "live";
                return (
                  <span key={f} style={{ display: "contents" }}>
                    <button
                      className={`stat-btn${stateFilter === f ? " active" : ""}`}
                      onClick={() => setStateFilter(f)}
                    >
                      {showPip && (
                        isLiveTerminals
                          ? <span className="pip pip-teal" />
                          : <span className={`pip pip-${stateColor(f as SessionState)}`} />
                      )}
                      {count} {FILTER_LABELS[f]}
                    </button>
                    {f === "live" && <span className="stat-divider" aria-hidden="true" />}
                  </span>
                );
              })}
            </span>
            <span className="home-section-rule" />
            <div className="view-toggle-text">
              <button
                type="button"
                className={sessionsView === "full" ? "active" : ""}
                onClick={() => setSessionsView("full")}
              >
                Full
              </button>
              <button
                type="button"
                className={sessionsView === "compact" ? "active" : ""}
                onClick={() => setSessionsView("compact")}
              >
                Compact
              </button>
            </div>
          </div>

          {loading && sessions.length === 0 ? (
            <div className="home-empty">Loading sessions…</div>
          ) : visibleSessions.length === 0 && !(stateCounts.all === 0 && isHomeView && !showElsewhere) ? (
            <div className="home-empty">No sessions match this filter yet.</div>
          ) : (
            <>
              <div className="home-table-wrap">
                <div className="home-table">
                  <div className="home-row home-row--header" role="row">
                    <span aria-hidden="true" />
                    <span role="columnheader">Project</span>
                    <span role="columnheader">Title</span>
                    <span role="columnheader">Agent</span>
                    <span role="columnheader">Reason</span>
                    <span role="columnheader">Last active</span>
                  </div>
                  {visibleSessions.slice(0, sessionsLimit).map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      view={sessionsView}
                      spaces={spaces}
                      myDeviceId={myDeviceId}
                      livePresence={presence.byId[session.id]}
                      onOpen={(id) => setActivePanel({ kind: "session", id })}
                      onTerminalFocus={onTerminalFocus}
                      onTerminalRestore={onTerminalRestore}
                      onResume={onLaunchClaudeFromSession}
                      onOpenArtifact={onOpenArtifact}
                    />
                  ))}
                </div>
              </div>
              {sessionsLimit < visibleSessions.length && (
                <ShowMore
                  onClick={() => setSessionsLimit((n) => n + SESSIONS_PREVIEW)}
                  remaining={visibleSessions.length - sessionsLimit}
                  searchHint
                  newSessionHint
                />
              )}
            </>
          )}
          {stateCounts.all === 0 && isHomeView && !showElsewhere && !loading && (
            <div className="home-empty-state">
              <div className="home-empty-state-title">No sessions found yet.</div>
              <div className="home-empty-state-body">
                Start a Claude Code session in a project. Oyster will pick it up automatically.
              </div>
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Artefacts</span>
            <span className="home-section-stats">
              {ARTEFACT_SOURCE_ORDER.map((src) => {
                const count = artefactSourceCounts[src];
                // Origin pills hide at 0 (clutter); "all" stays unconditional;
                // "published" and "pinned" stay visible as discoverability surfaces —
                // clicking them at 0 lands on a how-to hint instead of an empty grid.
                if (count === 0 && src !== "all" && src !== "published" && src !== "pinned") return null;
                return (
                  <button
                    key={src}
                    className={`stat-btn${artefactSource === src ? " active" : ""}`}
                    onClick={() => setArtefactSource(src)}
                  >
                    {src === "published" && <span className="pip pip-published" />}
                    {src === "pinned" && <span className="pip pip-pinned" />}
                    {count} {ARTEFACT_SOURCE_LABELS[src]}
                  </button>
                );
              })}
            </span>
            <span className="home-section-rule" />
            <div className="home-view-toggle">
              <button
                className={`view-btn${artefactsView === "icons" ? " active" : ""}`}
                onClick={() => setArtefactsView("icons")}
                title="Icon view"
                aria-label="Icon view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
              </button>
              <button
                className={`view-btn${artefactsView === "table" ? " active" : ""}`}
                onClick={() => setArtefactsView("table")}
                title="Table view"
                aria-label="Table view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          {artefactSource === "published" && filteredArtefactsTotal === 0 ? (
            <div className="home-empty">
              {signedIn === null ? (
                // First whoami in flight — render a placeholder rather than
                // flashing either copy. The auth check is fast, so the empty
                // gap is barely perceptible vs. flicking through wrong text.
                <>&nbsp;</>
              ) : signedIn === false ? (
                <>
                  <div>Sign in to see your published artefacts. Publishing requires an account.</div>
                  <button
                    type="button"
                    className="home-empty__cta"
                    disabled={signingIn}
                    onClick={async () => {
                      setSigningIn(true);
                      try {
                        const res = await fetch("/api/auth/login", { method: "POST" });
                        if (!res.ok) throw new Error(String(res.status));
                        const body = (await res.json()) as { sign_in_url: string };
                        window.open(body.sign_in_url, "_blank", "noopener,noreferrer");
                      } catch (err) {
                        console.error("[home] sign-in trigger failed:", err);
                      } finally {
                        setSigningIn(false);
                      }
                    }}
                  >
                    {signingIn ? "Opening sign-in…" : "Sign in"}
                  </button>
                </>
              ) : (
                <>No published artefacts yet — type <code>/p &lt;name&gt;</code> in the chat bar, or right-click any artefact and choose <strong>Publish…</strong></>
              )}
            </div>
          ) : artefactSource === "pinned" && filteredArtefactsTotal === 0 ? (
            <div className="home-empty">
              No pinned artefacts yet — right-click any artefact and choose <strong>Pin</strong> to keep it at the top of the surface.
            </div>
          ) : artefactsView === "icons" ? (
            <>
              <div className="home-artefacts">
                <Desktop
                  {...effectiveDesktopProps}
                  artifacts={visibleArtefacts}
                  isHero={false}
                  showMeta
                  flatten={artefactSource === "published" || artefactSource === "pinned"}
                  onArtifactClick={(a) => {
                  // Cloud-only ghosts have no local file — open the public URL
                  // (consistent with icon-view click behaviour in App.tsx).
                  if (a.cloudOnly) {
                    window.open(a.url, "_blank", "noopener,noreferrer");
                    return;
                  }
                  desktopProps.onArtifactClick(a);
                }}
                  onArtifactInspect={(a) => setActivePanel({ kind: "artefact", id: a.id })}
                />
              </div>
              {artefactsLimit < filteredArtefactsTotal && (
                <ShowMore
                  onClick={() => setArtefactsLimit((n) => n + ARTEFACTS_PREVIEW)}
                  remaining={filteredArtefactsTotal - artefactsLimit}
                  searchHint
                />
              )}
            </>
          ) : (
            <>
              <ArtefactTable
                artifacts={visibleArtefacts}
                spaces={spaces}
                onArtifactClick={(a) => {
                  // Cloud-only ghosts have no local file — open the public URL
                  // (consistent with icon-view click behaviour in App.tsx).
                  if (a.cloudOnly) {
                    window.open(a.url, "_blank", "noopener,noreferrer");
                    return;
                  }
                  desktopProps.onArtifactClick(a);
                }}
                onArtifactPublish={desktopProps.onArtifactPublish}
                onArtifactUpdate={desktopProps.onArtifactUpdate}
              />
              {artefactsLimit < filteredArtefactsTotal && (
                <ShowMore
                  onClick={() => setArtefactsLimit((n) => n + ARTEFACTS_PREVIEW)}
                  remaining={filteredArtefactsTotal - artefactsLimit}
                  searchHint
                />
              )}
            </>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-label">Memories</span>
            <span className="home-artefacts-count">{scopedMemories.length}</span>
            <span className="home-section-rule" />
            <button
              type="button"
              className="home-memories-refresh-btn"
              onClick={handleManualReconcile}
              disabled={reconciling}
              aria-label="Sync memories"
              title="Sync memories"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: 13, height: 13, display: "block", transition: "transform 0.6s linear", transform: reconciling ? "rotate(360deg)" : "none" }}
                aria-hidden="true"
              >
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            {lastSyncMessage && (
              <span className="home-memories-sync-msg">{lastSyncMessage}</span>
            )}
            <button
              type="button"
              className="home-memories-add-btn"
              onClick={() => setShowAddMemory((v) => !v)}
              aria-expanded={showAddMemory}
            >
              {showAddMemory ? "Cancel" : "+ Add memory"}
            </button>
          </div>
          {showAddMemory && (
            <AddMemoryForm
              defaultSpaceId={scopedSpace}
              spaces={spaces}
              onSaved={() => {
                setShowAddMemory(false);
                refreshMemories();
              }}
              onCancel={() => setShowAddMemory(false)}
            />
          )}
          {memoriesError ? (
            <div className="home-empty">
              Couldn't load memories: {memoriesError.message}
            </div>
          ) : memoriesLoading && memories.length === 0 ? (
            <div className="home-empty">Loading memories…</div>
          ) : scopedMemories.length === 0 ? (
            <div className="home-empty">
              No memories yet — agents store them via <code>remember</code>.
            </div>
          ) : (
            <div className="home-memories-wrap">
              <div className="home-memories">
                {scopedMemories.slice(0, memoriesLimit).map((m) => (
                  <MemoryCard
                    key={m.id}
                    memory={m}
                    spaces={spaces}
                    showSpaceChip={isMetaView}
                    onOpenSession={(id) => setActivePanel({ kind: "session", id })}
                    onRequestDelete={setPendingMemoryDelete}
                  />
                ))}
              </div>
              {memoriesLimit < scopedMemories.length && (
                <ShowMore
                  onClick={() => setMemoriesLimit((n) => n + MEMORIES_PREVIEW)}
                  remaining={scopedMemories.length - memoriesLimit}
                  searchHint
                />
              )}
            </div>
          )}
        </section>
        </>)}
      </div>
      <InspectorPanel active={activePanel} onClose={() => setActivePanel(null)}>
        {activePanel?.kind === "session" && (
          <SessionInspector
            sessionId={activePanel.id}
            focusEventId={activePanel.focusEventId}
            initialSearchQuery={activePanel.initialSearchQuery}
            onSwitchTo={setActivePanel}
            onOpenArtefact={(a) => desktopProps.onArtifactClick(a)}
            onClose={() => setActivePanel(null)}
            onNotFound={() => {
              setActivePanel(null);
              alert("Session no longer available");
            }}
            onLaunchClaude={onLaunchClaudeFromSession}
            onConnect={onConnectSession}
            onOpenInOyster={onOpenRemoteInOyster}
          />
        )}
        {activePanel?.kind === "artefact" && activeArtefact && (
          <ArtefactInspector
            artifact={activeArtefact}
            onSwitchTo={setActivePanel}
            onClose={() => setActivePanel(null)}
            onOpen={(a) => {
              setActivePanel(null);
              desktopProps.onArtifactClick(a);
            }}
          />
        )}
      </InspectorPanel>
      {attachPicker && onPromoteFolderToSpace && (() => {
        const meta = new Set(["home", "__all__", "__archived__"]);
        const candidates = spaces.filter((s) => !meta.has(s.id));
        const cwd = attachPicker.cwd;
        return (
          <AttachOrphanPopover
            path={cwd}
            anchorRect={attachPicker.rect}
            spaces={candidates}
            onClose={() => setAttachPicker(null)}
            onPickSpace={async (spaceId) => {
              if (promotingCwd) throw new Error("Another attach is already in progress");
              setPromotingCwd(cwd);
              try {
                // Server-side attachFolder is idempotent: adopts an
                // existing project by `.oyster/id` or by project_paths
                // cache, undeletes a soft-deleted match, falls back to
                // creating one only when nothing matches. Survives a
                // missing folder (writeOysterId failure is non-fatal).
                // Replaces the old createProject + claimOrphan pair
                // that minted duplicates on every press.
                await attachFolder(spaceId, cwd);
              } finally {
                setPromotingCwd(null);
              }
            }}
            onPromoteToNew={async () => {
              if (promotingCwd) throw new Error("Another attach is already in progress");
              setPromotingCwd(cwd);
              try {
                await onPromoteFolderToSpace(cwd);
              } finally {
                setPromotingCwd(null);
              }
            }}
          />
        );
      })()}
      {pillCtx && (() => {
        const target = spaces.find((s) => s.id === pillCtx.spaceId);
        if (!target) return null;
        return (
          <SpaceContextMenu
            spaceId={pillCtx.spaceId}
            spaceName={target.displayName}
            anchorRect={pillCtx.rect}
            onClose={() => setPillCtx(null)}
            onRename={(id, name) => onSpaceUpdate?.(id, { displayName: name })}
            onRequestDelete={(id) => setSpaceToDelete(id)}
          />
        );
      })()}
      {spaceToDelete && onSpaceDelete && (() => {
        const targetId = spaceToDelete;
        const displayName = spaces.find((s) => s.id === targetId)?.displayName ?? targetId;
        const sessionCount = sessions.filter((s) => s.spaceId === targetId).length;
        const artefactCount = desktopProps.artifacts.filter((a) => a.spaceId === targetId).length;
        const memoryCount = memories.filter((m) => m.space_id === targetId).length;
        const plural = (n: number, one: string, many: string) => n === 1 ? `1 ${one}` : `${n} ${many}`;
        const lines: React.ReactNode[] = [];
        if (sessionCount > 0) lines.push(<>{plural(sessionCount, "session", "sessions")} → Elsewhere</>);
        if (artefactCount > 0) lines.push(<>{plural(artefactCount, "artefact", "artefacts")} → Home, grouped under <strong>{displayName}</strong></>);
        if (memoryCount > 0) lines.push(<>{plural(memoryCount, "memory", "memories")} → Elsewhere (unbound from this space)</>);
        return (
          <ConfirmModal
            open={true}
            title={`Delete ${displayName}?`}
            body={
              lines.length === 0 ? (
                <><strong>{displayName}</strong> has no sessions, artefacts, or memories. It will be removed.</>
              ) : (
                <>
                  Linked folders will be detached. The space's contents will move:
                  <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                    {lines.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                </>
              )
            }
            confirmLabel="Delete space"
            destructive
            onConfirm={async () => {
              await onSpaceDelete(targetId);
              setSpaceToDelete(null);
            }}
            onCancel={() => setSpaceToDelete(null)}
          />
        );
      })()}
      <PromptModal
        open={addSpaceOpen}
        title="Name your space"
        initialValue=""
        placeholder="e.g. work, personal, tokinvest"
        confirmLabel="Create"
        onSubmit={async (name) => {
          const trimmed = name.trim();
          if (!trimmed) { setAddSpaceOpen(false); return; }
          try {
            const created = await createSpace(trimmed);
            setAddSpaceOpen(false);
            if (created?.id) onSpaceChange(created.id);
          } catch (err) {
            alert(`Couldn't create space: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
        onCancel={() => setAddSpaceOpen(false)}
      />
      {pendingMemoryDelete && (
        <ConfirmModal
          open={true}
          title="Forget this memory?"
          body={
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)", whiteSpace: "pre-wrap" }}>
              {pendingMemoryDelete.content}
            </div>
          }
          confirmLabel="Forget"
          destructive
          onConfirm={async () => {
            const target = pendingMemoryDelete;
            try {
              await deleteMemory(target.id);
            } catch (err) {
              // 404 means another tab already forgot it — same end state.
              const status = err instanceof ApiError ? err.status : null;
              if (status !== 404) {
                alert(`Couldn't forget memory: ${err instanceof Error ? err.message : String(err)}`);
                setPendingMemoryDelete(null);
                return;
              }
            }
            refreshMemories();
            setPendingMemoryDelete(null);
          }}
          onCancel={() => setPendingMemoryDelete(null)}
        />
      )}
    </div>
  );
}


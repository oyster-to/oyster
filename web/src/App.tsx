import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Home } from "./components/Home";
import { GroupPopup } from "./components/GroupPopup";
import { AskPanel } from "./components/AskPanel";
import { PublishModal } from "./components/PublishModal";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { SpotlightSearch } from "./components/SpotlightSearch";
import { SetupProposalPanel } from "./components/SetupProposalPanel";
import { windowsReducer } from "./stores/windows";
import {
  type Artifact,
  type ArtifactKind,
  fetchArtifacts,
  listArchivedArtifacts,
  startApp as startAppApi,
  stopApp as stopAppApi,
} from "./data/artifacts-api";
import { subscribeUiEvents } from "./data/ui-events";
import { shouldOpenFullscreen } from "../../shared/types";
import { fetchSpaces, updateSpace, deleteSpace, convertFolderToSpace, promoteFolderToSpace } from "./data/spaces-api";
import type { Space, SetupProposal } from "../../shared/types";
import { createSession, sendMessage } from "./data/chat-api";
import { unpublishArtifact } from "./data/publish-api";
import { launchAndOpen, humanError } from "./lib/launch-terminal";
import { recordRecentProjectId } from "./lib/new-session-recents";
import { useSessions } from "./hooks/useSessions";
import { NewSessionPicker } from "./components/NewSessionPicker";
import { useAllProjects, fetchAllProjects } from "./data/all-projects";
import { VAULT } from "./components/Home/types";
import { apiPath } from "./data/http";
import { caps } from "./caps";
import "./App.css";

// Client routes live under /app in the cloud build (oyster.to/app). Strip the
// base before parsing a pathname, and re-add it on every history write so the
// route logic below can stay base-agnostic. Both are no-ops locally
// (routeBase === "").
const stripBase = (pathname: string) =>
  caps.routeBase && (pathname === caps.routeBase || pathname.startsWith(caps.routeBase + "/"))
    ? pathname.slice(caps.routeBase.length) || "/"
    : pathname;
const withBase = (path: string) => `${caps.routeBase}${path}`;

// `?onboarding=force` wipes the dock's persisted state and pretends this
// is a fresh install — lets us iterate on 0/3 hero copy without touching
// the real userland. Gated on `import.meta.env.DEV` so it's a strict
// no-op in production builds (Vite dead-code-strips the block). Runs
// synchronously at module load so the clear happens before
// <OnboardingDock> reads localStorage in its useState initialiser.
const FORCE_ONBOARDING = import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("onboarding") === "force";
if (FORCE_ONBOARDING) {
  try {
    localStorage.removeItem("oyster-onboarding-state");
  } catch { /* privacy-mode browsers can throw — matches OnboardingDock */ }
}

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [publishingArtifact, setPublishingArtifact] = useState<Artifact | null>(null);
  const getUrlState = useCallback((): { space: string; artifactId: string | null; groupName: string | null; hash: string; projectId: string | null } => {
    const path = stripBase(window.location.pathname);
    const artifactMatch = path.match(/^\/s\/([^/]+)\/a\/([^/]+)$/);
    if (artifactMatch) {
      return { space: artifactMatch[1], artifactId: artifactMatch[2], groupName: null, hash: window.location.hash || "", projectId: null };
    }
    const groupMatch = path.match(/^\/s\/([^/]+)\/g\/([^/]+)$/);
    if (groupMatch) {
      return { space: groupMatch[1], artifactId: null, groupName: decodeURIComponent(groupMatch[2]), hash: "", projectId: null };
    }
    const projectMatch = path.match(/^\/s\/([^/]+)\/p\/([^/]+)$/);
    if (projectMatch) {
      return { space: projectMatch[1], artifactId: null, groupName: null, hash: "", projectId: decodeURIComponent(projectMatch[2]) };
    }
    const spaceMatch = path.match(/^\/s\/([^/]+?)\/?$/);
    return { space: spaceMatch ? spaceMatch[1] : "home", artifactId: null, groupName: null, hash: "", projectId: null };
  }, []);

  const [activeSpace, setActiveSpace] = useState<string>(() => getUrlState().space);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => getUrlState().projectId);

  // Project scope is URL-addressable: /s/<space>/p/<projectId> (VAULT's
  // sentinel "__vault__" rides along unescaped-safe via encodeURIComponent).
  const handleProjectScopeChange = useCallback((projectId: string | null) => {
    setActiveProjectId(projectId);
    const target = projectId
      ? `/s/${activeSpace}/p/${encodeURIComponent(projectId)}`
      : `/s/${activeSpace}`;
    if (stripBase(window.location.pathname) !== target) {
      window.history.pushState(null, "", withBase(target));
    }
  }, [activeSpace]);

  const [spotlightOpen, setSpotlightOpen] = useState(false);
  // Open on /session/<id> loads: useChatSession restores that conversation
  // into the panel, so the panel must be visible for the restore to mean
  // anything ("refresh reloads this conversation").
  const [askOpen, setAskOpen] = useState(() => window.location.pathname.startsWith("/session/"));
  // Latch: once the panel has opened, keep the projects list warm — the
  // useFetched-backed hook resets to [] on disable, which would blank the
  // scope chip/context for a beat on every reopen.
  const [askEverOpened, setAskEverOpened] = useState(() => window.location.pathname.startsWith("/session/"));

  // OnboardingDock's "Set up Oyster" (and any oyster:send-prompt dispatcher)
  // lands in the Ask panel — make sure the panel is visible when it does.
  // AskPanel's own listener handles the actual send.
  useEffect(() => {
    const handler = () => { setAskOpen(true); setAskEverOpened(true); };
    window.addEventListener("oyster:send-prompt", handler);
    return () => window.removeEventListener("oyster:send-prompt", handler);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Spotlight is unmounted in cloud (caps.canChat false), so ⌘K would
      // toggle dead state with nothing to render — keep the shortcut inert there.
      if (caps.canChat && (e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightOpen((v) => !v);
      }
      if (e.key === "Escape") { setSpotlightOpen(false); setAskOpen(false); }
    }
    document.addEventListener("keydown", handleKeyDown);
    // Prevent browser from opening dropped files/folders (but allow text drops)
    function preventFileDrop(e: DragEvent) {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }
    document.addEventListener("dragover", preventFileDrop);
    document.addEventListener("drop", preventFileDrop);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("dragover", preventFileDrop);
      document.removeEventListener("drop", preventFileDrop);
    };
  }, []);

  // Redirect bare `/` to `/s/home` so every space has a uniform URL
  useEffect(() => {
    if (stripBase(window.location.pathname) === "/") {
      window.history.replaceState(null, "", withBase("/s/home"));
    }
  }, []);
  const [, setLoaded] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(() => getUrlState().groupName);
  // Auto-close the group popup when the group goes empty (e.g. the user
  // archived the last artifact from within it). Without this, the popup
  // keeps rendering an empty shell until the user manually dismisses.
  useEffect(() => {
    if (!openGroup) return;
    const stillHas = artifacts.some(
      (a) =>
        a.groupName?.toLowerCase() === openGroup.toLowerCase() &&
        (activeSpace === "__all__" || activeSpace === "__archived__" || a.spaceId === activeSpace),
    );
    if (!stillHas) setOpenGroup(null);
  }, [artifacts, openGroup, activeSpace]);
  const [viewerHash, setViewerHash] = useState<string>(() => getUrlState().hash);
  const [connected, setConnected] = useState(true);
  const [aiError, setAiError] = useState<string | null>(null);
  // Active proposal from the agent's `propose_setup` MCP tool (broadcast
  // via SSE). Standalone overlay — not coupled to the chat. Triggered by
  // the agent during first-run setup; cleared on Apply / Close.
  const [setupProposal, setSetupProposal] = useState<SetupProposal | null>(null);

  // Active-space-aware artifact loader. Mirrors current activeSpace via a ref
  // so callers don't have to thread it through every closure (polling,
  // onRefresh, mutation handlers all call loadArtifacts with no args).
  const isArchivedView = activeSpace === "__archived__";
  const activeSpaceRef = useRef(activeSpace);
  useEffect(() => { activeSpaceRef.current = activeSpace; }, [activeSpace]);
  const loadArtifacts = useCallback(() => {
    return activeSpaceRef.current === "__archived__"
      ? listArchivedArtifacts()
      : fetchArtifacts();
  }, []);

  // Refetch whenever the mode toggles (archive ↔ normal) so the view flips
  // to the right dataset instantly rather than waiting for the next poll.
  // Skip the initial mount — the separate mount effect below handles that
  // fetch, and firing both racing fetches at startup would waste a round-
  // trip and leave the faster result under-written by the slower one.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    loadArtifacts()
      .then((a) => { setArtifacts(a); setConnected(true); })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[oyster] failed to refetch on mode toggle:", msg);
        setConnected(false);
      });
  }, [isArchivedView, loadArtifacts]);

  // Fetch artifacts + spaces on mount; auto-open artifact if URL contains one
  useEffect(() => {
    loadArtifacts().then((a) => {
      setArtifacts(a);
      setLoaded(true);
      setConnected(true);
      const { artifactId } = getUrlState();
      if (artifactId) {
        const artifact = a.find((x) => x.id === artifactId);
        if (artifact) {
          const fullscreen = shouldOpenFullscreen(artifact.artifactKind);
          dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
        }
      }
    }).catch((err) => { console.warn("[oyster] server unreachable:", err.message); setLoaded(true); setConnected(false); });
    fetchSpaces().then(setSpaces).catch(() => setConnected(false));
  }, []);

  // Poll for status updates every 5 seconds; handle pending reveals
  useEffect(() => {
    const interval = setInterval(() => {
      loadArtifacts().then((arts) => {
        setArtifacts(arts);
        setConnected(true);
        const revealed = arts.find((a) => a.pendingReveal);
        if (revealed) {
          setActiveSpace(revealed.spaceId);
          setActiveProjectId(null);
          window.history.pushState(null, "", withBase(`/s/${revealed.spaceId}`));
          if (revealed.groupName) setOpenGroup(revealed.groupName);
          setRevealId(revealed.id);
          setTimeout(() => setRevealId(null), 3000);
        }
      }).catch(() => setConnected(false));
      fetchSpaces().then(setSpaces).catch(() => setConnected(false));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to server-pushed UI commands (open artifact, switch space).
  // Uses the shared ui-events subscription so we don't hold a second
  // EventSource alongside OnboardingDock's.
  useEffect(() => subscribeUiEvents((event) => {
    if (event.command === "open_artifact") {
      const { spaceId, label, url, artifactKind, id } = event.payload as { spaceId: string; label: string; url: string; artifactKind: ArtifactKind; id: string };
      setActiveSpace(spaceId);
      setActiveProjectId(null);
      window.history.pushState(null, "", withBase(`/s/${spaceId}/a/${id}`));
      dispatch({ type: "CLOSE_ALL_VIEWERS" });
      dispatch({ type: "OPEN_VIEWER", title: label, path: url, fullscreen: shouldOpenFullscreen(artifactKind) });
    }
    if (event.command === "switch_space") {
      const { spaceId } = event.payload as { spaceId: string };
      setActiveSpace(spaceId);
      setActiveProjectId(null);
      window.history.pushState(null, "", withBase(`/s/${spaceId}`));
      dispatch({ type: "CLOSE_ALL_VIEWERS" });
    }
    if (event.command === "artifact_changed") {
      void loadArtifacts()
        .then(setArtifacts)
        .catch((err) => console.warn("[oyster] artifact_changed refetch failed:", err));
      return;
    }
    if (event.command === "setup_proposal_ready") {
      setSetupProposal(event.payload as SetupProposal);
    }
    if (event.command === "setup_applied") {
      // Another tab just applied a setup proposal. Refresh spaces +
      // artefacts so this tab reflects what the apply created without
      // waiting for the regular polling tick.
      void fetchSpaces().then(setSpaces).catch(() => undefined);
      void loadArtifacts().then(setArtifacts).catch(() => undefined);
    }
    if (event.command === "terminal_session_linked") {
      const { terminalId, sessionId } = event.payload as { terminalId: string; sessionId: string };
      dispatch({ type: "LINK_TERMINAL_SESSION", terminalId, sessionId });
    }
    if (event.command === "open_session") {
      // Mirror Spotlight: re-dispatch as the window event Home already
      // listens for. No route push — Home is always mounted, so this opens
      // the inspector from any space. eventId → focusEventId, query →
      // initialSearchQuery; both best-effort (a stale eventId still opens).
      const { sessionId, eventId, query } = event.payload as {
        sessionId: string; eventId?: number; query?: string;
      };
      window.dispatchEvent(new CustomEvent("oyster:open-session", {
        detail: { id: sessionId, eventId, query },
      }));
    }
  }), [loadArtifacts]);

  // Sync state from browser back/forward
  useEffect(() => {
    function handlePopState() {
      // /session/<id> URLs carry no space/project — landing on one via
      // back/forward must not stomp the active scope (the thread that
      // pushed it is still about wherever the user was). It must, however,
      // show the thread the URL refers to (mirrors the initial-load seed).
      if (window.location.pathname.startsWith("/session/")) {
        setAskOpen(true);
        setAskEverOpened(true);
        return;
      }
      const { space, artifactId, groupName, projectId } = getUrlState();
      setActiveSpace(space);
      setActiveProjectId(projectId);
      setOpenGroup(groupName);
      if (!artifactId) {
        dispatch({ type: "CLOSE_ALL_VIEWERS" });
      } else {
        const artifact = artifacts.find((a) => a.id === artifactId);
        if (artifact) {
          const hash = window.location.hash || "";
          const fullscreen = shouldOpenFullscreen(artifact.artifactKind);
          setViewerHash(hash);
          dispatch({ type: "CLOSE_ALL_VIEWERS" });
          dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
        }
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
    // `artifacts` in deps: the handler resolves /a/<id> URLs against it, so a
    // once-registered listener would hold the first render's empty array and
    // never reopen a viewer on back/forward. Re-registering per update is cheap.
  }, [getUrlState, artifacts]);

  // Push URL when space changes via pill click
  const handleSpaceChange = useCallback((space: string) => {
    const target = `/s/${space}`;
    if (stripBase(window.location.pathname) !== target) {
      window.history.pushState(null, "", withBase(target));
    }
    setActiveSpace(space);
    setActiveProjectId(null);
    setOpenGroup(null);
  }, []);

  const handleSpaceUpdate = useCallback(async (id: string, fields: { displayName?: string; color?: string }) => {
    try {
      const updated = await updateSpace(id, fields);
      setSpaces((prev) => prev.map((s) => s.id === id ? updated : s));
    } catch (err) {
      console.error("[space] update failed:", err);
    }
  }, []);

  const handleSpaceDelete = useCallback(async (id: string, folderName?: string) => {
    try {
      await deleteSpace(id, folderName);
      setSpaces((prev) => prev.filter((s) => s.id !== id));
      if (activeSpace === id) handleSpaceChange("home");
    } catch (err) {
      console.error("[space] delete failed:", err);
    }
  }, [activeSpace, handleSpaceChange]);

  const handleConvertToSpace = useCallback(async (groupName: string, merge?: boolean, sourceSpaceId?: string) => {
    try {
      const newSpace = await convertFolderToSpace(groupName, sourceSpaceId ?? activeSpace, merge);
      setSpaces((prev) => prev.some(s => s.id === newSpace.id) ? prev : [...prev, newSpace]);
      handleSpaceChange(newSpace.id);
    } catch (err) {
      console.error("[space] convert folder failed:", err);
    }
  }, [activeSpace, handleSpaceChange]);

  const handlePromoteFolderToSpace = useCallback(async (path: string): Promise<Space | null> => {
    try {
      const newSpace = await promoteFolderToSpace(path);
      setSpaces((prev) => prev.some(s => s.id === newSpace.id) ? prev : [...prev, newSpace]);
      handleSpaceChange(newSpace.id);
      return newSpace;
    } catch (err) {
      console.error("[space] promote folder failed:", err);
      return null;
    }
  }, [handleSpaceChange]);


  const viewers = windows.filter((w) => w.type === "viewer");
  const claudeTerminals = windows.filter((w) => w.type === "claude_terminal");
  // Tabs in the fullscreen terminal toolbar list every open terminal so
  // the user can switch without leaving fullscreen.
  const liveTerminals: Array<{ id: string; title: string }> = [
    ...claudeTerminals.map((t) => ({ id: t.id, title: t.title || "claude" })),
  ];

  const { sessions: allSessions, loading: sessionsLoading, error: sessionsError } = useSessions();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [initialPickerQuery, setInitialPickerQuery] = useState<string | undefined>(undefined);
  const { projects: allProjects, loading: allProjectsLoading } = useAllProjects(pickerOpen || askOpen || askEverOpened);

  // Scope label + outbound-context line for the Ask panel. Label mirrors the
  // Home crumb shapes; context is what the agent actually reads — omitted at
  // "everything" so unscoped chats stay clean.
  const askScope = useMemo((): { label: string; context: string | null } => {
    if (activeSpace === "__archived__") {
      return { label: "archived", context: "[Scope: the user is browsing archived artefacts.]" };
    }
    if (activeProjectId === VAULT) {
      return {
        label: "vault",
        context: `[Scope: the user is viewing the Vault — artefacts created in Oyster itself, not tied to a repo.]`,
      };
    }
    const project = activeProjectId ? allProjects.find((p) => p.id === activeProjectId) ?? null : null;
    const spaceId = project?.spaceId ?? (activeSpace !== "home" && activeSpace !== "__all__" && activeSpace !== "__archived__" ? activeSpace : null);
    const spaceName = spaceId ? spaces.find((s) => s.id === spaceId)?.displayName ?? spaceId : null;
    if (project) {
      return {
        label: `${spaceName ? spaceName + " › " : ""}${project.name}`,
        context: `[Scope: ${spaceName ? `space "${spaceName}", ` : ""}project "${project.name}"${project.recentPath ? ` at ${project.recentPath}` : ""}.]`,
      };
    }
    if (spaceName) {
      return { label: spaceName, context: `[Scope: space "${spaceName}".]` };
    }
    return { label: "everything", context: null };
  }, [activeProjectId, activeSpace, allProjects, spaces]);

  // Shared spawn path used by NewSessionPicker — same as
  // handleLaunchClaudeFromProject but renders errors in-modal instead
  // of via alert(), since the picker is open and visible.
  const handleNewSessionSpawn = useCallback(
    async (projectId: string): Promise<boolean> => {
      setPickerError(null);
      const outcome = await launchAndOpen(
        { kind: "claude_new", source: { type: "project", id: projectId } },
        dispatch,
      );
      if (outcome.ok) {
        recordRecentProjectId(projectId);
        setPickerOpen(false);
        return true;
      }
      const hint = outcome.installHint ? ` (${outcome.installHint})` : "";
      setPickerError(`${humanError(outcome.error)}${hint}`);
      return false;
    },
    [],
  );

  const handleOpenNewSession = useCallback(async () => {
    if (activeSpace === "home" || activeSpace === "__all__" || activeSpace === "__archived__") {
      setInitialPickerQuery(undefined);
      setPickerOpen(true);
      return;
    }
    // Inside a real space: count live-folder projects to decide.
    try {
      const all = await fetchAllProjects();
      const inSpace = all.filter((p) => p.spaceId === activeSpace && p.hasLivePath !== false);
      if (inSpace.length === 1) {
        // Spawn silently — no palette. On success we return; on failure
        // we fall through to open the palette so the user sees the error.
        const ok = await handleNewSessionSpawn(inSpace[0].id);
        if (ok) return;
      }
      // 0 or 2+ → open palette. Pre-fill with the space name when 2+.
      const space = spaces.find((s) => s.id === activeSpace);
      setInitialPickerQuery(inSpace.length >= 2 ? (space?.displayName ?? "") : undefined);
      setPickerOpen(true);
    } catch (err) {
      // Network failure — open the palette with the error so the user
      // can retry / pick manually.
      setPickerError(err instanceof Error ? err.message : String(err));
      setPickerOpen(true);
    }
  }, [activeSpace, spaces, dispatch, handleNewSessionSpawn]);

  // ⌘/ (or Ctrl+/ off-Mac) opens the New Session palette. Unconditional —
  // intercepts even inside text inputs, textareas, contenteditable, and
  // the xterm.js helper textarea. Single-letter combos were considered
  // and rejected: ⌘N / ⌘T / ⌘W / ⌘L / ⌘D / ⌘` are browser- or OS-reserved
  // (uninterceptable), ⌘K is taken by Spotlight, ⌘E collides with the
  // Claude-in-Chrome extension. ⌘/ has no Chrome or macOS reserved use
  // and is unlikely to collide with extensions.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      // Only the bare combo — ignore shift/alt variants so we don't trample
      // any chord shortcut a user has come to expect.
      if (caps.canChat && cmd && !e.shiftKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        void handleOpenNewSession();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleOpenNewSession]);

  async function handleArtifactClick(artifact: Artifact) {
    if (artifact.status === "generating") return;

    // Cloud-only ghost: this user's publication, no local artefact backing it.
    // Click opens the public URL so they can verify what's live without a
    // local copy. (Pro lazy-pulls bytes on edit; that's R7 in 0.9.0.)
    if (artifact.cloudOnly) {
      window.open(artifact.url, "_blank", "noopener,noreferrer");
      return;
    }

    if (artifact.runtimeKind === "redirect") {
      window.open(artifact.url, "_blank");
      return;
    }

    if (artifact.runtimeKind === "local_process") {
      // Managed app with a dev server
      if (artifact.status === "starting") return;

      if (artifact.status === "online") {
        window.open(artifact.url, artifact.id, "width=1280,height=900");
        return;
      }

      // offline — optimistically set to starting, then start
      setArtifacts((prev) =>
        prev.map((a) =>
          a.id === artifact.id ? { ...a, status: "starting" as const } : a
        )
      );
      const appName = artifact.id.replace("app:", "");
      await startAppApi(appName);
      window.open(artifact.url, artifact.id, "width=1280,height=900");
    } else {
      // Static artifact (generated app, doc, deck, diagram, etc.) — open in viewer
      const fullscreen = shouldOpenFullscreen(artifact.artifactKind);
      dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
      setViewerHash("");
      window.history.pushState(null, "", withBase(`/s/${activeSpace}/a/${artifact.id}`));
    }
  }

  async function handleArtifactStop(artifact: Artifact) {
    const appName = artifact.id.replace("app:", "");
    await stopAppApi(appName);
  }

  // Spawn an in-app Claude PTY for a project. Failures (missing binary,
  // homeless project, cap reached) are surfaced via a simple alert with
  // copy guidance — the binary-missing case has the install hint.
  const handleLaunchClaudeFromProject = useCallback(async (projectId: string) => {
    const outcome = await launchAndOpen(
      { kind: "claude_new", source: { type: "project", id: projectId } },
      dispatch,
    );
    if (!outcome.ok) {
      const hint = outcome.installHint ? `\n\n${outcome.installHint}` : "";
      alert(`${humanError(outcome.error)}${hint}`);
    }
  }, []);

  const handleLaunchClaudeFromSession = useCallback(
    async (sessionId: string) => {
      const outcome = await launchAndOpen(
        { kind: "claude_resume", source: { type: "session", id: sessionId } },
        dispatch,
      );
      if (!outcome.ok) {
        const hint = outcome.installHint ? `\n\n${outcome.installHint}` : "";
        alert(`${humanError(outcome.error)}${hint}`);
      }
    },
    [],
  );

  // Connect = focus/restore an already-running PTY for a session, used by
  // the SessionInspector's primary action and any caller that has a
  // sessionId (not just a terminalId). Quietly no-ops when there's no
  // live PTY — callers gate the affordance themselves.
  const handleConnectSession = useCallback(
    (sessionId: string) => {
      const session = allSessions.find((s) => s.id === sessionId);
      if (!session?.terminalId) return;
      const w = windows.find((win) => win.terminalId === session.terminalId);
      if (w) {
        dispatch({ type: "FOCUS", id: w.id });
        return;
      }
      dispatch({
        type: "OPEN_CLAUDE_TERMINAL",
        terminalId: session.terminalId,
        title: session.title ?? "Claude",
        cwd: session.cwd ?? "/",
        kind: "claude_resume",
        linkedSessionId: sessionId,
      });
    },
    [allSessions, windows],
  );

  // Remote-session "Open in Oyster" path (from ResumeDialog). Source is
  // `remote_session`: server resolves the cwd from the reassembled jsonl on
  // disk, so the dialog doesn't need to pass the cwd back. The dialog
  // surfaces the error inline (so the user can still copy the command),
  // so we return rather than alert.
  const handleOpenRemoteInOyster = useCallback(
    async (sessionId: string) => {
      const outcome = await launchAndOpen(
        { kind: "claude_resume", source: { type: "remote_session", id: sessionId } },
        dispatch,
      );
      if (!outcome.ok) {
        return { ok: false, error: humanError(outcome.error), installHint: outcome.installHint };
      }
      return { ok: true };
    },
    [],
  );

  const handleArtifactPublish = useCallback((artifact: Artifact) => {
    if (artifact.builtin || artifact.plugin || artifact.status === "generating") return;
    setPublishingArtifact(artifact);
  }, []);

  // /u path. SSE drives the surface (chip hides, count drops); on failure
  // we surface via the same banner the chat bar already uses for AI errors —
  // the user's last action came from the chat surface, so the banner is in
  // their eyeline.
  const handleArtifactUnpublish = useCallback(async (artifact: Artifact) => {
    if (artifact.publication == null || artifact.publication.unpublishedAt != null) return;
    try {
      await unpublishArtifact(artifact.id);
    } catch (err) {
      setAiError(`Unpublish failed: ${(err as Error).message}`);
    }
  }, []);
  async function handleFixError(error: { title: string; path: string; message: string; stack: string; console: Array<{ type: string; message: string }> }): Promise<string> {
    // Use a fresh session so Oyster has clean context for the fix
    const session = await createSession();
    const consoleText = error.console.length > 0
      ? "\n\nRecent console output:\n" + error.console.map((e) => `[${e.type}] ${e.message}`).join("\n")
      : "";

    // Try to resolve the actual file path from the server
    let fileHint = "";
    try {
      const res = await fetch(apiPath(`/api/resolve-path?url=${encodeURIComponent(error.path)}`));
      if (res.ok) {
        const data = await res.json();
        if (data.filePath) fileHint = `\n\nThe source file is: ${data.filePath}`;
      }
    } catch { /* best effort */ }

    const message = `The artifact "${error.title}" (served at ${error.path}) crashed with an error:\n\n${error.stack || error.message}${consoleText}${fileHint}\n\nPlease fix this error in the artifact source code.`;
    await sendMessage(session.id, message);
    return session.id;
  }

  return (
    <div className={`oyster-shell${caps.canChat ? "" : " oyster-shell--no-chatbar"}`}>
      {!connected && (
        <div className="connection-banner">
          <span>Oyster server not connected</span>
          <span className="connection-hint">Run <code>oyster</code> to start</span>
        </div>
      )}
      {connected && aiError && (
        <div className="connection-banner ai-error-banner">
          <span>{aiError}</span>
        </div>
      )}
      <NewSessionPicker
        open={pickerOpen}
        onClose={() => { setPickerOpen(false); setPickerError(null); setInitialPickerQuery(undefined); }}
        initialQuery={initialPickerQuery}
        projects={allProjects}
        spaces={spaces}
        errorMessage={pickerError}
        activeSpaceId={activeSpace}
        loading={allProjectsLoading}
        onActivate={(p) => handleNewSessionSpawn(p.id)}
        onActivateAttached={handleNewSessionSpawn}
      />
      <Home
        activeSpace={activeSpace}
        spaces={spaces}
        onSpaceChange={handleSpaceChange}
        selectedProjectId={activeProjectId}
        onSelectProject={handleProjectScopeChange}
        onPromoteFolderToSpace={handlePromoteFolderToSpace}
        onSpaceDelete={handleSpaceDelete}
        onSpaceUpdate={handleSpaceUpdate}
        onLaunchClaude={handleLaunchClaudeFromProject}
        onLaunchClaudeFromSession={handleLaunchClaudeFromSession}
        onOpenRemoteInOyster={handleOpenRemoteInOyster}
        onOpenArtifact={(id) => {
          const artifact = artifacts.find((a) => a.id === id);
          if (artifact) void handleArtifactClick(artifact);
        }}
        sessions={allSessions}
        sessionsLoading={sessionsLoading}
        sessionsError={sessionsError}
        terminalWindows={claudeTerminals}
        onTerminalFocus={(terminalId) => {
          const w = windows.find(w => w.terminalId === terminalId);
          if (w) dispatch({ type: "FOCUS", id: w.id });
        }}
        onTerminalRestore={(sessionId, terminalId) => {
          const session = allSessions.find(s => s.id === sessionId);
          dispatch({
            type: "OPEN_CLAUDE_TERMINAL",
            terminalId,
            title: session?.title ?? "Claude",
            cwd: session?.cwd ?? "/",
            kind: "claude_resume",
            linkedSessionId: sessionId,
          });
        }}
        onTerminalStop={async (terminalId) => {
          await fetch(apiPath(`/api/terminals/${encodeURIComponent(terminalId)}`), { method: "DELETE" });
          // Also close any open panel for this terminal — Stop is a finish
          // action; the user doesn't need the dead panel hanging around.
          const w = windows.find((x) => x.terminalId === terminalId);
          if (w) dispatch({ type: "CLOSE", id: w.id });
        }}
        onOpenNewSession={handleOpenNewSession}
        onOpenAsk={caps.canChat ? () => { setAskOpen(true); setAskEverOpened(true); } : undefined}
        onConnectSession={handleConnectSession}
        userSpaceCount={FORCE_ONBOARDING ? 0 : spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__").length}
        publishedCount={FORCE_ONBOARDING ? 0 : artifacts.filter((a) => a.publication != null && a.publication.unpublishedAt == null).length}
        desktopProps={{
          space: activeSpace,
          spaces: spaces.map((s) => s.id),
          // Home is the unscoped feed (matches the prototype's only-pill model
          // — see #252). Per-space pills scope. __all__ kept as alias for old
          // bookmarks; __archived__ stays as its own meta-view.
          artifacts: (activeSpace === "home" || activeSpace === "__all__" || activeSpace === "__archived__")
            ? artifacts
            : artifacts.filter((a) => a.spaceId === activeSpace),
          isArchivedView,
          onArtifactClick: handleArtifactClick,
          onArtifactStop: handleArtifactStop,
          onGroupClick: (name) => {
            setOpenGroup(name);
            window.history.pushState(null, "", withBase(`/s/${activeSpace}/g/${encodeURIComponent(name.toLowerCase())}`));
          },
          onSpaceChange: handleSpaceChange,
          onConvertToSpace: handleConvertToSpace,
          onRefresh: () =>
            loadArtifacts()
              .then((nextArtifacts) => { setArtifacts(nextArtifacts); setConnected(true); })
              .catch(() => setConnected(false)),
          onArtifactUpdate: (id, fields) =>
            setArtifacts((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a))),
          onArtifactRemove: (id) =>
            setArtifacts((prev) => prev.filter((a) => a.id !== id)),
          revealId,
          onArtifactPublish: handleArtifactPublish,
        }}
      />

      <div className="windows-layer">
        {viewers.map((w, i) => {
          const isUnscoped = activeSpace === "home" || activeSpace === "__all__";
          const docArtifacts = isUnscoped
            ? artifacts.filter((a) => a.artifactKind !== "app")
            : artifacts.filter((a) => a.artifactKind !== "app" && a.spaceId === activeSpace);
          const currentIdx = docArtifacts.findIndex((a) => a.url === w.artifactPath);
          const hasPrev = currentIdx > 0;
          const hasNext = currentIdx >= 0 && currentIdx < docArtifacts.length - 1;
          const viewerArtifact = currentIdx >= 0 ? docArtifacts[currentIdx] : undefined;

          return (
            <ViewerWindow
              key={w.id}
              title={w.title}
              path={w.artifactPath!}
              defaultX={200 + i * 20}
              defaultY={40 + i * 20}
              zIndex={w.zIndex}
              fullscreen={w.fullscreen}
              onFocus={() => dispatch({ type: "FOCUS", id: w.id })}
              onClose={() => {
                dispatch({ type: "CLOSE", id: w.id });
                window.history.pushState(null, "", withBase(`/s/${activeSpace}`));
              }}
              onToggleFullscreen={() => dispatch({ type: "TOGGLE_FULLSCREEN", id: w.id })}
              hasPrev={hasPrev}
              hasNext={hasNext}
              initialHash={viewerHash}
              onHashChange={(hash) => {
                setViewerHash(hash);
                window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
              }}
              onFixError={handleFixError}
              onShare={viewerArtifact ? () => handleArtifactPublish(viewerArtifact) : undefined}
              shareDisabled={!viewerArtifact || viewerArtifact.builtin || viewerArtifact.plugin || viewerArtifact.status === "generating"}
              shareLabel={viewerArtifact?.publication?.unpublishedAt === null ? "Published" : "Publish"}
              onNavigate={(dir) => {
                const nextIdx = currentIdx + dir;
                const next = docArtifacts[nextIdx];
                if (next) {
                  dispatch({
                    type: "NAVIGATE_VIEWER",
                    id: w.id,
                    title: next.label,
                    artifactPath: next.url,
                  });
                  window.history.replaceState(null, "", withBase(`/s/${activeSpace}/a/${next.id}`));
                }
              }}
            />
          );
        })}
        {caps.canChat && claudeTerminals.map((w, i) => {
          // PTY alive iff some session row reports this terminalId as live.
          // After Stop / natural exit / cross-tab kill, the server clears
          // session.terminalId on the linked row, so this flips to false.
          const ptyAlive = w.terminalId
            ? allSessions.some((s) => s.terminalId === w.terminalId)
            : true; // legacy non-Claude terminals always treat × as minimise
          return (
            <TerminalWindow
              key={w.id}
              id={w.id}
              defaultX={140 + i * 24}
              defaultY={80 + i * 24}
              zIndex={w.zIndex}
              onFocus={() => dispatch({ type: "FOCUS", id: w.id })}
              onClose={() => dispatch({ type: ptyAlive ? "MINIMISE" : "CLOSE", id: w.id })}
              fullscreen={w.fullscreen}
              onToggleFullscreen={() => dispatch({ type: "TOGGLE_FULLSCREEN", id: w.id })}
              liveTerminals={liveTerminals}
              onSwitchTerminal={(targetId) => dispatch({ type: "SWITCH_FULLSCREEN_TERMINAL", id: targetId })}
              terminalId={w.terminalId}
              title={w.title}
              linkedSessionId={w.linkedSessionId}
              ptyAlive={ptyAlive}
              onStop={ptyAlive && w.terminalId ? async () => {
                await fetch(apiPath(`/api/terminals/${encodeURIComponent(w.terminalId!)}`), { method: "DELETE" });
                // Close the panel too — Stop is a finish action, not a pause.
                dispatch({ type: "CLOSE", id: w.id });
              } : undefined}
              onOpenSession={(sessionId) => {
                // Route to /s/<space>/sessions/<id>; the space prefix is required
                // by the active routing today, so use the current activeSpace
                // (the session inspector itself does its own resolve).
                window.history.pushState(null, "", withBase(`/s/${activeSpace}/sessions/${sessionId}`));
                // Nudge the router (mirrors how artifact navigation triggers
                // a popstate elsewhere).
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
            />
          );
        })}
      </div>

      {publishingArtifact && (() => {
        const fresh = artifacts.find((a) => a.id === publishingArtifact.id) ?? publishingArtifact;
        return <PublishModal artifact={fresh} onClose={() => setPublishingArtifact(null)} />;
      })()}

      {openGroup && (() => {
        // In __all__ and __archived__ views, artifacts have real space_ids
        // (home, oyster, …) — not the meta-space's id. Skip the space-match
        // filter in those cases; the `artifacts` prop is already scoped to
        // the right dataset (all artifacts, or archived artifacts).
        const isMetaSpace = activeSpace === "__all__" || activeSpace === "__archived__";
        const groupArtifacts = artifacts.filter(
          (a) => (isMetaSpace || a.spaceId === activeSpace) && a.groupName?.toLowerCase() === openGroup.toLowerCase()
        );
        const displayName = groupArtifacts[0]?.groupName || openGroup;
        return (
        <GroupPopup
          name={displayName}
          artifacts={groupArtifacts}
          onArtifactClick={(artifact) => {
            if (artifact.runtimeKind !== "local_process") {
              setOpenGroup(null);
            }
            handleArtifactClick(artifact);
          }}
          onArtifactStop={handleArtifactStop}
          onClose={() => {
            setOpenGroup(null);
            window.history.pushState(null, "", withBase(`/s/${activeSpace}`));
          }}
        />
        );
      })()}

      {/* Gated off in cloud (caps.canChat false): no chat engine to talk to,
          so the panel + its oyster:send-prompt listener aren't needed. When
          on, it's always mounted so the thread + SSE stream live in the
          panel's hooks and the listener exists before the panel opens —
          conditional-on-`open` mounting would lose both. */}
      {caps.canChat && (
        <AskPanel
          open={askOpen}
          onClose={() => setAskOpen(false)}
          scopeLabel={askScope.label}
          scopeContext={askScope.context}
          spaces={spaces}
          activeSpace={activeSpace}
          onSpaceChange={handleSpaceChange}
          artifacts={artifacts}
          onArtifactOpen={handleArtifactClick}
          onArtifactPublish={handleArtifactPublish}
          onArtifactUnpublish={handleArtifactUnpublish}
          onAiError={setAiError}
        />
      )}

      {caps.canChat && spotlightOpen && (
        <SpotlightSearch
          artifacts={artifacts}
          spaces={spaces}
          onOpen={handleArtifactClick}
          onClose={() => setSpotlightOpen(false)}
        />
      )}

      {caps.canWrite && setupProposal && (
        <SetupProposalPanel
          proposal={setupProposal}
          onClose={() => setSetupProposal(null)}
          onApplied={() => {
            // Refresh spaces + artefacts so the surface reflects the new
            // structure immediately. The server's `setup_applied` SSE event
            // can also fan out to other tabs; this branch handles the apply
            // tab itself.
            void fetchSpaces().then(setSpaces).catch(() => undefined);
            void loadArtifacts().then(setArtifacts).catch(() => undefined);
            setSetupProposal(null);
          }}
        />
      )}
    </div>
  );
}

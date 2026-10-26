import { CliLogo } from "./components/cli-logo.tsx";
import { useReceiverProbe } from "./lib/use-receiver-probe.ts";
import { ReceiverDialog } from "./components/receiver-dialog.tsx";
import {
  readConnectionHistory,
  rememberConnection,
  saveConnectionHistory,
  receiverAddress,
  getInitialDisconnected,
  saveDisconnected,
} from "./lib/connection-history.ts";
import { SessionSwitcher } from "./components/session-switcher.tsx";
import {
  type ViewerSession,
  getInitialSessionDirectory,
  parseSessionDirectoryUrl,
  saveSessionDirectory,
} from "./lib/session-directory.ts";
import { LocalSettings } from "./components/local-settings.tsx";
import {
  isHostedUiOrigin,
  LOCAL_DIRECTORY_EVENT,
  LOCAL_SESSION_EVENT,
} from "../../../packages/cli/src/commands/local/viewer-protocol.ts";
import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
  LOCAL_RETENTION_EVENT,
} from "../../../packages/cli/src/commands/local/retention-limits.ts";
import { Menu, Settings, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocalStorage } from "@uidotdev/usehooks";
import { ConnectionLanding } from "@/components/connection-landing.tsx";
import {
  EventCommandDialog,
  type CommandNavigationItem,
} from "@/components/event-command-dialog.tsx";
import { ReceiverControls } from "@/components/receiver-controls.tsx";
import { TraceWorkspace } from "@/components/trace-workspace.tsx";
import { EventDetail } from "@/components/event-detail.tsx";
import { ResizableWorkspace } from "@/components/resizable-workspace.tsx";
import { WorkspaceSidebar } from "@/components/workspace-sidebar.tsx";
import { CaptureHeader } from "@/components/capture-header.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";
import {
  getConnectionPresentation,
  getWorkspaceEmptyState,
  type ConnectionState,
} from "@/lib/presentation.ts";
import {
  DEFAULT_STREAM_URL,
  decodeEnvelope,
  parseStreamEndpoint,
  isLoopbackHost,
  REMOTE_STREAM_STORAGE_KEY,
  resolveInitialStreamUrl,
  SENTRY_ENVELOPE_EVENT,
  STREAM_STORAGE_KEY,
  type EventMetadata,
  type LocalFeedItem,
} from "@/lib/spotlight.ts";
import { createLocalTelemetryStore } from "@/lib/telemetry-store.ts";
import { buildTraceGroups, traceIdForItem } from "@/lib/trace-model.ts";
import { workspaceNavigation } from "@/lib/workspace-navigation.ts";
import {
  isErrorEvent,
  matchesSearch,
  type WorkspaceView,
  workspaceForItem,
} from "@/lib/workspace.ts";
import { useLocalWorkspaceRoute } from "@/routes/local-workspace-context.ts";

type EventEntryProps = {
  item: LocalFeedItem;
  isSelected: boolean;
  showTypeBadge: boolean;
  onSelect: (id: string) => void;
};

const CONNECTION_TIMEOUT_MS = 10_000;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "sentry.local.sidebar-collapsed";
const SCOPED_SESSION_STREAM_PATH_RE = /^\/_local\/v1\/sessions\/[^/]+\/stream$/;

function isScopedSessionStream(pathname: string): boolean {
  return SCOPED_SESSION_STREAM_PATH_RE.test(pathname);
}

function formatTimestamp(timestamp: LocalFeedItem["timestamp"]): string {
  if (timestamp === undefined) {
    return "unknown time";
  }
  const milliseconds =
    typeof timestamp === "number" && timestamp < 1_000_000_000_000
      ? timestamp * 1_000
      : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? String(timestamp)
    : date.toLocaleTimeString();
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) {
    return undefined;
  }
  return `${durationMs.toFixed(durationMs < 10 ? 2 : 0)}ms`;
}

function getMetadata(item: LocalFeedItem): EventMetadata {
  return item.metadata ?? { title: item.type };
}

function getStatusClass(statusCode: number | undefined): string {
  if (statusCode === undefined) {
    return "text-muted-foreground";
  }
  if (statusCode >= 500) {
    return "text-red-500 dark:text-red-400";
  }
  if (statusCode >= 400) {
    return "text-amber-600 dark:text-amber-400";
  }
  return "text-emerald-600 dark:text-emerald-400";
}

function getSavedStream(): string | null {
  try {
    return window.localStorage.getItem(STREAM_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSavedRemoteStream(): string | null {
  try {
    return window.sessionStorage.getItem(REMOTE_STREAM_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveStreamUrl(streamUrl: string): void {
  try {
    window.localStorage.setItem(STREAM_STORAGE_KEY, streamUrl);
  } catch {
    // Private browsing or browser policy can disable storage; the current tab still works.
  }
  try {
    window.sessionStorage.removeItem(REMOTE_STREAM_STORAGE_KEY);
  } catch {
    // A successful local choice must supersede this tab's older remote preference when possible.
  }
}

function saveRemoteStreamUrl(streamUrl: string): void {
  try {
    window.sessionStorage.setItem(REMOTE_STREAM_STORAGE_KEY, streamUrl);
  } catch {
    // Browser policies can disable storage; the active tab still works.
  }
}

function EventEntry({
  item,
  isSelected,
  showTypeBadge,
  onSelect,
}: EventEntryProps) {
  const metadata = getMetadata(item);
  const duration = formatDuration(metadata.durationMs);
  const isError = isErrorEvent(item);
  const typeLabel =
    item.type === "event"
      ? isError
        ? "Exception"
        : "Event"
      : (metadata.method ??
        (item.type === "transaction"
          ? "Request"
          : item.type === "log"
            ? "Log"
            : (metadata.operation ?? item.type)));

  return (
    <li>
      <button
        type="button"
        aria-label={`View ${item.type} event`}
        aria-current={isSelected ? "true" : undefined}
        className={`flex w-full cursor-pointer items-center justify-between gap-3 px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
          isSelected ? "bg-muted text-foreground" : "hover:bg-muted/60"
        }`}
        onClick={() => onSelect(item.id)}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            {showTypeBadge ? (
              <Badge variant={isError ? "destructive" : "default"}>
                {typeLabel}
              </Badge>
            ) : null}
            <span className="line-clamp-2 min-w-0 break-words text-sm [overflow-wrap:anywhere]">
              {item.type === "event"
                ? metadata.title
                : (metadata.route ?? metadata.title)}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
            {metadata.statusCode !== undefined ? (
              <span className={getStatusClass(metadata.statusCode)}>
                {metadata.statusCode}
              </span>
            ) : null}
            {duration ? <span>{duration}</span> : null}
            {isError && item.type === "transaction" ? (
              <span className="font-sans text-destructive">Failed request</span>
            ) : null}
            {item.type === "log" && metadata.level ? (
              <span className="font-sans">{metadata.level}</span>
            ) : null}
          </div>
        </div>
        <time className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatTimestamp(item.timestamp)}
        </time>
      </button>
    </li>
  );
}

function WorkspaceEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const {
    navigateToCommandEvent,
    navigateToCommandTrace,
    navigateToWorkspace,
    workspaceQuery,
    workspaceView,
  } = useLocalWorkspaceRoute();
  const [commandSearchQuery, setCommandSearchQuery] = useState("");
  const [streamUrl, setStreamUrl] = useState(() =>
    resolveInitialStreamUrl(
      window.location.hash,
      getSavedStream(),
      getSavedRemoteStream(),
      window.location.search,
    ),
  );
  const [isDisconnected, setIsDisconnected] = useState(getInitialDisconnected);
  const [hasEstablishedConnection, setHasEstablishedConnection] =
    useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isDeleteConfirmationOpen, setIsDeleteConfirmationOpen] =
    useState(false);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [currentSession, setCurrentSession] = useState<ViewerSession>();
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number>();
  const [latestEventTime, setLatestEventTime] = useState<number>();
  const [isViewCleared, setIsViewCleared] = useState(false);
  const clearingGeneration = useRef<number | undefined>(undefined);
  const [directoryUrl, setDirectoryUrl] = useState(() =>
    getInitialSessionDirectory(streamUrl),
  );
  const activeDirectoryUrl = parseSessionDirectoryUrl(directoryUrl, streamUrl);
  const connectionGeneration = useRef(0);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>(
    isDisconnected ? "missing" : "connecting",
  );
  const [draftEndpoint, setDraftEndpoint] = useState(() =>
    receiverAddress(streamUrl),
  );
  const receiverEndpointEdited = useRef(false);
  const [recentConnections, setRecentConnections] = useState(
    readConnectionHistory,
  );
  const [receiverError, setReceiverError] = useState<string>();
  const {
    isPending: isAddingReceiver,
    cancel: cancelReceiverAttempt,
    probe: probeReceiver,
  } = useReceiverProbe(CONNECTION_TIMEOUT_MS);
  const receiverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [closedSessionUrl, setClosedSessionUrl] = useState<string>();
  const [isClosingSession, setIsClosingSession] = useState(false);
  const closingGeneration = useRef<number | undefined>(undefined);
  const [isEditingReceiver, setIsEditingReceiver] = useState(false);
  const [isConnectionEnabled, setIsConnectionEnabled] =
    useState(!isDisconnected);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [retentionLimit, setRetentionLimit] = useState(DEFAULT_MAX_ENVELOPES);
  const [hasRetentionSettings, setHasRetentionSettings] = useState(false);
  const [telemetryStore] = useState(() => createLocalTelemetryStore());
  const telemetry = useSyncExternalStore(
    telemetryStore.subscribe,
    telemetryStore.getSnapshot,
    telemetryStore.getSnapshot,
  );
  const items = telemetry.items;
  const [lastViewedItemIds, setLastViewedItemIds] = useState<
    Partial<Record<WorkspaceView, string>>
  >({});
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useLocalStorage(
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    false,
  );
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openSettings = (trigger: HTMLButtonElement) => {
    settingsTriggerRef.current = trigger;
    setIsSettingsOpen(true);
  };
  const [message, setMessage] = useState<string | undefined>();
  const fallbackEventId = useRef(0);
  const commandTriggerRef = useRef<HTMLButtonElement>(null);
  const isClosedSession = closedSessionUrl === streamUrl;
  const presentation = getConnectionPresentation(
    isClosedSession ? "closed" : connection,
  );
  const setReceiverDialogOpen = (open: boolean) => {
    if (!open) cancelReceiverAttempt();
    setReceiverError(undefined);
    setIsEditingReceiver(open);
  };
  const openReceiverDialog = (trigger: HTMLButtonElement) => {
    receiverTriggerRef.current = trigger;
    setDraftEndpoint(receiverAddress(streamUrl));
    receiverEndpointEdited.current = false;
    setReceiverDialogOpen(true);
  };
  useEffect(
    () => saveConnectionHistory(recentConnections),
    [recentConnections],
  );
  const traces = useMemo(() => buildTraceGroups(items), [items]);
  const searchQuery = workspaceQuery.query;
  const activeWorkspace = workspaceNavigation.find(
    (entry) => entry.id === workspaceView,
  )!;
  const workspaceItems = activeWorkspace.getItems(telemetry);
  const hasRetainedItems = items.length > 0 || telemetry.envelopes.length > 0;
  const retainedItemCount = items.length + telemetry.envelopes.length;
  const searchedItems = workspaceItems.filter((item) =>
    matchesSearch(item, searchQuery),
  );
  const searchedTraces = traces.filter((trace) =>
    trace.items.some((item) => matchesSearch(item, searchQuery)),
  );
  const workspaceEmptyState = getWorkspaceEmptyState({
    view: workspaceView,
    label: activeWorkspace.label,
    singularLabel: activeWorkspace.singularLabel,
    filtered: Boolean(searchQuery.trim()),
    state:
      connection === "failed"
        ? "offline"
        : isViewCleared
          ? "cleared"
          : isClosedSession
            ? "saved"
            : "capturing",
  });
  const selectedItem =
    searchedItems.find((item) => item.id === workspaceQuery.eventId) ??
    searchedItems[0];
  const selectedEventTrace = selectedItem?.metadata?.traceId
    ? traces.find((trace) => trace.id === selectedItem.metadata?.traceId)
    : undefined;
  const lastViewedItemId = lastViewedItemIds[workspaceView];
  const lastViewedIndex = lastViewedItemId
    ? workspaceItems.findIndex((item) => item.id === lastViewedItemId)
    : -1;
  const unseenItems =
    lastViewedItemId === undefined
      ? []
      : lastViewedIndex === -1
        ? workspaceItems
        : workspaceItems.slice(lastViewedIndex + 1);
  const newItems = unseenItems.filter((item) =>
    matchesSearch(item, searchQuery),
  );
  const newItemCount = newItems.length;

  const markItemsSeen = (view = workspaceView) => {
    const viewedItems = workspaceNavigation
      .find((entry) => entry.id === view)!
      .getItems(telemetry);
    setLastViewedItemIds((itemIds) => ({
      ...itemIds,
      [view]: viewedItems.at(-1)?.id,
    }));
  };

  const selectItem = (id: string) => {
    void workspaceQuery.selectEvent(id);
    markItemsSeen();
  };

  const selectWorkspace = (nextWorkspace: WorkspaceView) => {
    navigateToWorkspace(nextWorkspace);
    void workspaceQuery.resetWorkspace();
    setIsMobileNavigationOpen(false);
    markItemsSeen(nextWorkspace);
  };

  const selectCommandItem = (item: LocalFeedItem) => {
    setCommandSearchQuery("");
    const nextWorkspace = workspaceForItem(item);
    const traceId = traceIdForItem(item);
    if (nextWorkspace === "traces" && traceId) {
      navigateToCommandTrace(nextWorkspace, traceId);
    } else {
      navigateToCommandEvent(nextWorkspace, item.id);
    }
    markItemsSeen(nextWorkspace);
  };

  const clearDisplayedItems = (markViewCleared = false) => {
    setCommandSearchQuery("");
    telemetryStore.clear();
    setIsViewCleared(markViewCleared);
    setMessage(undefined);
    setLastViewedItemIds({});
    void workspaceQuery.clearWorkspace();
  };
  const clearDisplayedItemsRef = useRef(clearDisplayedItems);
  useEffect(() => {
    clearDisplayedItemsRef.current = clearDisplayedItems;
  });
  const disconnectReceiver = () => {
    connectionGeneration.current += 1;
    cancelReceiverAttempt();
    setIsConnectionEnabled(false);
    setIsConnecting(false);
    setHasEstablishedConnection(false);
    setIsDisconnected(true);
    saveDisconnected(true);
    setConnection("missing");
    setClosedSessionUrl(undefined);
    setConnectionError(undefined);
    setReceiverError(undefined);
    setIsEditingReceiver(false);
    setIsSettingsOpen(false);
    setIsDeleteConfirmationOpen(false);
    setCurrentSession(undefined);
    setSessionExpiresAt(undefined);
    setLatestEventTime(undefined);
    setIsClearing(false);
    clearingGeneration.current = undefined;
    closingGeneration.current = undefined;
    setIsClosingSession(false);
    setDraftEndpoint(receiverAddress(streamUrl));
    receiverEndpointEdited.current = false;
    clearDisplayedItems();
  };
  const clearItems = () => clearDisplayedItems(true);
  const deleteCapturedEvents = () => {
    if (isClearing || isClosedSession) return;
    const endpoint = parseStreamEndpoint(streamUrl);
    if (
      endpoint?.kind !== "loopback" ||
      !isLoopbackHost(window.location.hostname)
    )
      return;
    setIsDeleteConfirmationOpen(false);
    clearDisplayedItems();
    // Pause this generation before resetting. Replaying afterward captures all
    // post-reset arrivals without allowing queued pre-reset events back in.
    const generation = ++connectionGeneration.current;
    clearingGeneration.current = generation;
    setIsClearing(true);
    setIsConnectionEnabled(false);
    setIsConnecting(false);
    const clearUrl = new URL(endpoint.url);
    const scopedSession = isScopedSessionStream(clearUrl.pathname);
    if (scopedSession) {
      clearUrl.pathname = clearUrl.pathname.replace(/\/stream$/, "/ui/reset");
    } else {
      clearUrl.pathname = "/clear";
      clearUrl.search = "";
    }
    void fetch(clearUrl, {
      method: scopedSession ? "POST" : "DELETE",
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error(`Session reset failed with HTTP ${response.status}`);
        if (connectionGeneration.current === generation)
          connectToEndpoint(streamUrl);
      })
      .catch(() => {
        if (connectionGeneration.current !== generation) return;
        setConnection("failed");
        setConnectionError(
          "Could not delete captured events. Reconnect to try again.",
        );
        setMessage(
          "This view is empty, but the receiver could not delete its captured events.",
        );
      })
      .finally(() => {
        if (clearingGeneration.current === generation) {
          clearingGeneration.current = undefined;
          setIsClearing(false);
        }
      });
  };

  const closeScopedSession = () => {
    const endpoint = parseStreamEndpoint(streamUrl);
    if (
      endpoint?.kind !== "loopback" ||
      !isLoopbackHost(window.location.hostname)
    ) {
      return;
    }
    const closeUrl = new URL(endpoint.url);
    if (!isScopedSessionStream(closeUrl.pathname)) {
      return;
    }
    closeUrl.pathname = closeUrl.pathname.replace(/\/stream$/, "/ui/close");
    const generation = connectionGeneration.current;
    if (closingGeneration.current === generation) return;
    closingGeneration.current = generation;
    setIsClosingSession(true);
    void fetch(closeUrl, { method: "POST", signal: AbortSignal.timeout(5000) })
      .then((response) => {
        if (connectionGeneration.current !== generation) return;
        if (!response.ok) {
          throw new Error(`Session close failed with HTTP ${response.status}`);
        }
        // The HTTP response can overtake the final SSE envelopes. Replay the
        // closed archive so every accepted event is visible before stopping.
        // Existing envelope IDs keep already displayed telemetry deduplicated.
        connectToEndpoint(streamUrl);
        setClosedSessionUrl(streamUrl);
      })
      .catch(() => {
        if (connectionGeneration.current !== generation) return;
        setMessage("Could not stop this capture. Try again.");
      })
      .finally(() => {
        if (closingGeneration.current === generation) {
          closingGeneration.current = undefined;
          setIsClosingSession(false);
        }
      });
  };

  const currentEndpoint = parseStreamEndpoint(streamUrl);
  const canEditRetention =
    currentEndpoint?.kind === "loopback" &&
    (isLoopbackHost(window.location.hostname) ||
      isHostedUiOrigin(window.location.origin));
  const hasScopedSession =
    currentEndpoint?.kind === "loopback" &&
    isLoopbackHost(window.location.hostname) &&
    isScopedSessionStream(new URL(currentEndpoint.url).pathname);

  const connectToEndpoint = (nextStreamUrl: string) => {
    const endpoint = parseStreamEndpoint(nextStreamUrl);
    if (!endpoint) {
      setReceiverError(
        "Enter a loopback stream or an HTTPS remote stream ending in /stream.",
      );
      if (connection !== "connected") {
        setIsConnectionEnabled(false);
        setConnection("failed");
      }
      return;
    }
    cancelReceiverAttempt();
    setIsViewCleared(false);
    setIsDisconnected(false);
    saveDisconnected(false);
    setIsClearing(false);
    clearingGeneration.current = undefined;
    connectionGeneration.current += 1;
    closingGeneration.current = undefined;
    setIsClosingSession(false);
    setIsSettingsOpen(false);
    setIsDeleteConfirmationOpen(false);
    setReceiverError(undefined);
    setMessage(undefined);
    if (
      endpoint.kind === "loopback" &&
      new URL(endpoint.url).pathname === "/stream"
    ) {
      // A reconnect can target a new daemon on the same port. Wait for its
      // metadata rather than auto-selecting an entry from the old directory.
      setDirectoryUrl(undefined);
    }
    if (endpoint.url !== streamUrl) {
      setClosedSessionUrl(undefined);
      setCurrentSession(undefined);
      setSessionExpiresAt(undefined);
      setLatestEventTime(undefined);
      setIsViewCleared(false);
      telemetryStore.clear();
      telemetryStore.setLimit(DEFAULT_MAX_ENVELOPES);
      setRetentionLimit(DEFAULT_MAX_ENVELOPES);
      setHasRetentionSettings(false);
      setLastViewedItemIds({});
      fallbackEventId.current = 0;
      setCommandSearchQuery("");
      void workspaceQuery.clearWorkspace();
    }
    setDraftEndpoint(receiverAddress(endpoint.url));
    receiverEndpointEdited.current = false;
    setStreamUrl(endpoint.url);
    setConnectionAttempt((attempt) => attempt + 1);
    setIsConnectionEnabled(true);
    setIsConnecting(true);
    setConnection("connecting");
    setConnectionError(undefined);
    setIsEditingReceiver(false);
  };

  const connectReceiver = (url: string) => {
    const endpoint = parseStreamEndpoint(url);
    if (!endpoint || (connection !== "connected" && !hasRetainedItems)) {
      connectToEndpoint(url);
      return;
    }
    if (
      connection === "connected" &&
      (endpoint.url === streamUrl ||
        (activeDirectoryUrl && endpoint.url === receiverAddress(streamUrl)))
    ) {
      setReceiverDialogOpen(false);
      return;
    }
    setReceiverError(undefined);
    probeReceiver(
      endpoint.url,
      () => connectToEndpoint(endpoint.url),
      setReceiverError,
    );
  };
  const connectionForm = {
    endpoint: draftEndpoint,
    error: receiverError ?? (isEditingReceiver ? undefined : connectionError),
    isConnecting: isConnecting || isAddingReceiver,
    onEndpointChange: (value: string) => {
      setDraftEndpoint(value);
      receiverEndpointEdited.current = true;
      setReceiverError(undefined);
      if (!isEditingReceiver) setConnectionError(undefined);
      cancelReceiverAttempt();
      if (
        !isEditingReceiver &&
        connection === "connecting" &&
        !hasRetainedItems
      ) {
        // Editing the landing owns the next attempt; a late automatic probe must not dismiss it.
        connectionGeneration.current += 1;
        setIsConnectionEnabled(false);
        setIsConnecting(false);
        setConnection("missing");
      }
    },
    onConnect: () =>
      connectReceiver(
        // The form hides local session capabilities. Retrying its unchanged
        // address must keep the selected run rather than rediscovering one.
        // An explicitly edited address can re-pair after a daemon restart.
        !receiverEndpointEdited.current &&
          draftEndpoint === receiverAddress(streamUrl)
          ? streamUrl
          : draftEndpoint,
      ),
    recentConnections,
    onReconnect: connectReceiver,
    onForget: (url: string) =>
      setRecentConnections((history) =>
        history.filter((entry) => entry !== url),
      ),
  };

  useEffect(() => {
    if (!isConnectionEnabled) {
      return;
    }

    let isCurrent = true;
    const generation = connectionGeneration.current;
    function isActiveConnection(): boolean {
      return isCurrent && connectionGeneration.current === generation;
    }
    const requestUrl = new URL(streamUrl);
    if (parseStreamEndpoint(streamUrl)?.kind === "loopback")
      requestUrl.searchParams.set("retention", "1");
    const source = new EventSource(requestUrl.toString());
    const onRetention = (event: Event) => {
      if (!isActiveConnection()) return;
      try {
        const settings: unknown = JSON.parse(
          (event as MessageEvent<string>).data,
        );
        if (
          typeof settings === "object" &&
          settings !== null &&
          "maxEnvelopes" in settings &&
          isValidMaxEnvelopes(settings.maxEnvelopes)
        ) {
          telemetryStore.setLimit(settings.maxEnvelopes);
          setRetentionLimit(settings.maxEnvelopes);
          setHasRetentionSettings(true);
        }
      } catch {
        /* Ignore malformed optional metadata from external receivers. */
      }
    };
    const onDirectory = (event: Event) => {
      if (!isActiveConnection()) return;
      const endpoint = parseStreamEndpoint(streamUrl);
      if (
        endpoint?.kind !== "loopback" ||
        new URL(endpoint.url).pathname !== "/stream"
      )
        return;
      try {
        const value: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (
          value &&
          typeof value === "object" &&
          "directoryUrl" in value &&
          typeof value.directoryUrl === "string"
        ) {
          const directory = parseSessionDirectoryUrl(
            value.directoryUrl,
            streamUrl,
          );
          if (directory) {
            saveSessionDirectory(directory);
            setDirectoryUrl(directory);
          }
        }
      } catch {
        /* Optional metadata from legacy/external receivers may be malformed. */
      }
    };
    source.addEventListener(LOCAL_DIRECTORY_EVENT, onDirectory);
    source.addEventListener(LOCAL_RETENTION_EVENT, onRetention);
    const timeoutId = window.setTimeout(() => {
      if (!isActiveConnection()) {
        return;
      }
      isCurrent = false;
      source.close();
      setIsConnectionEnabled(false);
      setIsConnecting(false);
      setConnection("failed");
      setConnectionError(
        "Connection timed out after 10 seconds. Check the endpoint and try again.",
      );
    }, CONNECTION_TIMEOUT_MS);
    const onSession = (event: Event) => {
      if (!isActiveConnection()) return;
      let metadata: unknown;
      try {
        metadata = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        return;
      }
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("state" in metadata) ||
        (metadata.state !== "open" && metadata.state !== "retained")
      )
        return;
      if ("action" in metadata && metadata.action === "reset") {
        clearDisplayedItemsRef.current();
        return;
      }
      if (
        "expiresAt" in metadata &&
        typeof metadata.expiresAt === "number" &&
        Number.isSafeInteger(metadata.expiresAt) &&
        metadata.expiresAt > 0
      ) {
        setSessionExpiresAt(metadata.expiresAt);
      }
      if (metadata.state === "retained") {
        // This notification follows the complete archive replay. EOF is normal,
        // and must not be mistaken for a failed receiver or trigger live retry.
        isCurrent = false;
        source.close();
        window.clearTimeout(timeoutId);
        connectionGeneration.current += 1;
        setIsConnectionEnabled(false);
        setIsConnecting(false);
        setHasEstablishedConnection(true);
        setConnection("closed");
        setClosedSessionUrl(streamUrl);
        setConnectionError(undefined);
        setMessage(undefined);
      }
    };
    source.addEventListener(LOCAL_SESSION_EVENT, onSession);
    const onEnvelope = (event: Event) => {
      if (!isActiveConnection()) {
        return;
      }
      setIsViewCleared(false);
      setLatestEventTime(Date.now());
      const messageEvent = event as MessageEvent<string>;
      const eventId =
        messageEvent.lastEventId || `event-${fallbackEventId.current++}`;
      const rawEnvelope: LocalFeedItem = {
        id: eventId,
        type: "envelope",
        timestamp: Date.now(),
        text: messageEvent.data,
        payload: messageEvent.data,
        metadata: { title: `Envelope ${eventId.slice(-8)}` },
      };
      try {
        telemetryStore.recordEnvelope(
          rawEnvelope,
          decodeEnvelope(messageEvent.data, eventId),
        );
        setMessage(undefined);
      } catch {
        telemetryStore.recordEnvelope(rawEnvelope, []);
        setMessage("Received an event that could not be decoded.");
      }
    };

    source.addEventListener(SENTRY_ENVELOPE_EVENT, onEnvelope);
    source.onopen = () => {
      if (!isActiveConnection()) {
        return;
      }
      window.clearTimeout(timeoutId);
      setIsConnecting(false);
      setHasEstablishedConnection(true);
      // A successfully opened explicit CLI link also replaces the tab's prior
      // Disconnect choice after its URL fragment has been removed.
      saveDisconnected(false);
      const endpoint = parseStreamEndpoint(streamUrl);
      if (endpoint?.kind === "loopback") {
        saveStreamUrl(endpoint.url);
      } else if (endpoint?.kind === "remote") {
        saveRemoteStreamUrl(endpoint.url);
      }
      setRecentConnections((history) => rememberConnection(history, streamUrl));
      setConnection("connected");
      setConnectionError(undefined);
      setMessage(undefined);
    };
    source.onerror = () => {
      if (!isActiveConnection()) {
        return;
      }
      window.clearTimeout(timeoutId);
      isCurrent = false;
      source.close();
      setIsConnectionEnabled(false);
      setIsConnecting(false);
      setConnection("failed");
      setConnectionError(
        streamUrl === DEFAULT_STREAM_URL
          ? "Could not connect to the default receiver. Start it with the command below or enter another endpoint."
          : "Could not connect to this receiver. Check the endpoint and try again.",
      );
    };

    return () => {
      isCurrent = false;
      window.clearTimeout(timeoutId);
      source.removeEventListener(SENTRY_ENVELOPE_EVENT, onEnvelope);
      source.removeEventListener(LOCAL_SESSION_EVENT, onSession);
      source.removeEventListener(LOCAL_RETENTION_EVENT, onRetention);
      source.removeEventListener(LOCAL_DIRECTORY_EVENT, onDirectory);
      source.close();
    };
  }, [connectionAttempt, isConnectionEnabled, streamUrl, telemetryStore]);

  const showConnectionLanding =
    isDisconnected || (!hasEstablishedConnection && !hasRetainedItems);
  const isReceiverUnavailable = showConnectionLanding && !isConnecting;
  const canSearch =
    hasRetainedItems &&
    !isEditingReceiver &&
    !isSettingsOpen &&
    !isDeleteConfirmationOpen;
  const commandNavigation: CommandNavigationItem[] = workspaceNavigation.map(
    ({ icon, id, label }) => ({ icon, id, label }),
  );
  const setCommandOpen = (open: boolean) => {
    if (open) {
      setCommandSearchQuery("");
    }
    setIsCommandOpen(open);
  };
  const openCommand = (trigger: HTMLButtonElement) => {
    commandTriggerRef.current = trigger;
    setCommandOpen(true);
  };

  const selectSpan = (traceId: string, spanId: string) => {
    if (workspaceView === "traces") {
      void workspaceQuery.selectSpan(traceId, spanId);
    } else {
      navigateToCommandTrace("traces", traceId, spanId);
    }
    markItemsSeen("traces");
  };
  const requestDeleteCapturedEvents = (trigger: HTMLButtonElement) => {
    deleteTriggerRef.current = trigger;
    setIsDeleteConfirmationOpen(true);
  };
  const canDeleteCapturedEvents =
    currentEndpoint?.kind === "loopback" &&
    isLoopbackHost(window.location.hostname) &&
    !isClosedSession;
  const captureLabel =
    currentSession?.streamUrl === streamUrl ? currentSession.label : undefined;
  const updateCurrentSession = useCallback(
    (session: ViewerSession | undefined) => {
      setCurrentSession(
        (previous) =>
          session ?? (previous?.streamUrl === streamUrl ? previous : undefined),
      );
    },
    [streamUrl],
  );

  return (
    <main className="h-dvh overflow-hidden bg-background">
      <Dialog
        open={isDeleteConfirmationOpen}
        onOpenChange={setIsDeleteConfirmationOpen}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            deleteTriggerRef.current?.focus();
          }}
        >
          <DialogTitle>Delete captured events?</DialogTitle>
          <DialogDescription>
            Delete the events stored by the receiver for{" "}
            {captureLabel ? `“${captureLabel}”` : "this capture"}. Other viewers
            lose this history too. Capture will continue receiving new events.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() => setIsDeleteConfirmationOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10"
              onClick={deleteCapturedEvents}
            >
              Delete captured events
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ReceiverDialog
        open={isEditingReceiver}
        onOpenChange={setReceiverDialogOpen}
        triggerRef={receiverTriggerRef}
        {...connectionForm}
      />
      <LocalSettings
        key={streamUrl}
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        triggerRef={settingsTriggerRef}
        streamUrl={streamUrl}
        captureLabel={captureLabel}
        expiresAt={sessionExpiresAt ?? currentSession?.expiresAt}
        supported={hasRetentionSettings}
        limit={retentionLimit}
        count={telemetry.envelopes.length}
        editable={
          canEditRetention && !isClosedSession && connection === "connected"
        }
        unavailableReason={
          isClosedSession
            ? "History capacity is read-only for saved captures."
            : canEditRetention && connection !== "connected"
              ? "Reconnect to this receiver to change history capacity."
              : undefined
        }
      />
      <div
        data-testid="app-shell"
        className="mx-auto flex h-full w-full max-w-none"
      >
        {!isReceiverUnavailable ? (
          <WorkspaceSidebar
            activeView={workspaceView}
            canSearch={canSearch}
            collapsed={isSidebarCollapsed}
            connection={presentation}
            retainedItemCount={retainedItemCount}
            snapshot={telemetry}
            traceCount={traces.length}
            onDeleteCapturedEvents={
              canDeleteCapturedEvents ? requestDeleteCapturedEvents : undefined
            }
            onClear={clearItems}
            onDisconnect={disconnectReceiver}
            isClearing={isClearing}
            onCloseSession={
              hasScopedSession && !isClosedSession
                ? closeScopedSession
                : undefined
            }
            isClosingSession={isClosingSession}
            onChangeReceiver={openReceiverDialog}
            onOpenSettings={openSettings}
            onOpenCommand={openCommand}
            onSelect={selectWorkspace}
            onToggle={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
          />
        ) : null}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {isReceiverUnavailable ? (
            <header className="flex h-11 shrink-0 items-center px-3 sm:px-4">
              <div
                className="flex min-w-0 flex-1 items-center"
                aria-label="Sentry CLI"
              >
                <CliLogo />
              </div>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Settings"
                      className="text-muted-foreground"
                      onClick={(event) => openSettings(event.currentTarget)}
                    >
                      <Settings className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Settings</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </header>
          ) : (
            <div className="flex h-11 shrink-0 items-center gap-2 px-3 md:hidden">
              <button
                type="button"
                aria-label="Open navigation"
                aria-expanded={isMobileNavigationOpen}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setIsMobileNavigationOpen((open) => !open)}
              >
                <Menu className="size-4" />
              </button>
              {canSearch ? (
                <button
                  type="button"
                  aria-label="Search this session"
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 border border-border bg-muted/30 px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                  onClick={(event) => openCommand(event.currentTarget)}
                >
                  <Search className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    Search this session
                  </span>
                </button>
              ) : (
                <span className="flex-1" />
              )}
              <ReceiverControls
                connection={presentation}
                retainedItemCount={retainedItemCount}
                onDeleteCapturedEvents={
                  canDeleteCapturedEvents
                    ? requestDeleteCapturedEvents
                    : undefined
                }
                onClear={clearItems}
                onDisconnect={disconnectReceiver}
                isClearing={isClearing}
                onCloseSession={
                  hasScopedSession && !isClosedSession
                    ? closeScopedSession
                    : undefined
                }
                isClosingSession={isClosingSession}
                onAddReceiver={openReceiverDialog}
                onOpenSettings={openSettings}
                showStatusRole={false}
              />
            </div>
          )}

          {!isReceiverUnavailable && isMobileNavigationOpen ? (
            <div className="absolute top-11 z-20 w-full border-b border-border bg-background p-2 shadow-lg md:hidden">
              <nav
                aria-label="Workspace navigation"
                className="grid grid-cols-2 gap-1"
              >
                {workspaceNavigation
                  .filter((entry) => entry.section === "Explore")
                  .map((entry) => {
                    const Icon = entry.icon;
                    const active = workspaceView === entry.id;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        aria-label={`Open ${entry.label.toLowerCase()} view`}
                        aria-current={active ? "page" : undefined}
                        className={`flex h-9 items-center gap-2 rounded-md px-2 text-left text-sm ${
                          active
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                        onClick={() => selectWorkspace(entry.id)}
                      >
                        <Icon className="size-4" />
                        {entry.label}
                      </button>
                    );
                  })}
                <details
                  className="col-span-2"
                  open={
                    activeWorkspace.section === "Diagnostics" ? true : undefined
                  }
                >
                  <summary className="cursor-pointer rounded-md px-2 py-2 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Diagnostics
                  </summary>
                  <div className="grid grid-cols-2 gap-1">
                    {" "}
                    {workspaceNavigation
                      .filter((entry) => entry.section === "Diagnostics")
                      .map((entry) => {
                        const Icon = entry.icon;
                        const active = workspaceView === entry.id;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            aria-label={`Open ${entry.label.toLowerCase()} view`}
                            aria-current={active ? "page" : undefined}
                            className={`flex h-9 items-center gap-2 rounded-md px-2 text-left text-sm ${
                              active
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            }`}
                            onClick={() => selectWorkspace(entry.id)}
                          >
                            <Icon className="size-4" />
                            {entry.label}
                          </button>
                        );
                      })}
                  </div>
                </details>
              </nav>
            </div>
          ) : null}

          <div className="flex min-h-0 min-w-0 flex-1">
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              aria-label="Local Sentry events"
            >
              {!showConnectionLanding ? (
                <CaptureHeader
                  streamUrl={streamUrl}
                  connection={connection}
                  isClosed={isClosedSession}
                  session={
                    currentSession?.streamUrl === streamUrl
                      ? currentSession
                      : undefined
                  }
                  expiresAt={sessionExpiresAt ?? currentSession?.expiresAt}
                  latestEventTime={latestEventTime}
                  onReload={() => {
                    if (!isClearing) connectToEndpoint(streamUrl);
                  }}
                  isReloading={isConnecting || isClearing}
                  isAwaitingSession={Boolean(
                    activeDirectoryUrl &&
                    currentEndpoint?.kind === "loopback" &&
                    new URL(currentEndpoint.url).pathname === "/stream",
                  )}
                  sessionPicker={
                    activeDirectoryUrl && !isDisconnected ? (
                      <SessionSwitcher
                        key={activeDirectoryUrl}
                        refreshKey={closedSessionUrl}
                        onRetainedSession={setClosedSessionUrl}
                        onCurrentSessionChange={updateCurrentSession}
                        showState={false}
                        directoryUrl={activeDirectoryUrl}
                        streamUrl={streamUrl}
                        selectInitialSession={
                          !isEditingReceiver &&
                          currentEndpoint?.kind === "loopback" &&
                          new URL(currentEndpoint.url).pathname === "/stream"
                        }
                        onSelect={connectToEndpoint}
                      />
                    ) : undefined
                  }
                />
              ) : activeDirectoryUrl && !isDisconnected ? (
                <div className="border-b p-3">
                  <SessionSwitcher
                    key={activeDirectoryUrl}
                    refreshKey={closedSessionUrl}
                    onRetainedSession={setClosedSessionUrl}
                    onCurrentSessionChange={updateCurrentSession}
                    showState={false}
                    directoryUrl={activeDirectoryUrl}
                    streamUrl={streamUrl}
                    selectInitialSession={
                      !isEditingReceiver &&
                      currentEndpoint?.kind === "loopback" &&
                      new URL(currentEndpoint.url).pathname === "/stream"
                    }
                    onSelect={connectToEndpoint}
                  />
                </div>
              ) : null}
              {!showConnectionLanding &&
              connection === "failed" &&
              connectionError ? (
                <p
                  role="alert"
                  className="shrink-0 border-b px-4 py-2 text-xs text-destructive"
                >
                  {connectionError}
                </p>
              ) : null}
              {!showConnectionLanding ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
                    <Search className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="shrink-0">
                      Filter {activeWorkspace.label}
                    </span>
                    <input
                      type="search"
                      aria-label={`Filter ${activeWorkspace.label}`}
                      value={searchQuery}
                      onChange={(event) => {
                        void workspaceQuery.setSearchQuery(event.target.value);
                      }}
                      placeholder={`Within ${activeWorkspace.label.toLowerCase()}`}
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  {searchQuery.trim() ? (
                    <Button
                      variant="ghost"
                      className="h-8 shrink-0 text-xs"
                      onClick={() => {
                        void workspaceQuery.setSearchQuery("");
                      }}
                    >
                      Clear filter
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {message ? (
                <div
                  role="alert"
                  className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
                >
                  {message}
                </div>
              ) : null}

              {showConnectionLanding ? (
                <ConnectionLanding
                  {...connectionForm}
                  phase={
                    connection === "connecting"
                      ? "probing"
                      : connection === "failed"
                        ? "failed"
                        : "editing"
                  }
                />
              ) : !hasRetainedItems ? (
                <WorkspaceEmptyState {...workspaceEmptyState} />
              ) : workspaceView === "traces" ? (
                <TraceWorkspace
                  emptyState={workspaceEmptyState}
                  traces={searchedTraces}
                  selectedTraceId={workspaceQuery.traceId ?? undefined}
                  selectedSpanId={workspaceQuery.spanId ?? undefined}
                  onSelectSpan={selectSpan}
                  onClearSpan={() => {
                    void workspaceQuery.clearSpan();
                  }}
                  onSelectRelatedItem={selectCommandItem}
                  onSelect={(traceId) => {
                    void workspaceQuery.selectTrace(traceId);
                  }}
                />
              ) : (
                <ResizableWorkspace
                  storageKey="sentry.local.events-width"
                  listLabel="Events list"
                  list={
                    <>
                      <div className="shrink-0 border-b border-border px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <h1
                            id="event-list-heading"
                            className="text-sm font-semibold"
                          >
                            {activeWorkspace.label}
                          </h1>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {searchedItems.length}{" "}
                            {activeWorkspace.singularLabel}
                            {searchedItems.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        {newItemCount > 0 ? (
                          <button
                            type="button"
                            className="mt-2 w-full border-t border-border pt-2 text-left text-xs font-medium text-primary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            onClick={() => {
                              const latestItem = newItems.at(-1);
                              if (latestItem) {
                                selectItem(latestItem.id);
                              }
                            }}
                          >
                            View {newItemCount} new{" "}
                            {activeWorkspace.singularLabel}
                            {newItemCount === 1 ? "" : "s"}
                          </button>
                        ) : null}
                      </div>
                      <ol
                        data-testid="event-list"
                        className="min-h-0 flex-1 space-y-px overflow-y-auto"
                      >
                        {searchedItems.map((item) => (
                          <EventEntry
                            key={item.id}
                            item={item}
                            isSelected={item.id === selectedItem?.id}
                            showTypeBadge={workspaceView !== "envelopes"}
                            onSelect={selectItem}
                          />
                        ))}
                        {searchedItems.length === 0 ? (
                          <li className="px-3 py-4 text-sm text-muted-foreground">
                            {workspaceEmptyState.title}
                          </li>
                        ) : null}
                      </ol>
                    </>
                  }
                >
                  {searchedItems.length === 0 ? (
                    <WorkspaceEmptyState {...workspaceEmptyState} />
                  ) : selectedItem ? (
                    <EventDetail
                      key={selectedItem.id}
                      item={selectedItem}
                      trace={selectedEventTrace}
                      onSelectSpan={selectSpan}
                      onSelectRelatedItem={selectCommandItem}
                    />
                  ) : null}
                </ResizableWorkspace>
              )}
            </section>
          </div>
        </div>
      </div>
      <EventCommandDialog
        enabled={canSearch}
        items={items}
        navigation={commandNavigation}
        open={isCommandOpen}
        query={commandSearchQuery}
        triggerRef={commandTriggerRef}
        onNavigate={selectWorkspace}
        onOpenChange={setCommandOpen}
        onQueryChange={setCommandSearchQuery}
        onSelectItem={selectCommandItem}
        currentViewLabel={activeWorkspace.label}
        onFilterView={(query) => {
          void workspaceQuery.setSearchQuery(query);
        }}
      />
    </main>
  );
}

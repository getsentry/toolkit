import { SessionSwitcher } from "./components/session-switcher.tsx";
import {
  getInitialSessionDirectory,
  parseSessionDirectoryUrl,
} from "./lib/session-directory.ts";
import { RetentionSettings } from "./components/retention-settings.tsx";
import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
  LOCAL_RETENTION_EVENT,
} from "../../../packages/cli/src/commands/local/retention-limits.ts";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Menu,
  Radio,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useCopyToClipboard,
  useDebounce,
  useLocalStorage,
} from "@uidotdev/usehooks";
import { JsonView } from "@/components/json-view.tsx";
import { ConnectionLanding } from "@/components/connection-landing.tsx";
import {
  EventCommandDialog,
  type CommandNavigationItem,
} from "@/components/event-command-dialog.tsx";
import { ReceiverControls } from "@/components/receiver-controls.tsx";
import { TraceWorkspace } from "@/components/trace-workspace.tsx";
import { TraceWaterfall } from "@/components/trace-waterfall.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  getConnectionPresentation,
  type ConnectionPresentation,
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
import {
  createLocalTelemetryStore,
  type LocalTelemetrySnapshot,
} from "@/lib/telemetry-store.ts";
import {
  buildTraceGroups,
  traceIdForItem,
  type TraceGroup,
} from "@/lib/trace-model.ts";
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
const SEARCH_DEBOUNCE_MS = 150;
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
                {isError
                  ? "Error"
                  : (metadata.method ?? metadata.operation ?? item.type)}
              </Badge>
            ) : null}
            <span className="truncate font-mono text-sm">
              {metadata.route ?? metadata.title}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {metadata.statusCode !== undefined ? (
              <span className={getStatusClass(metadata.statusCode)}>
                {metadata.statusCode}
              </span>
            ) : null}
            {duration ? <span>{duration}</span> : null}
            {metadata.traceId ? (
              <span className="truncate">{metadata.traceId.slice(0, 8)}</span>
            ) : null}
          </div>
        </div>
        <time className="shrink-0 text-sm text-muted-foreground">
          {formatTimestamp(item.timestamp)}
        </time>
      </button>
    </li>
  );
}

type EventDetailProps = {
  item: LocalFeedItem;
  trace?: TraceGroup;
};

type DetailTab = "overview" | "json";

type DetailField = {
  label: string;
  value: string;
};

type DetailGroup = {
  label: string;
  fields: DetailField[];
};

function RawEnvelopeDetail({ item }: { item: LocalFeedItem }) {
  return (
    <section
      data-testid="event-detail"
      aria-label="Raw envelope detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-medium">Raw envelope</h2>
          <p className="text-xs text-muted-foreground">
            Received {formatTimestamp(item.timestamp)}
          </p>
        </div>
        <Badge>Envelope</Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <JsonView code={item.text} />
      </div>
    </section>
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

function EventDetail({ item, trace }: EventDetailProps) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [copiedField, setCopiedField] = useState<string>();
  const [, copyToClipboard] = useCopyToClipboard();
  const detailTabs: DetailTab[] = ["overview", "json"];
  const metadata = getMetadata(item);
  const duration = formatDuration(metadata.durationMs);
  const detailGroups: DetailGroup[] = [
    {
      label: "Details",
      fields: [
        ...(metadata.statusCode !== undefined
          ? [{ label: "Status", value: String(metadata.statusCode) }]
          : []),
        ...(duration ? [{ label: "Duration", value: duration }] : []),
      ],
    },
    {
      label: "Telemetry",
      fields: [
        ...(metadata.origin
          ? [{ label: "Origin", value: metadata.origin }]
          : []),
      ],
    },
  ];
  const hasDetailFields = detailGroups.some((group) => group.fields.length > 0);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = detailTabs.indexOf(tab);
    const nextIndex =
      event.key === "ArrowRight"
        ? (currentIndex + 1) % detailTabs.length
        : event.key === "ArrowLeft"
          ? (currentIndex - 1 + detailTabs.length) % detailTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? detailTabs.length - 1
              : undefined;

    if (nextIndex === undefined) {
      return;
    }

    event.preventDefault();
    const nextTab = detailTabs[nextIndex]!;
    setTab(nextTab);
    requestAnimationFrame(() => {
      document.getElementById(`event-detail-tab-${nextTab}`)?.focus();
    });
  };

  return (
    <section
      data-testid="event-detail"
      aria-label="Event detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge>{metadata.operation ?? item.type}</Badge>
          <span className="truncate font-mono text-sm">{metadata.title}</span>
        </div>
        <div className="flex h-full shrink-0 items-center gap-3">
          <div
            role="tablist"
            aria-label="Event detail view"
            className="flex h-full"
          >
            <button
              id="event-detail-tab-overview"
              type="button"
              role="tab"
              aria-selected={tab === "overview"}
              aria-controls="event-detail-panel"
              tabIndex={tab === "overview" ? 0 : -1}
              className={`px-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${tab === "overview" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTab("overview")}
              onKeyDown={handleTabKeyDown}
            >
              Overview
            </button>
            <button
              id="event-detail-tab-json"
              type="button"
              role="tab"
              aria-selected={tab === "json"}
              aria-controls="event-detail-panel"
              tabIndex={tab === "json" ? 0 : -1}
              className={`px-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${tab === "json" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTab("json")}
              onKeyDown={handleTabKeyDown}
            >
              JSON
            </button>
          </div>
          <time className="text-sm text-muted-foreground">
            {formatTimestamp(item.timestamp)}
          </time>
        </div>
      </div>
      {tab === "overview" ? (
        <div
          id="event-detail-panel"
          role="tabpanel"
          className="min-h-0 flex-1 overflow-auto p-3 sm:p-4"
        >
          <div className="w-full">
            {hasDetailFields ? (
              <table
                aria-label="Event details"
                className="w-full border border-border text-left text-sm"
              >
                <caption className="sr-only">Captured event details</caption>
                <tbody>
                  {detailGroups.map((group) =>
                    group.fields.length > 0 ? (
                      <Fragment key={group.label}>
                        <tr className="border-b border-border bg-muted/40">
                          <th
                            colSpan={2}
                            scope="rowgroup"
                            className="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                          >
                            {group.label}
                          </th>
                        </tr>
                        {group.fields.map((field) => {
                          const copied = copiedField === field.label;
                          return (
                            <tr
                              key={field.label}
                              className="border-b border-border last:border-b-0"
                            >
                              <th
                                scope="row"
                                className="w-36 border-r border-border bg-muted/65 px-3 py-2 align-top font-medium text-muted-foreground sm:w-44"
                              >
                                {field.label}
                              </th>
                              <td className="group px-3 py-2">
                                <div className="flex min-w-0 items-start gap-2">
                                  <code className="min-w-0 flex-1 break-all font-mono text-foreground">
                                    {field.value}
                                  </code>
                                  <button
                                    type="button"
                                    aria-label={`Copy ${field.label}`}
                                    className="shrink-0 text-muted-foreground opacity-100 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                                    onClick={() => {
                                      void copyToClipboard(field.value);
                                      setCopiedField(field.label);
                                    }}
                                  >
                                    {copied ? (
                                      <Check className="size-3.5 text-emerald-500" />
                                    ) : (
                                      <Copy className="size-3.5" />
                                    )}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ) : null,
                  )}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground">
                No additional event details.
              </p>
            )}
            {copiedField ? (
              <span
                role="status"
                aria-label={`${copiedField} copied`}
                className="sr-only"
              >
                {copiedField} copied
              </span>
            ) : null}
            {trace ? (
              <div className="mt-4 border border-border">
                <TraceWaterfall compact trace={trace} />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          id="event-detail-panel"
          role="tabpanel"
          className="min-h-0 flex-1 overflow-auto"
        >
          <JsonView code={item.text} />
        </div>
      )}
    </section>
  );
}

type WorkspaceSidebarProps = {
  activeView: WorkspaceView;
  canSearch: boolean;
  collapsed: boolean;
  connection: ConnectionPresentation;
  retainedItemCount: number;
  snapshot: LocalTelemetrySnapshot;
  traceCount: number;
  onClear: () => void;
  onCloseSession?: () => void;
  onChangeReceiver: () => void;
  onOpenCommand: (trigger: HTMLButtonElement) => void;
  onSelect: (view: WorkspaceView) => void;
  onToggle: () => void;
};

function WorkspaceSidebar({
  activeView,
  canSearch,
  collapsed,
  connection,
  retainedItemCount,
  snapshot,
  traceCount,
  onClear,
  onCloseSession,
  onChangeReceiver,
  onOpenCommand,
  onSelect,
  onToggle,
}: WorkspaceSidebarProps) {
  const statusLabel = connection.label.replace(" to local receiver", "");
  const statusDotClass =
    connection.tone === "success"
      ? "bg-emerald-500 shadow-[0_0_10px_oklch(0.72_0.19_160)]"
      : connection.tone === "warning"
        ? "bg-amber-500"
        : "bg-muted-foreground";

  return (
    <aside
      aria-label="Workspace navigation"
      className={`hidden shrink-0 border-r border-border bg-muted/20 transition-[width] duration-200 md:flex md:flex-col ${
        collapsed ? "w-14" : "w-52"
      }`}
    >
      <div className="flex h-11 items-center border-b border-border px-3">
        {!collapsed ? (
          <>
            <img
              className="h-5 w-auto dark:hidden"
              src="/sentry-cli-light.svg"
              alt="Sentry CLI"
              width="117"
              height="20"
            />
            <img
              className="hidden h-5 w-auto dark:block"
              src="/sentry-cli.svg"
              alt=""
              width="117"
              height="20"
            />
          </>
        ) : null}
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            collapsed ? "mx-auto" : "ml-auto"
          }`}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronLeft className="size-4" />
          )}
        </button>
      </div>
      <div
        data-testid="sidebar-utility-bar"
        className={`shrink-0 border-b border-border p-2 ${
          collapsed ? "space-y-1" : "flex items-center justify-between"
        }`}
      >
        <span
          role="status"
          aria-label={connection.label}
          title={collapsed ? connection.label : undefined}
          className={`flex h-8 items-center rounded-md ${
            collapsed
              ? "justify-center px-0"
              : "gap-2 bg-emerald-500/10 px-2.5 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          <span className={`size-2 shrink-0 rounded-full ${statusDotClass}`} />
          {!collapsed ? (
            <span className="text-xs font-medium">{statusLabel}</span>
          ) : null}
          <span className="sr-only">{connection.label}</span>
        </span>
        {canSearch ? (
          <button
            type="button"
            aria-label="Search events"
            title="Search events and views (⌘K)"
            className={`flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              collapsed ? "mx-auto" : ""
            }`}
            onClick={(event) => onOpenCommand(event.currentTarget)}
          >
            <Search className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {(["Explore", "Inspect"] as const).map((section) => (
          <div key={section} className="space-y-1">
            {!collapsed ? (
              <p className="px-1 pb-1 pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {section}
              </p>
            ) : null}
            {workspaceNavigation
              .filter((entry) => entry.section === section)
              .map((entry) => {
                const Icon = entry.icon;
                const count =
                  entry.id === "traces"
                    ? traceCount
                    : entry.getItems(snapshot).length;
                const active = activeView === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-label={`Open ${entry.label.toLowerCase()} view`}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? entry.label : undefined}
                    className={`flex h-8 w-full items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      collapsed ? "justify-center px-0" : "gap-2 px-2 text-left"
                    } ${
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                    onClick={() => onSelect(entry.id)}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {!collapsed ? (
                      <>
                        <span className="min-w-0 flex-1 truncate">
                          {entry.label}
                        </span>
                        {count > 0 ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {count}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </button>
                );
              })}
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-border p-2">
        <div
          className={
            collapsed
              ? "space-y-1"
              : `grid ${onCloseSession ? "grid-cols-3" : "grid-cols-2"} gap-1`
          }
        >
          <button
            type="button"
            aria-label="Change receiver connection"
            title={collapsed ? "Change receiver connection" : undefined}
            className={`flex h-8 w-full items-center rounded-md text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              collapsed ? "justify-center px-0" : "justify-center gap-1.5 px-2"
            }`}
            onClick={onChangeReceiver}
          >
            <Radio className="size-3.5 shrink-0" aria-hidden="true" />
            {!collapsed ? <span>Change</span> : null}
          </button>
          <button
            type="button"
            aria-label="Clear events"
            title={collapsed ? "Clear events" : undefined}
            disabled={retainedItemCount === 0}
            className={`flex h-8 w-full items-center rounded-md text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
              collapsed ? "justify-center px-0" : "justify-center gap-1.5 px-2"
            }`}
            onClick={onClear}
          >
            <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
            {!collapsed ? <span>Clear</span> : null}
          </button>
          {onCloseSession ? (
            <button
              type="button"
              aria-label="Close telemetry session"
              title={collapsed ? "Close telemetry session" : undefined}
              className={`flex h-8 w-full items-center rounded-md text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                collapsed
                  ? "justify-center px-0"
                  : "justify-center gap-1.5 px-2"
              }`}
              onClick={onCloseSession}
            >
              <X className="size-3.5 shrink-0" aria-hidden="true" />
              {!collapsed ? <span>Close</span> : null}
            </button>
          ) : null}
        </div>
      </div>
    </aside>
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
  const [commandSearchQuery, setCommandSearchQuery] = useState(
    workspaceQuery.query,
  );
  const debouncedCommandSearchQuery = useDebounce(
    commandSearchQuery,
    SEARCH_DEBOUNCE_MS,
  );
  const isClearingCommandSearch = useRef(false);
  const [streamUrl, setStreamUrl] = useState(() =>
    resolveInitialStreamUrl(
      window.location.hash,
      getSavedStream(),
      getSavedRemoteStream(),
    ),
  );
  const [directoryUrl] = useState(() => getInitialSessionDirectory(streamUrl));
  const activeDirectoryUrl = parseSessionDirectoryUrl(directoryUrl, streamUrl);
  const connectionGeneration = useRef(0);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [draftEndpoint, setDraftEndpoint] = useState(streamUrl);
  const [isEditingReceiver, setIsEditingReceiver] = useState(false);
  const [isConnectionEnabled, setIsConnectionEnabled] = useState(true);
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
  const [message, setMessage] = useState<string | undefined>();
  const fallbackEventId = useRef(0);
  const commandTriggerRef = useRef<HTMLButtonElement>(null);
  const presentation = getConnectionPresentation(connection);
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
  const workspaceEmptyState = searchQuery.trim()
    ? {
        title: `No matching ${activeWorkspace.singularLabel}s`,
        description:
          "Try a different search term or clear the search to see everything in this view.",
      }
    : activeWorkspace.emptyState;
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

  useEffect(() => {
    if (isClearingCommandSearch.current) {
      if (debouncedCommandSearchQuery !== commandSearchQuery) {
        return;
      }
      isClearingCommandSearch.current = false;
    }
    if (debouncedCommandSearchQuery !== searchQuery) {
      void workspaceQuery.setSearchQuery(debouncedCommandSearchQuery);
    }
  }, [
    commandSearchQuery,
    debouncedCommandSearchQuery,
    searchQuery,
    workspaceQuery,
  ]);

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
    isClearingCommandSearch.current = true;
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

  const clearItems = () => {
    isClearingCommandSearch.current = true;
    setCommandSearchQuery("");
    telemetryStore.clear();
    setMessage(undefined);
    setLastViewedItemIds({});
    void workspaceQuery.clearWorkspace();

    const endpoint = parseStreamEndpoint(streamUrl);
    if (
      endpoint?.kind !== "loopback" ||
      !isLoopbackHost(window.location.hostname)
    ) {
      return;
    }
    const clearUrl = new URL(endpoint.url);
    const scopedSession = isScopedSessionStream(clearUrl.pathname);
    if (scopedSession) {
      clearUrl.pathname = clearUrl.pathname.replace(/\/stream$/, "/ui/reset");
    } else {
      clearUrl.pathname = "/clear";
      clearUrl.search = "";
    }
    const generation = connectionGeneration.current;
    void fetch(clearUrl, { method: scopedSession ? "POST" : "DELETE" })
      .then((response) => {
        if (!response.ok)
          throw new Error(`Session reset failed with HTTP ${response.status}`);
      })
      .catch(() => {
        if (connectionGeneration.current !== generation) return;
        setMessage(
          "Cleared this viewer, but the receiver could not clear its retained session.",
        );
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
    void fetch(closeUrl, { method: "POST" })
      .then((response) => {
        if (connectionGeneration.current !== generation) return;
        if (!response.ok) {
          throw new Error(`Session close failed with HTTP ${response.status}`);
        }
        setIsConnectionEnabled(false);
        setIsConnecting(false);
        setConnection("closed");
        setMessage(
          "Telemetry session closed. Retained events remain available for three hours.",
        );
      })
      .catch(() => {
        if (connectionGeneration.current !== generation) return;
        setMessage("Could not close this telemetry session.");
      });
  };

  const currentEndpoint = parseStreamEndpoint(streamUrl);
  const canEditRetention =
    currentEndpoint?.kind === "loopback" &&
    isLoopbackHost(window.location.hostname);
  const hasScopedSession =
    currentEndpoint?.kind === "loopback" &&
    isLoopbackHost(window.location.hostname) &&
    isScopedSessionStream(new URL(currentEndpoint.url).pathname);

  const connectToEndpoint = (nextStreamUrl: string) => {
    const endpoint = parseStreamEndpoint(nextStreamUrl);
    if (!endpoint) {
      setConnectionError(
        "Enter a loopback stream or an HTTPS remote stream ending in /stream.",
      );
      if (connection !== "connected") {
        setIsConnectionEnabled(false);
        setConnection("failed");
      }
      return;
    }
    connectionGeneration.current += 1;
    if (endpoint.url !== streamUrl) {
      telemetryStore.clear();
      telemetryStore.setLimit(DEFAULT_MAX_ENVELOPES);
      setRetentionLimit(DEFAULT_MAX_ENVELOPES);
      setHasRetentionSettings(false);
      setLastViewedItemIds({});
      fallbackEventId.current = 0;
      isClearingCommandSearch.current = true;
      setCommandSearchQuery("");
      void workspaceQuery.clearWorkspace();
    }
    setDraftEndpoint(endpoint.url);
    setStreamUrl(endpoint.url);
    setConnectionAttempt((attempt) => attempt + 1);
    setIsConnectionEnabled(true);
    setIsConnecting(true);
    setConnection("connecting");
    setConnectionError(undefined);
    setIsEditingReceiver(false);
  };

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  }, []);

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
    const onEnvelope = (event: Event) => {
      if (!isActiveConnection()) {
        return;
      }
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
      const endpoint = parseStreamEndpoint(streamUrl);
      if (endpoint?.kind === "loopback") {
        saveStreamUrl(endpoint.url);
      } else if (endpoint?.kind === "remote") {
        saveRemoteStreamUrl(endpoint.url);
      }
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
      source.removeEventListener(LOCAL_RETENTION_EVENT, onRetention);
      source.close();
    };
  }, [connectionAttempt, isConnectionEnabled, streamUrl, telemetryStore]);

  const showConnectionLanding =
    isEditingReceiver ||
    (!hasRetainedItems &&
      (connection === "connecting" ||
        connection === "failed" ||
        connection === "closed"));
  const isReceiverUnavailable =
    connection !== "connected" && !isConnecting && !hasRetainedItems;
  const canSearch = hasRetainedItems && !isEditingReceiver;
  const commandNavigation: CommandNavigationItem[] = workspaceNavigation.map(
    ({ icon, id, label }) => ({ icon, id, label }),
  );
  const setCommandOpen = (open: boolean) => {
    if (open) {
      setCommandSearchQuery(searchQuery);
    }
    setIsCommandOpen(open);
  };
  const openCommand = (trigger: HTMLButtonElement) => {
    commandTriggerRef.current = trigger;
    setCommandOpen(true);
  };

  return (
    <main className="h-dvh overflow-hidden bg-background">
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
            onClear={clearItems}
            onCloseSession={hasScopedSession ? closeScopedSession : undefined}
            onChangeReceiver={() => setIsEditingReceiver(true)}
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
                <img
                  className="h-5 w-auto dark:hidden"
                  src="/sentry-cli-light.svg"
                  alt="Sentry CLI"
                  width="117"
                  height="20"
                />
                <img
                  className="hidden h-5 w-auto dark:block"
                  src="/sentry-cli.svg"
                  alt=""
                  width="117"
                  height="20"
                />
              </div>
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
                  aria-label="Search events"
                  className="flex h-8 min-w-0 flex-1 items-center gap-2 border border-border bg-muted/30 px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                  onClick={(event) => openCommand(event.currentTarget)}
                >
                  <Search className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    Search events and views
                  </span>
                </button>
              ) : (
                <span className="flex-1" />
              )}
              <ReceiverControls
                connection={presentation}
                retainedItemCount={retainedItemCount}
                onClear={clearItems}
                onCloseSession={
                  hasScopedSession ? closeScopedSession : undefined
                }
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
                {workspaceNavigation.map((entry) => {
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
              </nav>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <section
              className="flex min-h-0 flex-1 flex-col"
              aria-label="Local Sentry events"
            >
              {activeDirectoryUrl ? (
                <SessionSwitcher
                  key={activeDirectoryUrl}
                  directoryUrl={activeDirectoryUrl}
                  streamUrl={streamUrl}
                  onSelect={connectToEndpoint}
                />
              ) : null}
              {hasRetentionSettings ? (
                <RetentionSettings
                  key={streamUrl}
                  limit={retentionLimit}
                  count={telemetry.envelopes.length}
                  streamUrl={streamUrl}
                  editable={canEditRetention && connection === "connected"}
                  unavailableReason={
                    canEditRetention && connection !== "connected"
                      ? "Reconnect to this receiver to change retention."
                      : undefined
                  }
                />
              ) : null}
              {connectionError &&
              connection === "failed" &&
              hasRetainedItems ? (
                <div
                  role="alert"
                  className="shrink-0 border-b border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
                >
                  {connectionError}
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
                  phase={
                    connection === "connecting"
                      ? "probing"
                      : connection === "failed"
                        ? "failed"
                        : "editing"
                  }
                  endpoint={draftEndpoint}
                  error={connectionError}
                  isConnecting={isConnecting}
                  onEndpointChange={setDraftEndpoint}
                  onConnect={() => connectToEndpoint(draftEndpoint)}
                />
              ) : !hasRetainedItems ? (
                <div className="flex flex-1 flex-col items-center justify-center border border-dashed border-border bg-muted/40 px-4 text-center">
                  <Terminal
                    className="mb-3 size-5 text-primary"
                    aria-hidden="true"
                  />
                  <p className="font-medium">Waiting for events</p>
                  <button
                    type="button"
                    className="mt-3 text-sm font-medium text-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setIsEditingReceiver(true)}
                  >
                    Change receiver
                  </button>
                </div>
              ) : workspaceView === "traces" ? (
                <TraceWorkspace
                  emptyState={workspaceEmptyState}
                  traces={searchedTraces}
                  selectedTraceId={workspaceQuery.traceId ?? undefined}
                  onSelect={(traceId) => {
                    void workspaceQuery.selectTrace(traceId);
                  }}
                />
              ) : (
                <div className="flex min-h-0 flex-1 overflow-hidden bg-card">
                  <aside
                    aria-labelledby="event-list-heading"
                    className="flex min-h-0 w-80 shrink-0 flex-col border-r border-border bg-muted/30"
                  >
                    <div className="shrink-0 border-b border-border px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <h1
                          id="event-list-heading"
                          className="text-sm font-semibold"
                        >
                          {activeWorkspace.label}
                        </h1>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {searchedItems.length} {activeWorkspace.singularLabel}
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
                          showTypeBadge={
                            workspaceView !== "errors" &&
                            workspaceView !== "envelopes"
                          }
                          onSelect={selectItem}
                        />
                      ))}
                      {searchedItems.length === 0 ? (
                        <li className="px-3 py-4 text-sm text-muted-foreground">
                          {workspaceEmptyState.title}
                        </li>
                      ) : null}
                    </ol>
                  </aside>
                  {searchedItems.length === 0 ? (
                    <WorkspaceEmptyState {...workspaceEmptyState} />
                  ) : selectedItem?.type === "envelope" ? (
                    <RawEnvelopeDetail item={selectedItem} />
                  ) : selectedItem ? (
                    <EventDetail
                      key={selectedItem.id}
                      item={selectedItem}
                      trace={selectedEventTrace}
                    />
                  ) : null}
                </div>
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
      />
    </main>
  );
}

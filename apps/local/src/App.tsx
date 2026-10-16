import { ExceptionOverview } from "./components/exception-overview.tsx";
import { getEventExceptions } from "./lib/exceptions.ts";
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
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Menu,
  Unplug,
  Radio,
  Settings,
  Trash2,
  X,
  Search,
  Terminal,
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
import { Button } from "@/components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";
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
              {item.type === "event"
                ? metadata.title
                : (metadata.route ?? metadata.title)}
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
  const exceptions =
    item.type === "event" ? getEventExceptions(item.payload) : [];
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
        ...(metadata.message
          ? [{ label: "Message", value: metadata.message }]
          : []),
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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:h-11 sm:flex-nowrap sm:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Badge>{metadata.operation ?? item.type}</Badge>
          <span className="truncate font-mono text-sm">{metadata.title}</span>
        </div>
        <div className="flex h-8 w-full shrink-0 items-center justify-between gap-3 sm:h-full sm:w-auto">
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
          <div className="w-full space-y-4">
            {exceptions.length > 0 ? (
              <ExceptionOverview exceptions={exceptions} />
            ) : null}
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
            ) : exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No additional event details.
              </p>
            ) : null}
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
  onDisconnect: () => void;
  isClearing: boolean;
  onCloseSession?: () => void;
  onChangeReceiver: (trigger: HTMLButtonElement) => void;
  isClosingSession: boolean;
  onOpenSettings: (trigger: HTMLButtonElement) => void;
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
  onDisconnect,
  isClearing,
  onCloseSession,
  onChangeReceiver,
  isClosingSession,
  onOpenSettings,
  onOpenCommand,
  onSelect,
  onToggle,
}: WorkspaceSidebarProps) {
  const sessionActions = [
    {
      label: "Clear events",
      Icon: Trash2,
      onClick: onClear,
      disabled: retainedItemCount === 0 || isClearing,
    },
    ...(onCloseSession
      ? [
          {
            label: "Close telemetry session",
            Icon: X,
            onClick: onCloseSession,
            disabled: isClosingSession || isClearing,
          },
        ]
      : []),
    {
      label: "Disconnect receiver",
      Icon: Unplug,
      onClick: onDisconnect,
      disabled: false,
    },
  ];
  const statusLabel = connection.label.replace(" to local receiver", "");
  const statusDotClass =
    connection.tone === "success"
      ? "bg-emerald-500"
      : connection.tone === "warning"
        ? "bg-amber-500"
        : "bg-muted-foreground";

  const statusPillClass =
    connection.tone === "success"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : connection.tone === "warning"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
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
            <CliLogo />
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
              : `gap-2 px-2.5 ${statusPillClass}`
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
      <TooltipProvider delayDuration={300}>
        <div
          role="group"
          aria-label="Receiver actions"
          className="shrink-0 space-y-1 border-t border-border p-2"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={collapsed ? "ghost" : "outline"}
                aria-label="Add receiver"
                onClick={(event) => onChangeReceiver(event.currentTarget)}
                className={`h-9 w-full font-normal text-muted-foreground hover:text-foreground ${collapsed ? "px-0" : "gap-2 px-2"}`}
              >
                <Radio className="size-4 shrink-0" aria-hidden="true" />
                {!collapsed ? <span>Add receiver</span> : null}
              </Button>
            </TooltipTrigger>
            {collapsed ? (
              <TooltipContent side="right">Add receiver</TooltipContent>
            ) : null}
          </Tooltip>
          <div
            className={`flex gap-1 ${collapsed ? "flex-col" : "items-center"}`}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Settings"
                  onClick={(event) => onOpenSettings(event.currentTarget)}
                  className={`text-muted-foreground ${collapsed ? "w-full" : ""}`}
                >
                  <Settings className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={collapsed ? "right" : "top"}>
                Settings
              </TooltipContent>
            </Tooltip>
            {!collapsed ? <span className="flex-1" /> : null}
            {sessionActions.map(({ label, Icon, onClick, disabled }) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <span className={collapsed ? "flex w-full" : "inline-flex"}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={label}
                      disabled={disabled}
                      onClick={onClick}
                      className={`text-muted-foreground ${label === "Disconnect receiver" ? "" : "hover:bg-destructive/10 hover:text-destructive"} ${collapsed ? "w-full" : ""}`}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side={collapsed ? "right" : "top"}>
                  {label === "Close telemetry session"
                    ? "Close session"
                    : label}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      </TooltipProvider>
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
      window.location.search,
    ),
  );
  const [isDisconnected, setIsDisconnected] = useState(getInitialDisconnected);
  const [hasEstablishedConnection, setHasEstablishedConnection] =
    useState(false);
  const [isClearing, setIsClearing] = useState(false);
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

  const clearDisplayedItems = () => {
    isClearingCommandSearch.current = true;
    setCommandSearchQuery("");
    telemetryStore.clear();
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
    setIsClearing(false);
    clearingGeneration.current = undefined;
    closingGeneration.current = undefined;
    setIsClosingSession(false);
    setDraftEndpoint(receiverAddress(streamUrl));
    receiverEndpointEdited.current = false;
    clearDisplayedItems();
  };
  const clearItems = () => {
    if (isClearing) return;
    const endpoint = parseStreamEndpoint(streamUrl);
    clearDisplayedItems();
    if (
      endpoint?.kind !== "loopback" ||
      !isLoopbackHost(window.location.hostname)
    )
      return;
    // Pause this generation before resetting. Replaying afterward captures all
    // post-reset arrivals without allowing queued pre-reset events back in.
    const generation = ++connectionGeneration.current;
    clearingGeneration.current = generation;
    setIsClearing(true);
    setIsConnectionEnabled(false);
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
          "Could not clear receiver data. Reconnect to try again.",
        );
        setMessage(
          "Cleared this viewer, but the receiver could not clear its retained session.",
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
        connectionGeneration.current += 1;
        setIsConnectionEnabled(false);
        setIsConnecting(false);
        setConnection("closed");
        setClosedSessionUrl(streamUrl);
        setConnectionError(undefined);
        setMessage(undefined);
      })
      .catch(() => {
        if (connectionGeneration.current !== generation) return;
        setMessage("Could not close this telemetry session.");
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
    setIsDisconnected(false);
    saveDisconnected(false);
    setIsClearing(false);
    clearingGeneration.current = undefined;
    connectionGeneration.current += 1;
    closingGeneration.current = undefined;
    setIsClosingSession(false);
    setIsSettingsOpen(false);
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
    const url = new URL(window.location.href);
    if (url.hash || url.searchParams.has("url")) {
      url.hash = "";
      url.searchParams.delete("url");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
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
  const canSearch = hasRetainedItems && !isEditingReceiver && !isSettingsOpen;
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
        supported={hasRetentionSettings}
        limit={retentionLimit}
        count={telemetry.envelopes.length}
        editable={canEditRetention && connection === "connected"}
        unavailableReason={
          connection === "closed"
            ? "Retention is read-only for closed sessions."
            : canEditRetention && connection !== "connected"
              ? "Reconnect to this receiver to change retention."
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

          <div className="flex min-h-0 min-w-0 flex-1">
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              aria-label="Local Sentry events"
            >
              {activeDirectoryUrl && !isDisconnected ? (
                <SessionSwitcher
                  key={activeDirectoryUrl}
                  refreshKey={closedSessionUrl}
                  onRetainedSession={setClosedSessionUrl}
                  directoryUrl={activeDirectoryUrl}
                  streamUrl={streamUrl}
                  selectInitialSession={
                    !isEditingReceiver &&
                    currentEndpoint?.kind === "loopback" &&
                    new URL(currentEndpoint.url).pathname === "/stream"
                  }
                  onSelect={connectToEndpoint}
                />
              ) : null}
              {!isDisconnected &&
              (isClosedSession ||
                (hasRetainedItems && connection === "failed")) ? (
                <div
                  role="status"
                  className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/20 px-4 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xs font-medium">
                      {isClosedSession
                        ? "Session closed"
                        : "Receiver disconnected"}
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isClosedSession
                        ? "Events remain available for up to 3 hours."
                        : connectionError}
                    </p>
                    {isClosedSession &&
                    connection === "failed" &&
                    connectionError ? (
                      <p role="alert" className="mt-2 text-xs text-destructive">
                        {connectionError}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 px-3 text-xs"
                    disabled={isConnecting}
                    aria-busy={isConnecting}
                    onClick={() => connectToEndpoint(streamUrl)}
                  >
                    {isClosedSession ? "Reload saved events" : "Reconnect"}
                  </Button>
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
                <div className="flex flex-1 flex-col items-center justify-center border border-dashed border-border bg-muted/40 px-4 text-center">
                  <Terminal
                    className="mb-3 size-5 text-primary"
                    aria-hidden="true"
                  />
                  <h2 className="font-medium">
                    {isClosedSession
                      ? "No saved events displayed"
                      : "Waiting for events"}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {isClosedSession
                      ? "Capture has stopped. Reload saved events or connect to another session."
                      : "Send events to the selected receiver to see them here."}
                  </p>
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
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card md:flex-row">
                  <aside
                    aria-labelledby="event-list-heading"
                    className="flex h-44 min-h-0 w-full shrink-0 flex-col border-b border-border bg-muted/30 md:h-auto md:w-80 md:border-r md:border-b-0"
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

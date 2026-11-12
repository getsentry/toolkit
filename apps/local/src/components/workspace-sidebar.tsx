import { sdkInventory } from "@/lib/inspection.ts";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Radio,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { useId, useState } from "react";
import type { ConnectionPresentation } from "../lib/presentation.ts";
import type { LocalTelemetrySnapshot } from "../lib/telemetry-store.ts";
import type { WorkspaceView } from "../lib/workspace.ts";
import {
  workspaceNavigation,
  type WorkspaceNavigationItem,
} from "../lib/workspace-navigation.ts";
import { CliLogo } from "./cli-logo.tsx";
import { ReceiverControls } from "./receiver-controls.tsx";
import { Button } from "./ui/button.tsx";

export type WorkspaceSidebarProps = {
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
  onDeleteCapturedEvents?: (trigger: HTMLButtonElement) => void;
};

/** The main debugging views stay visible; secondary SDK data is discoverable. */
export function WorkspaceSidebar({
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
  onDeleteCapturedEvents,
}: WorkspaceSidebarProps) {
  const diagnosticsId = useId();
  const activeDiagnostics = workspaceNavigation.some(
    (entry) => entry.id === activeView && entry.section === "Diagnostics",
  );
  const [diagnosticsState, setDiagnosticsState] = useState({
    view: activeView,
    open: activeDiagnostics,
  });
  const diagnosticsOpen =
    diagnosticsState.view === activeView
      ? diagnosticsState.open
      : activeDiagnostics || diagnosticsState.open;

  const renderEntry = (entry: WorkspaceNavigationItem) => {
    const Icon = entry.icon;
    const count =
      entry.section === "Performance"
        ? 0
        : entry.id === "sdks"
          ? sdkInventory(snapshot.items).length
          : entry.id === "traces"
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
        className={`flex h-8 w-full items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${collapsed ? "justify-center px-0" : "gap-2 px-2 text-left"} ${active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
        onClick={() => onSelect(entry.id)}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {count > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {count}
              </span>
            ) : null}
          </>
        ) : null}
      </button>
    );
  };

  return (
    <aside
      aria-label="Workspace navigation"
      className={`hidden shrink-0 border-r border-border bg-muted/20 transition-[width] duration-200 motion-reduce:transition-none md:flex md:flex-col ${collapsed ? "w-14" : "w-52"}`}
    >
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
        {!collapsed ? (
          <>
            <CliLogo />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Settings"
              title="Settings"
              className="ml-auto size-8 text-muted-foreground"
              onClick={(event) => onOpenSettings(event.currentTarget)}
            >
              <Settings className="size-4" aria-hidden="true" />
            </Button>
          </>
        ) : null}
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${collapsed ? "mx-auto" : "ml-auto"}`}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className="size-4" aria-hidden="true" />
          ) : (
            <ChevronLeft className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {canSearch ? (
        <div
          data-testid="sidebar-utility-bar"
          className="shrink-0 border-b border-border p-2"
        >
          <Button
            type="button"
            variant="ghost"
            aria-label="Search this session"
            title="Search this session (⌘/Ctrl+K)"
            className={`h-9 w-full text-muted-foreground ${collapsed ? "px-0" : "justify-start px-2 text-xs"}`}
            onClick={(event) => onOpenCommand(event.currentTarget)}
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            {!collapsed ? <span>Search this session</span> : null}
          </Button>
        </div>
      ) : null}
      <nav className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <div className="space-y-1">
          <p
            className={
              collapsed
                ? "sr-only"
                : "px-2 pb-1 pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            }
          >
            Explore
          </p>
          {workspaceNavigation
            .filter((entry) => entry.section === "Explore")
            .map(renderEntry)}
        </div>
        <div className="space-y-1">
          <p
            className={
              collapsed
                ? "sr-only"
                : "px-2 pb-1 pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            }
          >
            Performance
          </p>
          {workspaceNavigation
            .filter((entry) => entry.section === "Performance")
            .map(renderEntry)}
        </div>
        <div className="space-y-1">
          <button
            type="button"
            aria-label="Diagnostics"
            title={collapsed ? "Diagnostics" : undefined}
            aria-expanded={diagnosticsOpen}
            aria-controls={diagnosticsId}
            className={`flex h-8 w-full items-center rounded-md text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${collapsed ? "justify-center px-0" : "gap-2 px-2"}`}
            onClick={() =>
              setDiagnosticsState({ view: activeView, open: !diagnosticsOpen })
            }
          >
            {collapsed ? (
              <SlidersHorizontal className="size-4" aria-hidden="true" />
            ) : (
              <>
                <span className="flex-1 text-left">Diagnostics</span>
                <ChevronDown
                  className={`size-3.5 transition-transform motion-reduce:transition-none ${diagnosticsOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </>
            )}
          </button>
          <div
            id={diagnosticsId}
            hidden={!diagnosticsOpen}
            className="space-y-1"
          >
            {workspaceNavigation
              .filter((entry) => entry.section === "Diagnostics")
              .map(renderEntry)}
          </div>
        </div>
      </nav>
      <div
        className={`shrink-0 space-y-2 border-t border-border p-2 ${collapsed ? "[&_[data-slot=popover-trigger]]:size-9 [&_[data-slot=popover-trigger]]:px-0 [&_[data-slot=popover-trigger]>span]:sr-only" : "[&_[data-slot=popover-trigger]]:w-full"}`}
      >
        {!collapsed ? (
          <Button
            type="button"
            variant="outline"
            aria-label="Switch receiver"
            className="h-9 w-full justify-start px-2 font-normal text-muted-foreground"
            onClick={(event) => onChangeReceiver(event.currentTarget)}
          >
            <Radio className="size-4" aria-hidden="true" />
            Switch receiver
          </Button>
        ) : null}
        <ReceiverControls
          connection={connection}
          retainedItemCount={retainedItemCount}
          onClear={onClear}
          onDisconnect={onDisconnect}
          isClearing={isClearing}
          onCloseSession={onCloseSession}
          isClosingSession={isClosingSession}
          onAddReceiver={collapsed ? onChangeReceiver : undefined}
          onOpenSettings={collapsed ? onOpenSettings : undefined}
          onDeleteCapturedEvents={onDeleteCapturedEvents}
          showStatusRole={false}
        />
      </div>
    </aside>
  );
}

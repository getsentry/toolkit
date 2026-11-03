import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, Layers3, RefreshCw } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import {
  parseViewerSessions,
  type ViewerSession,
} from "../lib/session-directory.ts";

/** A read-only directory remains independent of the selected telemetry stream. */
export function SessionSwitcher({
  directoryUrl,
  streamUrl,
  onSelect,
  selectInitialSession = false,
  refreshKey,
  onRetainedSession,
  onCurrentSessionChange,
  showState = true,
}: {
  selectInitialSession?: boolean;
  onCurrentSessionChange?: (session: ViewerSession | undefined) => void;
  showState?: boolean;
  refreshKey?: string;
  onRetainedSession?: (streamUrl: string) => void;
  directoryUrl: string;
  streamUrl: string;
  onSelect: (streamUrl: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ViewerSession[]>([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function load() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10_000);
      try {
        const response = await fetch(directoryUrl, {
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("Session discovery unavailable");
        const next = parseViewerSessions(await response.json(), directoryUrl);
        if (!active) return;
        setSessions(next);
        setLoaded(true);
        setError(false);
      } catch {
        if (active) setError(true);
      } finally {
        clearTimeout(timeout);
        if (active) timer = setTimeout(() => void load(), 5000);
      }
    }
    void load();
    return () => {
      active = false;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [directoryUrl, refresh, refreshKey]);
  useEffect(() => {
    // Only the daemon-wide /stream entry point selects an initial run. Expiring
    // or closing a selected scoped session must never silently change feeds.
    if (selectInitialSession && sessions[0]) onSelect(sessions[0].streamUrl);
  }, [selectInitialSession, sessions, onSelect]);
  const current = sessions.find((s) => s.streamUrl === streamUrl);
  useEffect(() => {
    onCurrentSessionChange?.(current);
  }, [current, onCurrentSessionChange]);
  useEffect(() => {
    if (current?.state === "retained") onRetainedSession?.(streamUrl);
  }, [current?.state, streamUrl, onRetainedSession]);
  return (
    <section
      aria-label="Local sessions"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label="Session"
            aria-expanded={open}
            className="h-9 min-w-0 flex-1 justify-between gap-2 px-2.5 sm:max-w-72"
          >
            <Layers3
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-left">
              {current?.label ?? "Choose session"}
            </span>
            {current && showState ? (
              <Badge
                variant={current.state === "open" ? "success" : "default"}
                className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
              >
                {current.state === "open" ? "Capturing" : "Saved"}
              </Badge>
            ) : null}
            <ChevronsUpDown
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={12}
          aria-label="Switch session"
          className="w-[26rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
        >
          <Command label="Search sessions">
            <CommandInput
              aria-label="Search sessions"
              placeholder="Search sessions…"
            />
            <CommandList className="max-h-80">
              <CommandEmpty>
                {error
                  ? "Sessions unavailable."
                  : !loaded
                    ? "Loading sessions…"
                    : sessions.length
                      ? "No matching sessions."
                      : "No sessions available."}
              </CommandEmpty>
              {(["open", "retained"] as const).map((state) => {
                const entries = sessions.filter(
                  (session) => session.state === state,
                );
                return entries.length ? (
                  <CommandGroup
                    key={state}
                    heading={state === "open" ? "Capturing" : "Saved"}
                  >
                    {entries.map((session) => (
                      <CommandItem
                        key={session.id}
                        aria-label={`${session.label} · ${state === "open" ? "Capturing" : "Saved"} · ${session.cwd} · ${session.id.slice(-8)}`}
                        value={`${session.id} ${session.label} ${session.cwd}`}
                        className="min-w-0 gap-3 px-2.5 py-2.5"
                        onSelect={() => {
                          if (session.streamUrl !== streamUrl)
                            onSelect(session.streamUrl);
                          setOpen(false);
                        }}
                      >
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${state === "open" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {session.label}
                          </div>
                          <div
                            className="truncate font-mono text-xs text-muted-foreground"
                            title={session.cwd}
                          >
                            {session.cwd}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {session.id.slice(-8)}
                        </span>
                        <Check
                          className={`size-4 shrink-0 ${current?.id === session.id ? "text-primary opacity-100" : "opacity-0"}`}
                          aria-hidden="true"
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null;
              })}
            </CommandList>
          </Command>
          <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}{" "}
            on this receiver
          </p>
        </PopoverContent>
      </Popover>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Refresh sessions"
        title="Refresh sessions"
        className="size-8 text-muted-foreground"
        onClick={() => setRefresh((value) => value + 1)}
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
      </Button>
      {error ? (
        <p role="status" className="w-full text-xs text-muted-foreground">
          Could not refresh sessions. Your current feed is still available.
        </p>
      ) : null}
    </section>
  );
}

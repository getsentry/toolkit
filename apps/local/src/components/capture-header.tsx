import { LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import type { ConnectionState } from "../lib/presentation.ts";
import type { ViewerSession } from "../lib/session-directory.ts";
import { parseStreamEndpoint } from "../lib/spotlight.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

export type CaptureHeaderProps = {
  streamUrl: string | null;
  connection: ConnectionState;
  isClosed: boolean;
  expiresAt?: number;
  session?: ViewerSession;
  latestEventTime?: number;
  sessionPicker?: ReactNode;
  onReload: () => void;
  isReloading: boolean;
  isAwaitingSession?: boolean;
};

function validDate(timestamp: number | undefined): Date | undefined {
  return typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    timestamp <= 8.64e15
    ? new Date(timestamp)
    : undefined;
}

const MAX_TIMEOUT = 2_147_483_647;

/** A frozen receiver deadline needs one wake-up, with long delays bounded safely. */
function useCaptureExpired(deadline: number | undefined): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (deadline === undefined) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          notify();
          return;
        }
        timer = setTimeout(check, Math.min(remaining, MAX_TIMEOUT));
      };
      check();
      return () => clearTimeout(timer);
    },
    [deadline],
  );
  const getSnapshot = useCallback(
    () => deadline !== undefined && Date.now() >= deadline,
    [deadline],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const RECEIVER_STATES: Record<ConnectionState, string> = {
  connected: "Receiver connected",
  connecting: "Connecting to receiver",
  reconnecting: "Reconnecting to receiver",
  failed: "Receiver unavailable",
  missing: "Viewer disconnected",
  closed: "Receiver replay complete",
};

/** Capture lifecycle and viewer transport stay separate, including finite replay. */
export function CaptureHeader({
  streamUrl,
  connection,
  isClosed,
  expiresAt,
  session,
  latestEventTime,
  sessionPicker,
  onReload,
  isReloading,
  isAwaitingSession = false,
}: CaptureHeaderProps) {
  const endpoint = parseStreamEndpoint(streamUrl);
  const currentSession = session?.streamUrl === streamUrl ? session : undefined;
  const awaiting = isAwaitingSession || !endpoint;
  const saved = !awaiting && (isClosed || currentSession?.state === "retained");
  const received = validDate(latestEventTime);
  const savedUntil = saved
    ? validDate(expiresAt ?? currentSession?.expiresAt)
    : undefined;
  const expired = useCaptureExpired(savedUntil?.getTime());
  const state = awaiting
    ? "Choose a capture"
    : saved
      ? expired
        ? "Saved capture expired"
        : "Saved capture"
      : connection === "connected"
        ? "Capturing"
        : connection === "connecting" || connection === "reconnecting"
          ? "Connecting"
          : "Connection lost";
  const receiverLabel = endpoint ? new URL(endpoint.url).origin : undefined;
  const canReload =
    !awaiting &&
    (saved ||
      connection === "connected" ||
      connection === "failed" ||
      connection === "closed" ||
      isReloading);
  const tone =
    saved || awaiting
      ? "default"
      : connection === "connected"
        ? "success"
        : connection === "failed"
          ? "warning"
          : "default";
  return (
    <header
      aria-label="Capture context"
      className="shrink-0 border-b border-border bg-muted/10 px-3 py-3 sm:px-4"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            {sessionPicker ?? (
              <h2 className="truncate text-sm font-semibold">
                {currentSession?.label ??
                  (endpoint?.kind === "remote"
                    ? "Remote capture"
                    : "Local capture")}
              </h2>
            )}
          </div>
          <Badge variant={tone} className="shrink-0 font-normal">
            <span role="status" aria-label="Capture state">
              {state}
            </span>
          </Badge>
        </div>
        {currentSession?.cwd ? (
          <p
            className="truncate text-xs text-muted-foreground"
            title={currentSession.cwd}
          >
            {currentSession.cwd}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {connection === "connected"
              ? endpoint?.kind === "loopback"
                ? "Connected to local receiver"
                : "Connected to receiver"
              : RECEIVER_STATES[connection]}
          </span>
          {receiverLabel ? (
            <span className="max-w-full truncate" title={receiverLabel}>
              {receiverLabel}
            </span>
          ) : null}
          {received ? (
            <span>
              Last received{" "}
              <time
                dateTime={received.toISOString()}
                title={received.toLocaleString()}
              >
                {received.toLocaleTimeString()}
              </time>
            </span>
          ) : null}
          {savedUntil ? (
            <span>
              Saved until{" "}
              <time dateTime={savedUntil.toISOString()}>
                {savedUntil.toLocaleString()}
              </time>
            </span>
          ) : null}
          {canReload ? (
            <Button
              type="button"
              variant="ghost"
              className="ml-auto h-8 shrink-0 px-2 text-xs"
              disabled={isReloading || expired}
              aria-busy={isReloading}
              onClick={onReload}
            >
              {isReloading ? (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              {connection === "failed" ? "Reconnect" : "Reload capture"}
            </Button>
          ) : null}
        </div>
        {expired ? (
          <p className="text-xs text-muted-foreground">
            Events already loaded in this tab remain available.
          </p>
        ) : null}
      </div>
    </header>
  );
}

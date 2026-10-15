import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  parseViewerSessions,
  saveSessionDirectory,
  type ViewerSession,
} from "../lib/session-directory.ts";

/** A read-only directory remains independent of the selected telemetry stream. */
export function SessionSwitcher({
  directoryUrl,
  streamUrl,
  onSelect,
}: {
  directoryUrl: string;
  streamUrl: string;
  onSelect: (streamUrl: string) => void;
}) {
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
        saveSessionDirectory(directoryUrl);
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
  }, [directoryUrl, refresh]);
  const current = sessions.find((s) => s.streamUrl === streamUrl);
  return (
    <section
      aria-label="Local sessions"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
    >
      <label htmlFor="local-session" className="text-sm text-muted-foreground">
        Session
      </label>
      <select
        id="local-session"
        aria-label="Session"
        value={current?.id ?? ""}
        className="min-w-0 max-w-full flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => {
          const selected = sessions.find((s) => s.id === event.target.value);
          if (selected) onSelect(selected.streamUrl);
        }}
      >
        {!current ? (
          <option value="" disabled>
            {sessions.length
              ? "Current session unavailable"
              : error
                ? "Sessions unavailable"
                : loaded
                  ? "No sessions available"
                  : "Loading sessions…"}
          </option>
        ) : null}
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.label} ·{" "}
            {session.state === "open" ? "Running" : "Retained"} · {session.cwd}{" "}
            · {session.id.slice(-8)}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Refresh sessions"
        title="Refresh sessions"
        className="rounded p-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setRefresh((value) => value + 1)}
      >
        <RefreshCw className="size-4" aria-hidden="true" />
      </button>
      {error ? (
        <p role="status" className="w-full text-xs text-muted-foreground">
          Could not refresh sessions. The selected feed is unchanged. Retry with
          Refresh sessions.
        </p>
      ) : null}
    </section>
  );
}

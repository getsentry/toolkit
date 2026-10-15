import { Check, Copy, History, LoaderCircle, Radio, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useCopyToClipboard } from "@uidotdev/usehooks";
import { connectionLabel } from "../lib/connection-history.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";

export type ConnectionFormProps = {
  endpoint: string;
  error?: string;
  isConnecting: boolean;
  onConnect: () => void;
  onEndpointChange: (value: string) => void;
  recentConnections: string[];
  onReconnect: (url: string) => void;
  onForget: (url: string) => void;
};

/** Shared receiver entry and recent connections for the landing and modal. */
export function ConnectionForm({
  endpoint,
  error,
  isConnecting,
  onConnect,
  onEndpointChange,
  recentConnections,
  onReconnect,
  onForget,
}: ConnectionFormProps) {
  const inputId = useId();
  const errorId = useId();
  const [copied, setCopied] = useState(false);
  const [, copyToClipboard] = useCopyToClipboard();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isConnecting) onConnect();
  };
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          Receiver endpoint
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="url"
            required
            value={endpoint}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onEndpointChange(event.target.value)}
            className="min-w-0 flex-1 font-mono"
            placeholder="http://localhost:8969/stream"
          />
          <Button
            type="submit"
            disabled={isConnecting}
            aria-busy={isConnecting}
            aria-label={isConnecting ? "Connecting to receiver" : "Connect"}
          >
            {isConnecting ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {isConnecting ? "Connecting" : "Connect"}
          </Button>
        </div>
        {error ? (
          <p
            id={errorId}
            role="alert"
            aria-label="Receiver connection error"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          Use your local receiver's plain /stream address to discover its
          sessions, or enter an HTTPS stream.
        </p>
      </form>
      {recentConnections.length ? (
        <section
          aria-label="Past connections"
          className="space-y-2 border-t pt-4"
        >
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <History
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            Past connections
          </h3>
          <p className="text-xs text-muted-foreground">
            Recent receivers in this tab. Reconnect to discover available
            sessions.
          </p>
          <TooltipProvider delayDuration={300}>
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {recentConnections.map((url) => (
                <li
                  key={url}
                  className="flex min-w-0 items-center gap-1 rounded-md border bg-background"
                >
                  <Button
                    variant="ghost"
                    disabled={isConnecting}
                    className="min-w-0 flex-1 justify-start px-2 font-mono text-xs"
                    aria-label={`Reconnect to ${connectionLabel(url)}`}
                    onClick={() => onReconnect(url)}
                  >
                    <Radio
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">{connectionLabel(url)}</span>
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 text-muted-foreground"
                        aria-label={`Forget ${connectionLabel(url)}`}
                        onClick={() => onForget(url)}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Forget connection</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </TooltipProvider>
        </section>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          sentry local serve --open
        </code>
        <Button
          type="button"
          variant="ghost"
          className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
          aria-label="Copy local serve command"
          onClick={() => {
            void copyToClipboard("sentry local serve --open");
            setCopied(true);
          }}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-500" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy command"}
        </Button>
      </div>
    </div>
  );
}

export type ConnectionLandingProps = ConnectionFormProps & {
  phase: "probing" | "failed" | "editing" | "closed";
  onReconnectSession?: () => void;
};

/** A focused landing when no captured events are available to inspect. */
export function ConnectionLanding({
  phase,
  onReconnectSession,
  ...form
}: ConnectionLandingProps) {
  const titleId = useId();
  const isProbing = phase === "probing";
  const closed = phase === "closed";
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-muted/10 px-4 py-8 sm:p-8"
    >
      <div className="my-auto w-full max-w-xl space-y-5 rounded-lg border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <div
            role={isProbing ? "status" : undefined}
            aria-label={isProbing ? "Checking receiver" : undefined}
            className="relative mt-0.5 flex size-5 shrink-0 items-center justify-center"
          >
            {isProbing ? (
              <span className="absolute -inset-1 rounded-full border-2 border-primary/15 border-r-primary/50 border-t-primary motion-safe:animate-[spin_1.1s_linear_infinite] motion-reduce:animate-none" />
            ) : null}
            {closed ? (
              <Check className="size-5 text-primary" aria-hidden="true" />
            ) : (
              <Radio
                className={`size-5 ${isProbing ? "text-primary" : "text-muted-foreground"}`}
                aria-hidden="true"
              />
            )}
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-primary uppercase">
              Sentry Local
            </p>
            <h2 id={titleId} className="mt-1 text-xl font-semibold">
              {isProbing
                ? "Looking for Sentry Local"
                : closed
                  ? "Session closed"
                  : "Connect a receiver"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isProbing
                ? "Checking the selected receiver."
                : closed
                  ? "Capture has stopped. Retained events remain available for up to three hours. Reconnect to inspect them or choose another receiver below."
                  : "Connect this viewer to a local receiver or an HTTPS event stream."}
            </p>
          </div>
        </div>
        {onReconnectSession ? (
          <Button
            type="button"
            variant="outline"
            disabled={form.isConnecting}
            aria-busy={form.isConnecting}
            onClick={onReconnectSession}
          >
            Reconnect to session
          </Button>
        ) : null}
        <ConnectionForm {...form} />
      </div>
    </section>
  );
}

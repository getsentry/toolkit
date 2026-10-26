import { Check, Copy, History, LoaderCircle, Radio, X } from "lucide-react";
import { type FormEvent, useId } from "react";
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
          Paste a local /stream address or an HTTPS stream URL.
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
          <TooltipProvider delayDuration={300}>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {recentConnections.map((url) => (
                <li
                  key={url}
                  className="flex min-w-0 items-center gap-1 rounded-md hover:bg-muted/60"
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
    </div>
  );
}

export type ConnectionLandingProps = ConnectionFormProps & {
  phase: "probing" | "failed" | "editing";
};

/** A focused landing when no captured events are available to inspect. */
export function ConnectionLanding({ phase, ...form }: ConnectionLandingProps) {
  const titleId = useId();
  const isProbing = phase === "probing";
  const [copied, copyToClipboard] = useCopyToClipboard();
  const command = "sentry local run --session web --open -- <your dev command>";
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-muted/10 px-4 py-8 sm:p-8"
    >
      <div className="my-auto w-full max-w-lg space-y-6 rounded-xl border bg-card p-5 shadow-sm sm:p-7">
        <div className="flex items-start gap-3">
          <div
            role={isProbing ? "status" : undefined}
            aria-label={isProbing ? "Checking receiver" : undefined}
            className="relative mt-0.5 flex size-5 shrink-0 items-center justify-center"
          >
            {isProbing ? (
              <span className="absolute -inset-1 rounded-full border-2 border-primary/15 border-r-primary/50 border-t-primary motion-safe:animate-[spin_1.1s_linear_infinite] motion-reduce:animate-none" />
            ) : null}
            <Radio
              className={`size-5 ${isProbing ? "text-primary" : "text-muted-foreground"}`}
              aria-hidden="true"
            />
          </div>
          <div>
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {isProbing ? "Connecting to receiver" : "Capture a local session"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isProbing
                ? "Establishing a connection…"
                : "Inspect events from your local development sessions."}
            </p>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Run this in your project to start capturing and open the viewer.
            Replace {"<your dev command>"} with your app’s development command.
          </p>
          <code className="block break-words rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
            {command}
          </code>
          <Button
            type="button"
            className="w-full"
            aria-label="Copy local run command"
            onClick={() => copyToClipboard(command)}
          >
            {copied === command ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied === command ? "Copied" : "Copy command"}
          </Button>
        </div>
        <section
          className="space-y-4 border-t pt-5"
          aria-label="Connect an existing receiver"
        >
          <h3 className="text-sm font-medium">Connect an existing receiver</h3>
          <ConnectionForm {...form} />
        </section>
      </div>
    </section>
  );
}

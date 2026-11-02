/** Local control-plane management and agent query commands. */

import { basename } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  choiceParser,
  parseLocalSession,
  parseText,
  textParser,
} from "../../lib/completion-target.js";
import { CliError, ValidationError } from "../../lib/errors.js";
import { formatLocalControlResult } from "../../lib/formatters/local.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { buildRouteMap } from "../../lib/route-map.js";
import {
  ensureLocalDaemon,
  type LocalDaemonState,
  getRunningLocalDaemon,
  requestLocalDaemon,
  runLocalDaemonForeground,
  waitForLocalDaemonShutdown,
} from "./daemon.js";
import { parsePort } from "./server.js";
import { logger } from "../../lib/logger.js";
import { redactCredentialText } from "../../lib/credential-redaction.js";

import {
  MAX_ENVELOPES_FLAG,
  OPTIONAL_MAX_ENVELOPES_FLAG,
} from "./retention-buffer.js";
import { LOOPBACK_HOSTS } from "./loopback.js";

type DaemonFlags = {
  readonly foreground: boolean;
  readonly host: string;
  readonly port: number;
};
type SessionFlags = {
  readonly "max-envelopes": number;
  readonly clientId?: string;
  readonly host: string;
  readonly port: number;
};
type ControlResult = Record<string, unknown>;

function publicDaemonState({
  host,
  pid,
  port,
  version,
}: LocalDaemonState): ControlResult {
  return { host, pid, port, version };
}

const CONTROL_COMMAND_DEFAULTS = {
  auth: false,
  output: { human: formatLocalControlResult },
} as const;

const DAEMON_CONNECTION_FLAGS = {
  host: {
    kind: "parsed",
    parse: choiceParser(LOOPBACK_HOSTS),
    brief: "Loopback host",
    default: "localhost",
  },
  port: {
    kind: "parsed",
    parse: textParser(parsePort),
    brief: "Control-plane port",
    default: "8969",
  },
} as const;

const SESSION_REFERENCE_POSITIONAL = {
  kind: "array",
  parameter: {
    brief: "Session ID or unique name",
    parse: parseLocalSession,
    placeholder: "session",
  },
} as const;

async function controlJson(
  path: string,
  init: RequestInit = {},
  options: { host?: string; port?: number } = {},
): Promise<ControlResult> {
  const state = await ensureLocalDaemon(options);
  const response = await requestLocalDaemon(state, path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch((error: unknown) => {
      logger.debug("Could not read Local control-plane error details", error);
      return undefined;
    });
    const detail =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? ` ${redactCredentialText(body.error)}`
        : "";
    throw new CliError(
      `Sentry Local control plane request failed with HTTP ${response.status}.${detail}`,
      1,
    );
  }
  if (response.status === 204 || response.status === 202) {
    return { ok: true };
  }
  return (await response.json()) as ControlResult;
}

function singleReference(parts: string[]): string {
  const reference = parts.join(" ").trim();
  if (!reference) {
    throw new ValidationError("Provide a Local session or envelope ID.", "id");
  }
  return reference;
}

/** Request shutdown and confirm discovery and ownership have been released. */
async function stopLocalDaemon(state: LocalDaemonState): Promise<void> {
  const response = await requestLocalDaemon(state, "/daemon/stop", {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  }).catch((error: unknown) => {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new CliError(
        "Timed out requesting Local daemon shutdown; its discovery state has been preserved.",
        1,
      );
    }
    throw error;
  });
  if (!response.ok) {
    throw new CliError(
      `Could not stop the Local daemon (HTTP ${response.status}).`,
      1,
    );
  }
  await waitForLocalDaemonShutdown(state);
}

const daemonStartCommand = buildCommand({
  docs: { brief: "Start the Local control-plane daemon" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: {
    flags: {
      foreground: {
        kind: "boolean",
        brief: "Run in the foreground",
        default: false,
      },
      ...DAEMON_CONNECTION_FLAGS,
    },
  },
  async *func(flags: DaemonFlags) {
    if (flags.foreground) {
      await runLocalDaemonForeground(flags);
      return;
    }
    yield new CommandOutput(publicDaemonState(await ensureLocalDaemon(flags)));
  },
});

const daemonStatusCommand = buildCommand({
  docs: { brief: "Show Local control-plane status" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: { flags: {} },
  async *func() {
    const daemon = await getRunningLocalDaemon();
    yield new CommandOutput({
      daemon: daemon ? publicDaemonState(daemon) : null,
    });
  },
});

const daemonStopCommand = buildCommand({
  docs: { brief: "Stop the Local control-plane daemon" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: { flags: {} },
  async *func() {
    const state = await getRunningLocalDaemon();
    if (!state) {
      yield new CommandOutput({ stopped: false, reason: "not running" });
      return;
    }
    await stopLocalDaemon(state);
    yield new CommandOutput({ stopped: true });
  },
});

const daemonRestartCommand = buildCommand({
  docs: { brief: "Restart the Local control-plane daemon" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: { flags: {} },
  async *func() {
    const state = await getRunningLocalDaemon();
    if (state) {
      await stopLocalDaemon(state);
    }
    yield new CommandOutput(
      publicDaemonState(
        await ensureLocalDaemon(
          state ? { host: state.host, port: state.port } : {},
        ),
      ),
    );
  },
});

const sessionCreateCommand = buildCommand({
  docs: { brief: "Create a Local telemetry session" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: {
    flags: {
      clientId: {
        kind: "parsed",
        parse: parseText,
        brief: "Idempotency key for retried agent session creation",
        optional: true,
      },
      ...DAEMON_CONNECTION_FLAGS,
      "max-envelopes": MAX_ENVELOPES_FLAG,
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Optional session label",
        parse: parseText,
        placeholder: "name",
      },
    },
  },
  async *func(this: SentryContext, flags: SessionFlags, ...parts: string[]) {
    const label = parts.join(" ").trim() || basename(this.cwd);
    yield new CommandOutput(
      await controlJson(
        "/sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: flags.clientId,
            maxEnvelopes: flags["max-envelopes"],
            label,
            cwd: this.cwd,
          }),
        },
        flags,
      ),
    );
  },
});

const sessionListCommand = buildCommand({
  docs: { brief: "List Local telemetry sessions" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: { flags: {} },
  async *func() {
    yield new CommandOutput(await controlJson("/sessions"));
  },
});

/** Commands that target one session share argument parsing and URL construction. */
function buildSessionCommand(
  brief: string,
  suffix = "",
  method: "GET" | "POST" = "GET",
): ReturnType<typeof buildCommand> {
  return buildCommand({
    ...CONTROL_COMMAND_DEFAULTS,
    docs: { brief },
    parameters: { flags: {}, positional: SESSION_REFERENCE_POSITIONAL },
    async *func(_flags, ...parts: string[]) {
      yield new CommandOutput(
        await controlJson(
          `/sessions/${encodeURIComponent(singleReference(parts))}${suffix}`,
          { method },
        ),
      );
    },
  });
}

/** Event and envelope lookup both use the final argument as the telemetry ID. */
function buildTelemetryViewCommand(
  kind: "event" | "envelope",
  brief: string,
): ReturnType<typeof buildCommand> {
  return buildCommand({
    ...CONTROL_COMMAND_DEFAULTS,
    docs: { brief },
    parameters: {
      flags: {},
      positional: {
        kind: "array",
        parameter: {
          brief: `Session and ${kind} ID`,
          parse: parseLocalSession,
          placeholder: `session ${kind}`,
        },
      },
    },
    async *func(_flags, ...parts: string[]) {
      const session = parts.slice(0, -1).join(" ").trim();
      const id = parts.at(-1);
      if (!(session && id)) {
        throw new ValidationError(`Provide a session and ${kind} ID.`, kind);
      }
      yield new CommandOutput(
        await controlJson(
          `/sessions/${encodeURIComponent(session)}/${kind}s/${encodeURIComponent(id)}`,
        ),
      );
    },
  });
}

const sessionRetentionCommand = buildCommand({
  ...CONTROL_COMMAND_DEFAULTS,
  docs: { brief: "View or change session envelope retention" },
  parameters: {
    flags: { "max-envelopes": OPTIONAL_MAX_ENVELOPES_FLAG },
    positional: SESSION_REFERENCE_POSITIONAL,
  },
  async *func(
    flags: { readonly "max-envelopes"?: number },
    ...parts: string[]
  ) {
    const path = `/sessions/${encodeURIComponent(singleReference(parts))}/retention`;
    const value = flags["max-envelopes"];
    yield new CommandOutput(
      await controlJson(
        path,
        value === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ maxEnvelopes: value }),
            },
      ),
    );
  },
});

export const daemonRoute = buildRouteMap({
  routes: {
    start: daemonStartCommand,
    status: daemonStatusCommand,
    stop: daemonStopCommand,
    restart: daemonRestartCommand,
  },
  defaultCommand: "status",
  docs: { brief: "Manage the Local control plane" },
});
export const sessionRoute = buildRouteMap({
  routes: {
    create: sessionCreateCommand,
    retention: sessionRetentionCommand,
    list: sessionListCommand,
    view: buildSessionCommand("View a Local telemetry session"),
    close: buildSessionCommand(
      "Close a Local telemetry session",
      "/close",
      "POST",
    ),
    reset: buildSessionCommand(
      "Clear a Local telemetry session",
      "/reset",
      "POST",
    ),
  },
  defaultCommand: "list",
  docs: { brief: "Manage Local telemetry sessions" },
});
export const envelopeRoute = buildRouteMap({
  routes: {
    list: buildSessionCommand(
      "List retained envelopes for a Local session",
      "/envelopes",
    ),
    view: buildTelemetryViewCommand("envelope", "View a raw Local envelope"),
  },
  defaultCommand: "list",
  docs: { brief: "Query Local envelopes" },
});
export const eventRoute = buildRouteMap({
  routes: {
    list: buildSessionCommand(
      "List decoded events for a Local session",
      "/events",
    ),
    view: buildTelemetryViewCommand("event", "View a decoded Local event"),
  },
  defaultCommand: "list",
  docs: { brief: "Query Local decoded events" },
});

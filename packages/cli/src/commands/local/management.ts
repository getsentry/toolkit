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
import { sentry } from "../../lib/app-identity.js";
import {
  CliError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
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
import { AMBIGUOUS_SESSION_CODE, type LocalSession } from "./session-store.js";

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

/**
 * Options for one control-plane request. `notFound` builds the error for an
 * HTTP 404, which the control plane returns for a missing session, event, or
 * envelope; without it a 404 is a generic request failure.
 */
type ControlOptions = {
  host?: string;
  port?: number;
  notFound?: () => CliError | Promise<CliError>;
};

async function controlJson(
  path: string,
  init: RequestInit = {},
  { notFound, ...daemon }: ControlOptions = {},
): Promise<ControlResult> {
  const state = await ensureLocalDaemon(daemon);
  const response = await requestLocalDaemon(state, path, init);
  if (response.status === 404 && notFound) {
    await response.body?.cancel();
    throw await notFound();
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch((error: unknown) => {
      logger.debug("Could not read Local control-plane error details", error);
      return undefined;
    });
    const ambiguous = ambiguousSessionError(body);
    if (ambiguous) {
      throw ambiguous;
    }
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

/**
 * Turn the control plane's ambiguous-name 409 into a user-input error. Session
 * labels may repeat, so a shared label is not a CLI failure (CLI-4T6, CLI-4FP).
 */
function ambiguousSessionError(body: unknown): ResolutionError | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("code" in body) ||
    body.code !== AMBIGUOUS_SESSION_CODE ||
    !("reference" in body) ||
    typeof body.reference !== "string"
  ) {
    return;
  }
  const sessionIds =
    "sessionIds" in body && Array.isArray(body.sessionIds)
      ? body.sessionIds.filter((id): id is string => typeof id === "string")
      : [];
  return new ResolutionError(
    `Local session name "${redactCredentialText(body.reference)}"`,
    "matches more than one session",
    sentry`local session list`,
    sessionIds.map((id) => `Use session ID ${id}`),
  );
}

/** A session reference that matches no session, open or closed, on the daemon. */
function sessionNotFoundError(reference: string): ResolutionError {
  return new ResolutionError(
    `Local session "${reference}"`,
    "not found",
    sentry`local session list`,
    [
      "Closed sessions are kept for three hours, and every session ends when the Local daemon stops",
    ],
  );
}

/**
 * Error for an event or envelope lookup that got a 404. The control plane
 * answers 404 both for a missing session and for a missing ID inside it, so
 * this checks the session first and throws its error when it is the one gone.
 */
async function telemetryNotFoundError(
  kind: "event" | "envelope",
  session: string,
  id: string,
): Promise<ResolutionError> {
  await controlJson(
    `/sessions/${encodeURIComponent(session)}`,
    {},
    { notFound: () => sessionNotFoundError(session) },
  );
  return new ResolutionError(
    `Local ${kind} "${id}"`,
    `not found in session "${session}"`,
    kind === "event"
      ? sentry`local event list ${session}`
      : sentry`local envelope list ${session}`,
    [
      `It may have been evicted when the session reached its envelope limit; raise it with ${sentry`local session retention ${session} --max-envelopes <count>`}`,
    ],
  );
}

function singleReference(parts: string[]): string {
  const reference = parts.join(" ").trim();
  if (!reference) {
    throw new ValidationError(
      "Provide a Local session or envelope ID.",
      "session.id_missing",
    );
  }
  return reference;
}

/** A session that still accepts telemetry, named in `daemon stop` output. */
type CapturingSession = Pick<LocalSession, "id" | "label">;

/**
 * Sessions that still accept telemetry. Stopping the daemon ends them, and
 * their apps keep sending to an address nobody answers. Listing them is best
 * effort, so it never blocks a stop.
 */
async function listCapturingSessions(
  state: LocalDaemonState,
): Promise<CapturingSession[]> {
  try {
    const response = await requestLocalDaemon(state, "/sessions", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      logger.debug(`Could not list Local sessions (HTTP ${response.status})`);
      return [];
    }
    const { sessions = [] } = (await response.json()) as {
      sessions?: LocalSession[];
    };
    return sessions
      .filter((session) => session.state === "open")
      .map(({ id, label }) => ({ id, label }));
  } catch (error) {
    logger.debug("Could not list Local sessions before stopping", error);
    return [];
  }
}

/** Warn that stopping the daemon ended sessions whose apps still send to it. */
function warnCapturingSessions(
  action: "Stopped" | "Restarted",
  sessions: CapturingSession[],
): void {
  if (sessions.length === 0) {
    return;
  }
  const count =
    sessions.length === 1
      ? "1 session was"
      : `${sessions.length} sessions were`;
  const names = sessions.map(({ id, label }) => `${label} (${id})`).join(", ");
  logger.warn(
    `${action} the Local daemon while ${count} still capturing: ${names}. Their apps' telemetry is no longer captured; restart their commands to capture again.`,
  );
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
  exposure: "hidden",
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
  exposure: "hidden",
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
  exposure: "hidden",
  docs: { brief: "Stop the Local control-plane daemon" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: { flags: {} },
  async *func() {
    const state = await getRunningLocalDaemon();
    if (!state) {
      yield new CommandOutput({
        stopped: false,
        reason: "not running",
        capturingSessions: [],
      });
      return;
    }
    const capturingSessions = await listCapturingSessions(state);
    await stopLocalDaemon(state);
    warnCapturingSessions("Stopped", capturingSessions);
    yield new CommandOutput({ stopped: true, capturingSessions });
  },
});

const daemonRestartCommand = buildCommand({
  exposure: "hidden",
  docs: { brief: "Restart the Local control-plane daemon" },
  ...CONTROL_COMMAND_DEFAULTS,
  parameters: { flags: {} },
  async *func() {
    const state = await getRunningLocalDaemon();
    if (state) {
      const capturingSessions = await listCapturingSessions(state);
      await stopLocalDaemon(state);
      warnCapturingSessions("Restarted", capturingSessions);
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
  exposure: "hidden",
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
  exposure: "hidden",
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
    exposure: "hidden",
    ...CONTROL_COMMAND_DEFAULTS,
    docs: { brief },
    parameters: { flags: {}, positional: SESSION_REFERENCE_POSITIONAL },
    async *func(_flags, ...parts: string[]) {
      const reference = singleReference(parts);
      yield new CommandOutput(
        await controlJson(
          `/sessions/${encodeURIComponent(reference)}${suffix}`,
          { method },
          { notFound: () => sessionNotFoundError(reference) },
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
    exposure: "hidden",
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
          {},
          { notFound: () => telemetryNotFoundError(kind, session, id) },
        ),
      );
    },
  });
}

const sessionRetentionCommand = buildCommand({
  exposure: "hidden",
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
    const reference = singleReference(parts);
    const path = `/sessions/${encodeURIComponent(reference)}/retention`;
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
        { notFound: () => sessionNotFoundError(reference) },
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

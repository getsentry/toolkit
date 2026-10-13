/** Local control-plane management and agent query commands. */

import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { CliError, ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { buildRouteMap } from "../../lib/route-map.js";
import {
  ensureLocalDaemon,
  getRunningLocalDaemon,
  requestLocalDaemon,
  runLocalDaemonForeground,
} from "./daemon.js";
import { parsePort } from "./server.js";

type DaemonFlags = {
  readonly foreground: boolean;
  readonly host: string;
  readonly port: number;
};
type SessionFlags = {
  readonly clientId?: string;
  readonly host: string;
  readonly port: number;
};
type ControlResult = Record<string, unknown>;

function publicDaemonState(state: {
  host: string;
  pid: number;
  port: number;
  version: number;
}): ControlResult {
  return {
    host: state.host,
    pid: state.pid,
    port: state.port,
    version: state.version,
  };
}

function formatHuman(data: ControlResult): string {
  return JSON.stringify(data, null, 2);
}

async function controlJson(
  path: string,
  init: RequestInit = {},
  options: { host?: string; port?: number } = {},
): Promise<ControlResult> {
  const state = await ensureLocalDaemon(options);
  const response = await requestLocalDaemon(state, path, init);
  if (!response.ok) {
    throw new CliError(
      `Sentry Local control plane request failed with HTTP ${response.status}.`,
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

const daemonStartCommand = buildCommand({
  docs: { brief: "Start the Local control-plane daemon" },
  output: { human: formatHuman },
  parameters: {
    flags: {
      foreground: {
        kind: "boolean",
        brief: "Run in the foreground",
        default: false,
      },
      host: {
        kind: "parsed",
        parse: String,
        brief: "Loopback host",
        default: "localhost",
      },
      port: {
        kind: "parsed",
        parse: parsePort,
        brief: "Control-plane port",
        default: "8969",
      },
    },
  },
  auth: false,
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
  output: { human: formatHuman },
  parameters: { flags: {} },
  auth: false,
  async *func() {
    const daemon = await getRunningLocalDaemon();
    yield new CommandOutput({
      daemon: daemon ? publicDaemonState(daemon) : null,
    });
  },
});

const daemonStopCommand = buildCommand({
  docs: { brief: "Stop the Local control-plane daemon" },
  output: { human: formatHuman },
  parameters: { flags: {} },
  auth: false,
  async *func() {
    const state = await getRunningLocalDaemon();
    if (!state) {
      yield new CommandOutput({ stopped: false, reason: "not running" });
      return;
    }
    const response = await requestLocalDaemon(state, "/daemon/stop", {
      method: "POST",
    });
    yield new CommandOutput({ stopped: response.ok });
  },
});

const daemonRestartCommand = buildCommand({
  docs: { brief: "Restart the Local control-plane daemon" },
  output: { human: formatHuman },
  parameters: { flags: {} },
  auth: false,
  async *func() {
    const state = await getRunningLocalDaemon();
    if (state) {
      await requestLocalDaemon(state, "/daemon/stop", { method: "POST" });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!(await getRunningLocalDaemon())) break;
        await sleep(125);
      }
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
  output: { human: formatHuman },
  parameters: {
    flags: {
      clientId: {
        kind: "parsed",
        parse: String,
        brief: "Idempotency key for retried agent session creation",
        optional: true,
      },
      host: {
        kind: "parsed",
        parse: String,
        brief: "Loopback host",
        default: "localhost",
      },
      port: {
        kind: "parsed",
        parse: parsePort,
        brief: "Control-plane port",
        default: "8969",
      },
    },
    positional: {
      kind: "array",
      parameter: {
        brief: "Optional session label",
        parse: String,
        placeholder: "name",
      },
    },
  },
  auth: false,
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
  output: { human: formatHuman },
  parameters: { flags: {} },
  auth: false,
  async *func() {
    yield new CommandOutput(await controlJson("/sessions"));
  },
});

const sessionViewCommand = buildCommand({
  docs: { brief: "View a Local telemetry session" },
  output: { human: formatHuman },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Session ID or unique name",
        parse: String,
        placeholder: "session",
      },
    },
  },
  auth: false,
  async *func(_flags, ...parts: string[]) {
    yield new CommandOutput(
      await controlJson(
        `/sessions/${encodeURIComponent(singleReference(parts))}`,
      ),
    );
  },
});

function buildSessionMutationCommand(action: "close" | "reset", brief: string) {
  return buildCommand({
    docs: { brief },
    output: { human: formatHuman },
    parameters: {
      flags: {},
      positional: {
        kind: "array",
        parameter: {
          brief: "Session ID or unique name",
          parse: String,
          placeholder: "session",
        },
      },
    },
    auth: false,
    async *func(_flags, ...parts: string[]) {
      yield new CommandOutput(
        await controlJson(
          `/sessions/${encodeURIComponent(singleReference(parts))}/${action}`,
          { method: "POST" },
        ),
      );
    },
  });
}

const envelopeListCommand = buildCommand({
  docs: { brief: "List retained envelopes for a Local session" },
  output: { human: formatHuman },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Session ID or unique name",
        parse: String,
        placeholder: "session",
      },
    },
  },
  auth: false,
  async *func(_flags, ...parts: string[]) {
    yield new CommandOutput(
      await controlJson(
        `/sessions/${encodeURIComponent(singleReference(parts))}/envelopes`,
      ),
    );
  },
});

const envelopeViewCommand = buildCommand({
  docs: { brief: "View a raw Local envelope" },
  output: { human: formatHuman },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Session and envelope ID",
        parse: String,
        placeholder: "session envelope",
      },
    },
  },
  auth: false,
  async *func(_flags, ...parts: string[]) {
    const [session, envelope] = parts;
    if (!(session && envelope) || parts.length !== 2) {
      throw new ValidationError(
        "Provide a session and envelope ID.",
        "envelope",
      );
    }
    yield new CommandOutput(
      await controlJson(
        `/sessions/${encodeURIComponent(session)}/envelopes/${encodeURIComponent(envelope)}`,
      ),
    );
  },
});

const eventListCommand = buildCommand({
  docs: { brief: "List decoded events for a Local session" },
  output: { human: formatHuman },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Session ID or unique name",
        parse: String,
        placeholder: "session",
      },
    },
  },
  auth: false,
  async *func(_flags, ...parts: string[]) {
    yield new CommandOutput(
      await controlJson(
        `/sessions/${encodeURIComponent(singleReference(parts))}/events`,
      ),
    );
  },
});

const eventViewCommand = buildCommand({
  docs: { brief: "View a decoded Local event" },
  output: { human: formatHuman },
  parameters: {
    flags: {},
    positional: {
      kind: "array",
      parameter: {
        brief: "Session and event ID",
        parse: String,
        placeholder: "session event",
      },
    },
  },
  auth: false,
  async *func(_flags, ...parts: string[]) {
    const [session, event] = parts;
    if (!(session && event) || parts.length !== 2) {
      throw new ValidationError("Provide a session and event ID.", "event");
    }
    yield new CommandOutput(
      await controlJson(
        `/sessions/${encodeURIComponent(session)}/events/${encodeURIComponent(event)}`,
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
    list: sessionListCommand,
    view: sessionViewCommand,
    close: buildSessionMutationCommand(
      "close",
      "Close a Local telemetry session",
    ),
    reset: buildSessionMutationCommand(
      "reset",
      "Clear a Local telemetry session",
    ),
  },
  defaultCommand: "list",
  docs: { brief: "Manage Local telemetry sessions" },
});
export const envelopeRoute = buildRouteMap({
  routes: { list: envelopeListCommand, view: envelopeViewCommand },
  defaultCommand: "list",
  docs: { brief: "Query Local envelopes" },
});
export const eventRoute = buildRouteMap({
  routes: { list: eventListCommand, view: eventViewCommand },
  defaultCommand: "list",
  docs: { brief: "Query Local decoded events" },
});

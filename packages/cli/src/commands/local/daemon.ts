/**
 * Durable discovery state for the singleton Local control-plane daemon.
 *
 * Telemetry never lives here: this file only lets independently invoked CLI
 * processes authenticate to the currently running loopback daemon.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { isSea } from "../../lib/react-native/wrap-call.js";
import { setTimeout as sleep } from "node:timers/promises";
import { getConfigDir } from "../../lib/db/index.js";
import { formatLocalServerUrl } from "./ui.js";
import { logger } from "../../lib/logger.js";
import {
  CONTROL_PLANE_PREFIX,
  createLocalControlPlane,
} from "./control-plane.js";
import { DEFAULT_PORT, isLoopbackHost, tryListen } from "./server.js";

export const LOCAL_DAEMON_STATE_FILENAME = "local-control-plane.json";
export const LOCAL_DAEMON_PROTOCOL_VERSION = 1;
export const LOCAL_DAEMON_IDLE_GRACE_MS = 30_000;

/** Private discovery metadata for the authenticated loopback daemon. */
export type LocalDaemonState = {
  /** Loopback listener host. */
  readonly host: string;
  /** Owning process ID, used for lifecycle checks. */
  readonly pid: number;
  /** Bound TCP port, from 1 through 65535. */
  readonly port: number;
  /** Secret control capability; never include in diagnostics. */
  readonly token: string;
  /** Discovery protocol version. */
  readonly version: number;
};

/** Session identifiers and explicitly returned SDK/viewer capabilities. */
export type LocalDaemonSession = {
  readonly cwd: string;
  readonly id: string;
  readonly ingestUrl: string;
  readonly label: string;
  readonly streamUrl: string;
};

function statePath(directory: string): string {
  return join(directory, LOCAL_DAEMON_STATE_FILENAME);
}

function startupLockPath(directory: string): string {
  return join(directory, "local-control-plane.lock");
}

function shutdownServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Read daemon discovery metadata, treating absent or malformed files as stale. */
export async function readLocalDaemonState(
  directory: string,
): Promise<LocalDaemonState | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(statePath(directory), "utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as LocalDaemonState).host !== "string" ||
      !isLoopbackHost((parsed as LocalDaemonState).host) ||
      !Number.isInteger((parsed as LocalDaemonState).pid) ||
      (parsed as LocalDaemonState).pid <= 0 ||
      !Number.isInteger((parsed as LocalDaemonState).port) ||
      (parsed as LocalDaemonState).port <= 0 ||
      (parsed as LocalDaemonState).port > 65535 ||
      typeof (parsed as LocalDaemonState).token !== "string" ||
      !(parsed as LocalDaemonState).token ||
      typeof (parsed as LocalDaemonState).version !== "number"
    ) {
      return;
    }
    return parsed as LocalDaemonState;
  } catch (error) {
    logger.debug("Could not read Local daemon state", error);
    return;
  }
}

/** Atomically persist the current daemon's discovery state with owner-only access. */
export async function writeLocalDaemonState(
  directory: string,
  state: LocalDaemonState,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = statePath(directory);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600).catch((error: unknown) => {
    logger.debug("Could not protect Local daemon state", error);
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch((error: unknown) => {
    logger.debug("Could not protect Local daemon state", error);
  });
}

/** Remove discovery state after a clean shutdown or stale-daemon recovery. */
export async function removeLocalDaemonState(directory: string): Promise<void> {
  await rm(statePath(directory), { force: true });
}

function daemonBaseUrl(state: LocalDaemonState): string {
  return formatLocalServerUrl(state.host, state.port);
}

async function daemonResponds(state: LocalDaemonState): Promise<boolean> {
  try {
    const response = await requestLocalDaemon(state, "/sessions", {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { sessions?: unknown };
    return Array.isArray(data.sessions);
  } catch (error) {
    logger.debug("Local daemon identity check failed", error);
    return false;
  }
}

/** Arguments for re-executing this CLI as a native binary or Node entrypoint. */
export function buildLocalDaemonArgs(host: string, port: number): string[] {
  const prefix: string[] = [];
  if (!isSea()) {
    const entrypoint = process.argv[1];
    if (!entrypoint) {
      throw new Error(
        "Could not determine the Sentry CLI entrypoint for Local daemon startup.",
      );
    }
    prefix.push(...process.execArgv, entrypoint);
  }
  return [
    ...prefix,
    "local",
    "daemon",
    "start",
    "--foreground",
    "--host",
    host,
    "--port",
    String(port),
  ];
}

/** Hold exclusive daemon ownership until shutdown; recover locks from dead processes. */
async function claimDaemonOwnership(
  directory: string,
): Promise<() => Promise<void>> {
  const path = join(directory, "local-control-plane.owner");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const lock = await open(path, "wx", 0o600);
      try {
        await lock.writeFile(String(process.pid), "utf8");
      } finally {
        await lock.close();
      }
      return async () => {
        const owner = await readFile(path, "utf8").catch((error: unknown) => {
          logger.debug("Could not read Local daemon ownership", error);
          return "";
        });
        if (owner === String(process.pid)) await rm(path, { force: true });
      };
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    const owner = Number(await readFile(path, "utf8"));
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          await rm(path, { force: true });
          continue;
        }
        throw error;
      }
      throw new Error(
        "The Sentry Local control-plane daemon is already running.",
      );
    }
    if (Date.now() - (await stat(path)).mtimeMs > 5000) {
      await rm(path, { force: true });
      continue;
    }
    await sleep(125);
  }
  throw new Error("Timed out waiting for Sentry Local daemon ownership.");
}

/** Return a usable daemon state, removing stale discovery information first. */
export async function getRunningLocalDaemon(): Promise<
  LocalDaemonState | undefined
> {
  const directory = getConfigDir();
  const state = await readLocalDaemonState(directory);
  if (!state) {
    return;
  }
  if (
    state.version !== LOCAL_DAEMON_PROTOCOL_VERSION ||
    !(await daemonResponds(state))
  ) {
    await removeLocalDaemonState(directory);
    return;
  }
  return state;
}

/** Start the daemon child and wait until its authenticated discovery state is available. */
export async function ensureLocalDaemon({
  host = "localhost",
  port = DEFAULT_PORT,
}: {
  host?: string;
  port?: number;
} = {}): Promise<LocalDaemonState> {
  if (!isLoopbackHost(host)) {
    throw new Error("The Local control-plane host must be loopback-only.");
  }
  if (port === 0) {
    throw new Error("The Local control-plane port must be non-zero.");
  }
  const running = await getRunningLocalDaemon();
  if (running) {
    return running;
  }
  const directory = getConfigDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(startupLockPath(directory), "wx", 0o600);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(125);
      const state = await getRunningLocalDaemon();
      if (state) {
        return state;
      }
    }
    await removeLocalDaemonState(directory);
    await rm(startupLockPath(directory), { force: true });
    return ensureLocalDaemon({ host, port });
  }
  try {
    const runningAfterLock = await getRunningLocalDaemon();
    if (runningAfterLock) return runningAfterLock;
    let startupError: Error | undefined;
    const child: ChildProcess = spawn(
      process.execPath,
      buildLocalDaemonArgs(host, port),
      {
        detached: true,
        env: process.env,
        stdio: "ignore",
      },
    );
    child.once("error", (error) => {
      startupError = error;
    });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(125);
      if (startupError) throw startupError;
      const state = await getRunningLocalDaemon();
      if (state) {
        return state;
      }
    }
  } finally {
    await lock.close();
    await rm(startupLockPath(directory), { force: true });
  }
  throw new Error("Timed out while starting the Sentry Local control plane.");
}

/** Run the daemon until an explicit control-plane stop request or process signal arrives. */
export async function runLocalDaemonForeground({
  host = "localhost",
  port = DEFAULT_PORT,
}: {
  host?: string;
  port?: number;
} = {}): Promise<void> {
  if (!isLoopbackHost(host)) {
    throw new Error("The Local control-plane host must be loopback-only.");
  }
  if (port === 0) {
    throw new Error("The Local control-plane port must be non-zero.");
  }
  const directory = getConfigDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const releaseOwnership = await claimDaemonOwnership(directory);
  let listening: Awaited<ReturnType<typeof tryListen>> | undefined;
  let ownedState: LocalDaemonState | undefined;
  try {
    const token = randomBytes(32).toString("base64url");
    let stop: (() => void) | undefined;
    const stopRequested = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const controlPlane = createLocalControlPlane({
      controlToken: token,
      host,
      port,
      onStop: () => stop?.(),
    });
    listening = await tryListen(controlPlane.app, port, host);
    const state: LocalDaemonState = {
      host,
      pid: process.pid,
      port: listening.port,
      token,
      version: LOCAL_DAEMON_PROTOCOL_VERSION,
    };
    ownedState = state;
    await writeLocalDaemonState(directory, state);

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const pruneSessions = () => {
      controlPlane.sessionStore.pruneExpired();
      if (controlPlane.sessionStore.list().length > 0) {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        return;
      }
      idleTimer ??= setTimeout(() => {
        if (controlPlane.sessionStore.list().length === 0) {
          stop?.();
        }
      }, LOCAL_DAEMON_IDLE_GRACE_MS);
    };
    const pruneTimer = setInterval(pruneSessions, 60_000);
    pruneSessions();

    const onSignal = () => stop?.();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await stopRequested;
    } finally {
      clearInterval(pruneTimer);
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } finally {
    try {
      if (listening) await shutdownServer(listening.server);
      const current = await readLocalDaemonState(directory);
      if (
        current &&
        ownedState &&
        current.pid === ownedState.pid &&
        current.token === ownedState.token
      ) {
        await removeLocalDaemonState(directory);
      }
    } finally {
      await releaseOwnership();
    }
  }
}

/** Call an authenticated Local daemon endpoint. */
export function requestLocalDaemon(
  state: LocalDaemonState,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${state.token}`);
  return fetch(`${daemonBaseUrl(state)}${CONTROL_PLANE_PREFIX}${path}`, {
    ...init,
    headers,
  });
}

/** Create a session and return its separate ingestion and read capabilities. */
export async function createLocalDaemonSession({
  clientId,
  cwd,
  host,
  label,
  port,
}: {
  readonly clientId?: string;
  readonly cwd: string;
  readonly host?: string;
  readonly label: string;
  readonly port?: number;
}): Promise<LocalDaemonSession> {
  const state = await ensureLocalDaemon({ host, port });
  const response = await requestLocalDaemon(state, "/sessions", {
    body: JSON.stringify({ clientId, cwd, label }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Could not create Local session (HTTP ${response.status}).`,
    );
  }
  return (await response.json()) as LocalDaemonSession;
}

/** Release a foreground session lease while retaining telemetry for queries. */
export async function retainLocalDaemonSession(
  sessionId: string,
): Promise<void> {
  const state = await getRunningLocalDaemon();
  if (!state) {
    return;
  }
  await requestLocalDaemon(
    state,
    `/sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: "POST",
    },
  );
}

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
import { ensureConfigDir, getConfigDir } from "../../lib/db/index.js";
import { formatLocalServerUrl } from "./ui.js";
import { CliError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import {
  CONTROL_PLANE_PREFIX,
  createLocalControlPlane,
} from "./control-plane.js";
import {
  DEFAULT_PORT,
  isLoopbackHost,
  PORT_RETRY_TIMEOUT_MS,
  probeLocalHealth,
  tryListen,
} from "./server.js";
import {
  removeLocalSessionSnapshot,
  writeLocalSessionSnapshot,
} from "./session-snapshot.js";
import { createLocalSessionStore, type LocalSession } from "./session-store.js";

export const LOCAL_DAEMON_STATE_FILENAME = "local-control-plane.json";
export const LOCAL_DAEMON_PROTOCOL_VERSION = 1;
export const LOCAL_DAEMON_IDLE_GRACE_MS = 30_000;
/** Pause before a refused connection is probed again, outlasting a shutdown. */
const STALE_DAEMON_RECHECK_MS = 250;
/** Listener retries plus time for CLI bootstrap and discovery persistence. */
const LOCAL_DAEMON_START_TIMEOUT_MS = PORT_RETRY_TIMEOUT_MS + 5_000;

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
  /** Older daemon versions do not advertise browser discovery. */
  readonly directoryUrl?: string;
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

/**
 * Probe the recorded daemon: `ok` when it proves its identity, `refused` when
 * nothing listens at its address, and `failed` for another protocol version,
 * a timeout, or any other answer, which a busy daemon can also give.
 */
async function probeLocalDaemon(
  state: LocalDaemonState,
): Promise<"ok" | "refused" | "failed"> {
  if (state.version !== LOCAL_DAEMON_PROTOCOL_VERSION) return "failed";
  try {
    const response = await requestLocalDaemon(state, "/sessions", {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return "failed";
    const data = (await response.json()) as { sessions?: unknown };
    return Array.isArray(data.sessions) ? "ok" : "failed";
  } catch (error) {
    logger.debug("Local daemon identity check failed", error);
    const cause = error instanceof Error ? error.cause : undefined;
    return cause instanceof Error &&
      "code" in cause &&
      cause.code === "ECONNREFUSED"
      ? "refused"
      : "failed";
  }
}

/** Whether two discovery snapshots name the same daemon instance. */
function isSameDaemonState(a: LocalDaemonState, b: LocalDaemonState): boolean {
  return (
    a.pid === b.pid &&
    a.token === b.token &&
    a.host === b.host &&
    a.port === b.port &&
    a.version === b.version
  );
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

/** Serialize ownership creation, stale recovery and release across processes. */
async function withDaemonOwnershipGuard<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  const path = join(directory, "local-control-plane.owner.guard");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let guard: Awaited<ReturnType<typeof open>>;
    try {
      guard = await open(path, "wx", 0o600);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      const pid = await readOwnerPid(path);
      if (Number.isInteger(pid) && pid > 0 && !isProcessRunning(pid)) {
        // Automatic unlink could erase a replacement guard. An interrupted
        // short critical section requires explicit cleanup, not stale recovery.
        throw new Error(
          `Local daemon ownership arbitration was interrupted. After confirming its process has stopped, remove ${path} and retry.`,
        );
      }
      await sleep(125);
      continue;
    }
    try {
      await guard.writeFile(String(process.pid), "utf8");
      return await action();
    } finally {
      await guard.close();
      await rm(path, { force: true });
    }
  }
  throw new Error(
    "Timed out waiting for Local daemon ownership arbitration; active ownership has been preserved.",
  );
}

/** Hold exclusive daemon ownership until shutdown; recover locks from dead processes. */
export async function claimDaemonOwnership(
  directory: string,
): Promise<() => Promise<void>> {
  const path = join(directory, "local-control-plane.owner");
  const tryClaim = async () => {
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(path, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return undefined;
      throw error;
    }
    try {
      await lock.writeFile(String(process.pid), "utf8");
    } finally {
      await lock.close();
    }
    return () =>
      withDaemonOwnershipGuard(directory, async () => {
        if ((await readOwnerPid(path)) === process.pid)
          await rm(path, { force: true });
      });
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const release = await withDaemonOwnershipGuard(directory, async () => {
      const claimed = await tryClaim();
      if (claimed) return claimed;
      try {
        const ownerText = await readFile(path, "utf8");
        const owner = Number(ownerText);
        const snapshot = await stat(path);
        const validPid = Number.isInteger(owner) && owner > 0;
        if (validPid && isProcessRunning(owner)) {
          throw new Error(
            "The Sentry Local control-plane daemon is already running.",
          );
        }
        if (validPid || Date.now() - snapshot.mtimeMs > 5000) {
          const currentText = await readFile(path, "utf8");
          const current = await stat(path);
          if (
            currentText === ownerText &&
            current.ino === snapshot.ino &&
            current.dev === snapshot.dev &&
            current.mtimeMs === snapshot.mtimeMs &&
            (!validPid || !isProcessRunning(owner))
          ) {
            await rm(path, { force: true });
            // Claim while the guard is still held, even on the final recovery attempt.
            return await tryClaim();
          }
        }
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        return await tryClaim();
      }
      return undefined;
    });
    if (release) return release;
    await sleep(125);
  }
  throw new Error("Timed out waiting for Sentry Local daemon ownership.");
}

/** A failed probe is not proof that a live process has relinquished ownership. */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    logger.debug(
      "Could not verify Local daemon process; preserving its discovery",
      error,
    );
    return true;
  }
}

/** Read a lock's owning PID without interpreting an absent file as ownership. */
async function readOwnerPid(path: string): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT") return 0;
        // Windows may briefly deny reads while the previous owner removes its
        // file. Retry without interpreting an unreadable owner as absent.
        if (error.code === "EPERM" && attempt < 4) {
          await sleep(125);
          continue;
        }
      }
      logger.debug("Could not read Local startup ownership", error);
      throw error;
    }
  }
}

/**
 * Whether a probe proves that no daemon serves the recorded address: the
 * connection was refused, or a server that is not a Local daemon answers
 * there, such as a foreground `sentry local serve`. A timeout does not.
 */
async function isStaleProbe(
  state: LocalDaemonState,
  probe: "ok" | "refused" | "failed",
): Promise<boolean> {
  if (probe === "refused") return true;
  return (
    probe === "failed" &&
    (await probeLocalHealth(daemonBaseUrl(state), 500)) === "other"
  );
}

/**
 * Whether discovery whose PID is alive but whose address no daemon serves is
 * stale, as after an unclean exit, PID reuse, or a shutdown in progress;
 * clears it when it is.
 *
 * A daemon writes discovery only after it listens, and closes its listener
 * just before it removes discovery. So a stale probe that persists after a
 * pause, while discovery stays unchanged, means no daemon serves it. Under the
 * ownership guard, discovery is removed only when no other live owner could
 * be replacing it. The owner lock goes too when it belongs to the same stale
 * daemon: the same PID, and written no later than discovery. A newer lock
 * with that PID is a daemon starting up.
 *
 * Returns `released` when callers should treat the daemon as not running,
 * `ok` when the recheck reached the daemon, and `kept` otherwise.
 */
async function releaseStaleLocalDaemon(
  directory: string,
  state: LocalDaemonState,
): Promise<"released" | "ok" | "kept"> {
  await sleep(STALE_DAEMON_RECHECK_MS);
  const recheck = await probeLocalDaemon(state);
  if (recheck === "ok") return "ok";
  if (!(await isStaleProbe(state, recheck))) return "kept";
  return await withDaemonOwnershipGuard(directory, async () => {
    const current = await readLocalDaemonState(directory);
    if (!current) return "released";
    if (!isSameDaemonState(current, state)) return "kept";
    const ownerPath = join(directory, "local-control-plane.owner");
    const owner = await readOwnerPid(ownerPath);
    if (owner === state.pid) {
      let stateFile: Awaited<ReturnType<typeof stat>>;
      try {
        stateFile = await stat(statePath(directory));
      } catch (error) {
        // A daemon shutting down removes discovery outside the guard.
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return "released";
        throw error;
      }
      // Owner locks and discovery change only under the guard (a shutdown
      // only removes discovery), so both still belong to this daemon.
      const ownerFile = await stat(ownerPath);
      if (ownerFile.mtimeMs > stateFile.mtimeMs) return "released";
      await rm(ownerPath, { force: true });
    } else if (isProcessRunning(owner)) {
      return "released";
    }
    await removeLocalDaemonState(directory);
    return "released";
  });
}

/**
 * Find the running daemon. Discovery stays in place for a live process that
 * may be busy; it is cleared only when it is proven stale.
 */
async function discoverLocalDaemon(
  waitForResponse = false,
): Promise<LocalDaemonState | undefined> {
  const directory = getConfigDir();
  const state = await readLocalDaemonState(directory);
  if (!state) return;
  const probe = await probeLocalDaemon(state);
  // A startup or shutdown can replace/remove metadata while the probe is in
  // flight. Rediscover changed state and never unlink based on a stale snapshot.
  const current = await readLocalDaemonState(directory);
  if (!current) return;
  if (!isSameDaemonState(current, state)) {
    return await discoverLocalDaemon(waitForResponse);
  }
  if (probe === "ok") return state;
  if (!isProcessRunning(state.pid)) return;
  const outcome = (await isStaleProbe(state, probe))
    ? await releaseStaleLocalDaemon(directory, state)
    : "kept";
  if (outcome === "released") return;
  // A daemon can replace discovery during the health check or stale recheck.
  const latest = await readLocalDaemonState(directory);
  if (!latest) return;
  if (!isSameDaemonState(latest, state))
    return await discoverLocalDaemon(waitForResponse);
  if (outcome === "ok") return state;
  if (waitForResponse && state.version === LOCAL_DAEMON_PROTOCOL_VERSION)
    return;
  throw new CliError(
    `The Local daemon (PID ${state.pid}) is still running but did not respond at ${daemonBaseUrl(state)}. If it is busy, retry in a moment. If you have checked that PID ${state.pid} is not a Sentry Local daemon, delete ${statePath(directory)} and ${join(directory, "local-control-plane.owner")}, then retry.`,
  );
}

/** Return authenticated discovery, preserving unreachable live owners for retries. */
export async function getRunningLocalDaemon(): Promise<
  LocalDaemonState | undefined
> {
  return await discoverLocalDaemon();
}

/** Wait for the stopped daemon to relinquish state and ownership, even while its PID lives. */
export async function waitForLocalDaemonShutdown(
  state: LocalDaemonState,
): Promise<void> {
  const directory = getConfigDir();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await readLocalDaemonState(directory);
    const owner = await readOwnerPid(
      join(directory, "local-control-plane.owner"),
    );
    const ownsState =
      current?.pid === state.pid && current.token === state.token;
    if ((!ownsState && owner !== state.pid) || !isProcessRunning(state.pid))
      return;
    await sleep(125);
  }
  throw new Error(
    "Timed out waiting for the Local daemon to stop. Its discovery state has been preserved.",
  );
}

/** Wait through the listener's complete retry window without erasing live state. */
async function waitForLocalDaemon(
  deadline: number,
  startupError?: () => Error | undefined,
): Promise<LocalDaemonState | undefined> {
  while (Date.now() < deadline) {
    await sleep(125);
    const state = await discoverLocalDaemon(true);
    if (state) return state;
    const error = startupError?.();
    if (error) {
      const owner = await readOwnerPid(
        join(getConfigDir(), "local-control-plane.owner"),
      );
      // A foreground owner can win after our spawn decision but still be binding.
      if (!isProcessRunning(owner)) throw error;
    }
  }
}

/** Start the daemon child and wait until its authenticated discovery state is available. */
export async function ensureLocalDaemon({
  host = "localhost",
  port = DEFAULT_PORT,
}: { host?: string; port?: number } = {}): Promise<LocalDaemonState> {
  if (!isLoopbackHost(host))
    throw new Error("The Local control-plane host must be loopback-only.");
  if (port === 0)
    throw new Error("The Local control-plane port must be non-zero.");
  const running = await getRunningLocalDaemon();
  if (running) return running;
  const directory = ensureConfigDir();
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(startupLockPath(directory), "wx", 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    const state = await waitForLocalDaemon(
      Date.now() + LOCAL_DAEMON_START_TIMEOUT_MS,
    );
    if (state) return state;
    const starter = await readOwnerPid(startupLockPath(directory));
    const owner = await readOwnerPid(
      join(directory, "local-control-plane.owner"),
    );
    if (isProcessRunning(starter) || isProcessRunning(owner)) {
      throw new Error(
        "Local daemon startup is still in progress. Retry the command; the active startup lock has been preserved.",
      );
    }
    await rm(startupLockPath(directory), { force: true });
    return await ensureLocalDaemon({ host, port });
  }
  let child: ChildProcess | undefined;
  let ready = false;
  try {
    await lock.writeFile(String(process.pid), "utf8");
    const runningAfterLock = await getRunningLocalDaemon();
    if (runningAfterLock) {
      ready = true;
      return runningAfterLock;
    }
    let startupError: Error | undefined;
    const owner = await readOwnerPid(
      join(directory, "local-control-plane.owner"),
    );
    if (!isProcessRunning(owner)) {
      child = spawn(process.execPath, buildLocalDaemonArgs(host, port), {
        detached: true,
        env: process.env,
        stdio: "ignore",
      });
      child.once("error", (error) => {
        startupError = error;
      });
      child.once("exit", (code, signal) => {
        startupError = new Error(
          `Local daemon exited before startup (status ${code ?? signal}). Check that the requested port is available.`,
        );
      });
      child.unref();
    }

    const state = await waitForLocalDaemon(
      Date.now() + LOCAL_DAEMON_START_TIMEOUT_MS,
      () => startupError,
    );
    if (state) {
      ready = true;
      return state;
    }
    throw new Error("Timed out while starting the Sentry Local control plane.");
  } finally {
    if (!ready) child?.kill("SIGTERM");
    await lock.close();
    if ((await readOwnerPid(startupLockPath(directory))) === process.pid) {
      await rm(startupLockPath(directory), { force: true });
    }
  }
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
  const directory = ensureConfigDir();
  const releaseOwnership = await claimDaemonOwnership(directory);
  let listening: Awaited<ReturnType<typeof tryListen>> | undefined;
  let ownedState: LocalDaemonState | undefined;
  const snapshotSessions = (sessions: readonly LocalSession[]) => {
    try {
      writeLocalSessionSnapshot(process.pid, sessions);
    } catch (error) {
      logger.debug("Could not write the Local session snapshot", error);
    }
  };
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
      // For shell completion, which cannot ask the daemon
      sessionStore: createLocalSessionStore({ onChange: snapshotSessions }),
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
    // Under the guard, so stale-daemon recovery never sees this discovery
    // appear between its checks and deletes it.
    await withDaemonOwnershipGuard(directory, () =>
      writeLocalDaemonState(directory, state),
    );
    // Replaces the sessions of a daemon that exited without removing them
    snapshotSessions(controlPlane.sessionStore.list());

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
      if (ownedState) {
        try {
          removeLocalSessionSnapshot();
        } catch (error) {
          logger.debug("Could not remove the Local session snapshot", error);
        }
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
  maxEnvelopes,
}: {
  readonly clientId?: string;
  readonly maxEnvelopes?: number;
  readonly cwd: string;
  readonly host?: string;
  readonly label: string;
  readonly port?: number;
}): Promise<LocalDaemonSession> {
  const state = await ensureLocalDaemon({ host, port });
  const response = await requestLocalDaemon(state, "/sessions", {
    body: JSON.stringify({ clientId, cwd, label, maxEnvelopes }),
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

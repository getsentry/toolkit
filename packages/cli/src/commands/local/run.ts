/**
 * sentry local run
 *
 * Run a command with the local dev server enabled. Injects
 * `SENTRY_SPOTLIGHT` (read by the Node.js and Python SDKs) plus the
 * framework-prefixed client variants (`NEXT_PUBLIC_SENTRY_SPOTLIGHT`,
 * `VITE_SENTRY_SPOTLIGHT`, etc.) so the spotlight URL also reaches
 * browser bundles. Browser SDKs do not read those variants yet; the app
 * passes the URL to `spotlightBrowserIntegration` itself.
 *
 * If no server is already running on the target port, one is started
 * automatically in the background and shut down when the child exits.
 * If one is already running, this command attaches to it as an SSE consumer
 * so events still tail to the terminal.
 */

import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Server } from "node:http";
import { basename, resolve } from "node:path";
import type { Hono } from "hono";
import type { SentryContext } from "../../context.js";
import { sentry } from "../../lib/app-identity.js";
import { terminalSignalsProcess } from "../../lib/child-signals.js";
import { buildCommand } from "../../lib/command.js";
import {
  choiceParser,
  parseBindHost,
  parseText,
  textParser,
} from "../../lib/completion-target.js";
import { redactCredentialText } from "../../lib/credential-redaction.js";
import { detectDevCommand } from "../../lib/dev-script.js";
import {
  CliError,
  EXIT,
  PORT_HELD_BY_DAEMON_FIELD,
  PORT_IN_USE_FIELD,
  signalExitCode,
  ValidationError,
  VerifyFailedError,
} from "../../lib/errors.js";
import { bold } from "../../lib/formatters/colors.js";
import {
  FILTER_VALUES,
  type FilterValue,
  FORMAT_VALUES,
  formatEnvelopeLines,
  formatEnvelopeLinesJson,
  type FormatValue,
  printLocalViewerHint,
} from "../../lib/formatters/local.js";
import { logger, printJsonLine, printLine } from "../../lib/logger.js";
import { spawnFailureError } from "../../lib/spawn-failure.js";
import { spawnUserCommand, windowsEnvKey } from "../../lib/windows-spawn.js";
import {
  injectWranglerSpotlightBinding,
  wranglerInjectedMessage,
  wranglerSetupHint,
} from "../../lib/wrangler.js";
import {
  createLocalDaemonSession,
  retainLocalDaemonSession,
} from "./daemon.js";
import {
  buildApp,
  consumeSSE,
  DEFAULT_PORT,
  isLoopbackHost,
  isServerRunning,
  configureExistingRetention,
  parseFilter,
  parseFormat,
  parsePort,
  tryListen,
} from "./server.js";
import {
  formatLocalServerUrl,
  openLocalUiIfRequested,
  validateOpenHost,
} from "./ui.js";

import {
  createLocalRetentionBuffer,
  OPTIONAL_MAX_ENVELOPES_FLAG,
} from "./retention-buffer.js";

type RunFlags = {
  /** Omitted unless the user passed `--port`; plain runs then use {@link DEFAULT_PORT}. */
  readonly port?: number;
  readonly host: string;
  readonly verify: boolean;
  readonly timeout: number;
  readonly filter?: readonly FilterValue[];
  readonly format: FormatValue;
  readonly attributes: boolean;
  readonly open: boolean;
  readonly session?: string;
  readonly "max-envelopes"?: number;
};

/**
 * Client-side env var prefixes that frameworks inline into browser bundles
 * at build time. We inject `<PREFIX>SENTRY_SPOTLIGHT` for every variant so the
 * spotlight URL reaches whichever bundler the user's app uses.
 *
 * Mirrors the prefixes the Sentry browser SDK is intended to read for
 * Spotlight configuration (see getsentry/sentry-javascript#18198). Note this
 * set differs from the DSN-detection prefixes in `src/lib/dsn/env.ts`: it adds
 * `PUBLIC_` (SvelteKit/Astro/Qwik), `VUE_APP_` (Vue CLI), and `GATSBY_`
 * (Gatsby), and omits `EXPO_PUBLIC_` (React Native has no browser bundle).
 */
export const CLIENT_SPOTLIGHT_PREFIXES = [
  "PUBLIC_", // SvelteKit, Astro, Qwik
  "NEXT_PUBLIC_", // Next.js
  "VITE_", // Vite
  "NUXT_PUBLIC_", // Nuxt
  "REACT_APP_", // Create React App
  "VUE_APP_", // Vue CLI
  "GATSBY_", // Gatsby
] as const;

/**
 * Shut down a background server, closing all connections so keep-alive
 * sockets (e.g. SSE subscribers) don't block exit.
 */
export function shutdownServer(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    server.close(() => done());
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}

/** Parse a timeout value, ensuring it's a non-negative integer. */
function parseTimeout(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(
      `Invalid timeout: ${value}. Must be a non-negative number.`,
      "timeout",
    );
  }
  return n;
}

/**
 * Whether the detected command originated from a package.json script.
 * Used to decide if `./node_modules/.bin` should be prepended to PATH.
 */
function isPackageJsonSource(source: string): boolean {
  return source.startsWith("package.json");
}

/**
 * A live event tail for the duration of the child process, plus the teardown
 * to run once it exits. Produced either by {@link startBackgroundServer} (we
 * own the server) or {@link attachToExistingServer} (someone else does).
 */
type EventTail = {
  url: string;
  cleanup: () => Promise<void>;
};

type EventTailOptions = {
  port: number;
  /**
   * Capture on a free port when the daemon holds `port`. Only for the default
   * port: a `--port` the user chose stays an error.
   */
  freePortIfDaemon?: boolean;
  host: string;
  activeFilters: ReadonlySet<FilterValue>;
  useJson: boolean;
  showAttributes: boolean;
  maxEnvelopes?: number;
};

/** Keep stdout exclusively for NDJSON when an agent requests JSON output. */
function childStdio(useJson: boolean): StdioOptions {
  return useJson ? ["inherit", "pipe", "pipe"] : "inherit";
}

/** Forward the wrapped app's console output without contaminating NDJSON. */
function forwardChildOutput(child: ChildProcess, useJson: boolean): void {
  if (!useJson) {
    return;
  }
  child.stdout?.pipe(process.stderr, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
}

/**
 * Tail events from a server this command did not start.
 *
 * Something else already owns the port — most often the Spotlight desktop
 * app's own sidecar, or a `sentry local serve` in another terminal. Without
 * this, `run` stayed completely silent for the whole session: envelopes
 * reached the other server, but nothing was ever printed here. Attaching as
 * an SSE consumer is what `sentry local serve` does in the same situation.
 */
function attachToExistingServer({
  activeFilters,
  showAttributes,
  streamUrl,
  url,
  useJson,
}: {
  activeFilters: ReadonlySet<FilterValue>;
  showAttributes: boolean;
  streamUrl?: string;
  url: string;
  useJson: boolean;
}): EventTail {
  const ac = new AbortController();
  const tail = consumeSSE({
    url,
    streamUrl,
    activeFilters,
    signal: ac.signal,
    useJson,
    showAttributes,
  }).catch((err: unknown) => {
    if (!ac.signal.aborted) {
      logger.debug(
        `Event tail stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return {
    url,
    cleanup: async () => {
      ac.abort();
      await tail;
    },
  };
}

/**
 * Start a background dev server and subscribe to its buffer so incoming
 * envelopes are printed inline, matching the behavior of `sentry local serve`.
 */
async function startBackgroundServer({
  port,
  host,
  activeFilters,
  useJson,
  showAttributes,
  maxEnvelopes,
}: EventTailOptions): Promise<EventTail> {
  const retention = createLocalRetentionBuffer(maxEnvelopes);
  const buffer = retention.buffer;
  const app = buildApp(buffer, { uiActions: isLoopbackHost(host), retention });
  const { server, port: boundPort } = await tryListen(app, port, host);
  const url = formatLocalServerUrl(host, boundPort);

  const subscriptionId = buffer.subscribe((container) => {
    try {
      const formatLines = useJson
        ? formatEnvelopeLinesJson(container, activeFilters, showAttributes)
        : formatEnvelopeLines(container, activeFilters, showAttributes);
      for (const line of formatLines) {
        if (useJson) {
          printJsonLine(line);
        } else {
          printLine(line);
        }
      }
    } catch (err) {
      logger.debug(
        `Failed to format envelope: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return {
    url,
    cleanup: async () => {
      buffer.unsubscribe(subscriptionId);
      logger.info("Stopping background server...");
      await shutdownServer(server);
    },
  };
}

/**
 * Say that this run listens on `boundPort` because `defaultPort` is taken.
 * An SDK that hard-codes the default port sends there instead, and the
 * daemon drops traffic that isn't for a session without a word, so the
 * notice says to use SENTRY_SPOTLIGHT.
 *
 * @param reason - Why the default port is taken, e.g. "is in use"
 */
function freePortNotice(
  defaultPort: number,
  boundPort: number,
  reason: string,
): string {
  return `Port ${defaultPort} ${reason}, so this run listens on port ${boundPort} instead. SDKs that hard-code ${defaultPort} won't reach it; make sure they read SENTRY_SPOTLIGHT.`;
}

/**
 * Get a live event tail on `host:port`, whichever way is available.
 *
 * Prefers attaching to whatever already holds the port so we never compete
 * with it, and falls back to attaching if the bind loses a race. `run` wraps
 * the user's dev command, so a busy port must never be fatal here.
 */
async function openEventTail({
  port,
  freePortIfDaemon = false,
  host,
  activeFilters,
  useJson,
  showAttributes,
  maxEnvelopes,
}: EventTailOptions): Promise<EventTail> {
  const url = formatLocalServerUrl(host, port);

  let running = false;
  let heldByDaemon = false;
  try {
    running = await isServerRunning(url);
  } catch (err) {
    if (
      !(
        freePortIfDaemon &&
        err instanceof ValidationError &&
        err.field === PORT_HELD_BY_DAEMON_FIELD
      )
    ) {
      throw err;
    }
    // The daemon's receiver only takes session traffic, and it stays up while
    // it retains sessions, so a plain run gets its own receiver instead.
    heldByDaemon = true;
  }

  if (running) {
    await configureExistingRetention(url, maxEnvelopes);
    logger.info(`Connected to existing server at ${bold(url)}`);
    return attachToExistingServer({
      activeFilters,
      showAttributes,
      url,
      useJson,
    });
  }

  if (!heldByDaemon) {
    logger.info("No server detected, starting one in the background...");
  }
  try {
    const bg = await startBackgroundServer({
      maxEnvelopes,
      port: heldByDaemon ? 0 : port,
      host,
      activeFilters,
      useJson,
      showAttributes,
    });
    if (heldByDaemon) {
      logger.info(
        `${freePortNotice(port, Number(new URL(bg.url).port), "is held by the Local daemon")} Add --session <name> to capture into the daemon instead.`,
      );
    }
    logger.info(`Background server listening on ${bold(bg.url)}`);
    return bg;
  } catch (err) {
    if (!(err instanceof ValidationError && err.field === PORT_IN_USE_FIELD)) {
      throw err;
    }
    await configureExistingRetention(url, maxEnvelopes);
    // Something grabbed the port between the probe and the bind.
    logger.warn(`Port ${port} is in use; attaching to it instead`);
    return attachToExistingServer({
      activeFilters,
      showAttributes,
      url,
      useJson,
    });
  }
}

/**
 * Augment PATH with `./node_modules/.bin` for Node project scripts.
 *
 * On Windows the variable is usually spelled `Path`, and names are
 * case-insensitive: prepend to the key the child would read and drop the
 * other spellings, so it never gets a PATH holding only `node_modules/.bin`.
 */
export function augmentPathForNode(
  env: Record<string, string | undefined>,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const binDir = resolve(cwd, "node_modules", ".bin");
  if (platform !== "win32") {
    return { ...env, PATH: env.PATH ? `${binDir}:${env.PATH}` : binDir };
  }
  const key = windowsEnvKey(env, "PATH") ?? "PATH";
  const current = env[key];
  const augmented = Object.fromEntries(
    Object.entries(env).filter(([k]) => k.toUpperCase() !== "PATH"),
  );
  augmented[key] = current ? `${binDir};${current}` : binDir;
  return augmented;
}

/** The error shown when no command was given and none was detected. */
function autoDetectErrorMessage(): string {
  return [
    "No command provided and could not auto-detect a dev script.",
    `Usage: ${sentry`local run -- <command>`}`,
    "",
    "Supported auto-detection:",
    "  - package.json (scripts: dev, develop, serve, start)",
    "  - manage.py (Django)",
    "  - a FastAPI app in app.py / main.py (uvicorn)",
    "  - a Flask app in app.py / main.py / wsgi.py (flask run)",
    "  - app.py / main.py (Python script)",
    "  - FLASK_APP in a Python project (flask run)",
    "  - go.mod (Go)",
    "  - docker-compose.yml / compose.yml (Docker Compose)",
    "",
    "Python commands use the project's .venv or venv interpreter when present.",
  ].join("\n");
}

/** Build the env vars for the child process. */
function buildChildEnv(
  spotlightUrl: string,
  commandSource: string,
  cwd: string,
): Record<string, string | undefined> {
  const clientSpotlightVars = Object.fromEntries(
    CLIENT_SPOTLIGHT_PREFIXES.map((prefix) => [
      `${prefix}SENTRY_SPOTLIGHT`,
      spotlightUrl,
    ]),
  );
  let env: Record<string, string | undefined> = {
    ...process.env,
    ...clientSpotlightVars,
    SENTRY_SPOTLIGHT: spotlightUrl,
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1",
    SENTRY_RELEASE: process.env.SENTRY_RELEASE ?? "sentry-cli-local",
  };
  if (isPackageJsonSource(commandSource)) {
    env = augmentPathForNode(env, cwd);
  }
  return env;
}

/** Resolve args and source — auto-detect from filesystem when no args provided. */
async function resolveArgs(
  stripped: string[],
  cwd: string,
): Promise<{ args: string[]; commandSource: string }> {
  if (stripped.length > 0) {
    return { args: stripped, commandSource: "" };
  }
  const detected = await detectDevCommand(cwd);
  if (!detected) {
    throw new ValidationError(autoDetectErrorMessage(), "command.missing");
  }
  logger.info(`Detected ${detected.source}: ${detected.args.join(" ")}`);
  if (detected.hint) {
    logger.warn(detected.hint);
  }
  return { args: detected.args, commandSource: detected.source };
}

export const runCommand = buildCommand({
  docs: {
    brief: "Run a command with the local dev server enabled",
    fullDescription:
      "Run a command with the SENTRY_SPOTLIGHT environment variable set\n" +
      "to the local server's URL.\n\n" +
      "If no server is already listening on the port, one is started\n" +
      "automatically and shut down when the child process exits.\n\n" +
      "The child process inherits all current env vars plus\n" +
      "SENTRY_SPOTLIGHT, the same URL under framework client prefixes\n" +
      "(NEXT_PUBLIC_, VITE_, etc.), and SENTRY_TRACES_SAMPLE_RATE=1.\n\n" +
      "What your SDK needs:\n" +
      "  - Node.js and Python servers read SENTRY_SPOTLIGHT on their own.\n" +
      "  - Browser SDKs ignore the prefixed variables. Add\n" +
      "    spotlightBrowserIntegration({ sidecarUrl: <the variable> }).\n" +
      "  - Cloudflare Workers (wrangler dev) need\n" +
      "    tunnel: env.SENTRY_SPOTLIGHT and a DSN (a placeholder works).\n" +
      "  - Without a DSN, browser replays are dropped and browser-to-server\n" +
      "    traces do not link. Python also drops logs buffered at exit.\n" +
      "  - The Next.js edge runtime sends no messages or logs here; its\n" +
      "    errors still arrive through the Node.js server.\n\n" +
      "Use --format json to stream versioned NDJSON observations to stdout\n" +
      "for agents. Use --open to launch the Sentry Local UI.",
    examples: [
      {
        description: "Run a Node.js dev server with the local server enabled",
        run: "local run -- npm run dev",
      },
      {
        description: "Run a Django dev server with the local server enabled",
        run: "local run -- python manage.py runserver",
      },
      {
        description:
          "Capture into a daemon session, inspect it after the app exits, then clean up",
        run: [
          "local run --session web -- npm run dev",
          "local session list --json",
          "local session view web --json",
          "local session retention web --max-envelopes 2000",
          "local event list web --json",
          "local event view web <event-id> --json",
          "local envelope list web --json",
          "local envelope view web <envelope-id> --json",
          "local session reset web",
          "local session close web",
          "local daemon status",
          "local daemon stop",
        ],
      },
      {
        description: "Run your app and open the Sentry Local UI",
        run: "local run --open -- npm run dev",
      },
      {
        description:
          "Stream agent-relevant NDJSON without SDK housekeeping envelopes",
        run: "local run --format json -f error -f transaction -f log -f ai -- npm run dev",
      },
    ],
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Command to run",
        parse: parseText,
        placeholder: "command",
      },
    },
    flags: {
      port: {
        kind: "parsed",
        parse: textParser(parsePort),
        brief: `Port for the local server (default: ${DEFAULT_PORT})`,
        optional: true,
      },
      host: {
        kind: "parsed",
        parse: parseBindHost,
        brief: "Hostname for the local server",
        default: "localhost",
      },
      filter: {
        kind: "parsed",
        parse: choiceParser(FILTER_VALUES, parseFilter),
        brief:
          "Only show items of this type (repeatable: error, transaction, log, ai)",
        variadic: true,
        optional: true,
      },
      verify: {
        kind: "boolean",
        brief: "Verify SDK sends events, then exit",
        default: false,
      },
      timeout: {
        kind: "parsed",
        parse: textParser(parseTimeout),
        brief:
          "Kill the child after N seconds (0 = no timeout; defaults to 30 s in --verify mode)",
        default: "0",
      },
      format: {
        kind: "parsed",
        parse: choiceParser(FORMAT_VALUES, parseFormat),
        brief: "Output format: human (default) or json (NDJSON on stdout)",
        default: "human",
      },
      attributes: {
        kind: "boolean",
        brief:
          "Also show SDK attributes, under each transaction and log or in JSON",
        default: false,
      },
      open: {
        kind: "boolean",
        brief: "Open Sentry Local UI in the browser",
        default: false,
      },
      "max-envelopes": OPTIONAL_MAX_ENVELOPES_FLAG,
      session: {
        kind: "parsed",
        parse: parseText,
        brief: "Create a daemon-owned telemetry session with this label",
        optional: true,
      },
    },
    aliases: {
      p: "port",
      f: "filter",
      V: "verify",
      t: "timeout",
      F: "format",
      a: "attributes",
    },
  },
  auth: false,
  async *func(this: SentryContext, flags: RunFlags, ...rawArgs: string[]) {
    if (flags.open && flags.verify) {
      throw new ValidationError("--open cannot be used with --verify.", "open");
    }
    if (flags.session !== undefined && flags.verify) {
      throw new ValidationError(
        "--session cannot be used with --verify.",
        "session",
      );
    }
    validateOpenHost(flags.open, flags.host);

    const stripped = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
    const { args, commandSource } = await resolveArgs(stripped, this.cwd);

    if (flags.verify) {
      yield* runWithVerify(args, flags, this.cwd, commandSource);
      return;
    }

    const port = flags.port ?? DEFAULT_PORT;
    let url = formatLocalServerUrl(flags.host, port);
    let daemonSessionId: string | undefined;
    let daemonIngestUrl: string | undefined;
    let daemonStreamUrl: string | undefined;
    let daemonDirectoryUrl: string | undefined;

    const useJson = flags.format === "json";
    const activeFilters = new Set(flags.filter);
    const tail = flags.session
      ? await (async () => {
          const session = await createLocalDaemonSession({
            maxEnvelopes: flags["max-envelopes"],
            cwd: this.cwd,
            host: flags.host,
            label: flags.session || basename(this.cwd),
            port,
          });
          daemonSessionId = session.id;
          daemonIngestUrl = session.ingestUrl;
          daemonStreamUrl = session.streamUrl;
          daemonDirectoryUrl = session.directoryUrl;
          return attachToExistingServer({
            activeFilters,
            showAttributes: flags.attributes,
            streamUrl: session.streamUrl,
            url: new URL(session.streamUrl).origin,
            useJson,
          });
        })()
      : await openEventTail({
          maxEnvelopes: flags["max-envelopes"],
          port,
          freePortIfDaemon: flags.port === undefined,
          host: flags.host,
          activeFilters,
          useJson,
          showAttributes: flags.attributes,
        });
    url = tail.url;
    printLocalViewerHint(url, useJson);

    await openLocalUiIfRequested(
      flags.open,
      daemonStreamUrl ?? url,
      daemonDirectoryUrl,
    );

    const spotlightUrl = daemonIngestUrl ?? `${url}/stream`;
    const wrangler = await injectWranglerSpotlightBinding(
      args,
      spotlightUrl,
      this.cwd,
    );
    if (wrangler.injected) {
      logger.info(wranglerInjectedMessage());
    }
    // A session's Wrangler binding carries its ingest capability.
    logger.info(
      `Starting: ${bold(redactCredentialText(wrangler.args.join(" ")))}`,
    );
    logger.info(
      daemonSessionId
        ? `SENTRY_SPOTLIGHT configured for session ${daemonSessionId}. Use ${sentry`local session view ${daemonSessionId} --json`} for its ingest URL.`
        : `SENTRY_SPOTLIGHT=${spotlightUrl}`,
    );

    const childEnv = buildChildEnv(spotlightUrl, commandSource, this.cwd);

    let child: ChildProcess;
    try {
      const [cmd = "", ...cmdArgs] = wrangler.args;
      child = spawnUserCommand(cmd, cmdArgs, {
        cwd: this.cwd,
        resolveCwd: this.cwd,
        env: childEnv,
        stdio: childStdio(useJson),
      });
      forwardChildOutput(child, useJson);
    } catch (err) {
      await tail.cleanup();
      if (daemonSessionId) {
        await retainLocalDaemonSession(daemonSessionId);
      }
      throw spawnFailureError(wrangler.args[0] ?? "", err, this.cwd);
    }

    let interrupted = false;
    const interrupts = interruptForwarder(child);
    const onSigint = () => {
      interrupted = true;
      interrupts.forward();
    };
    const onSigterm = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    // `on`, not `once`: a second signal must reach the app too, not kill the
    // CLI and leave the app running.
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (flags.timeout > 0) {
      timeoutId = setTimeout(async () => {
        logger.warn(`Timeout: killing child after ${flags.timeout}s`);
        await gracefulKill(child);
      }, flags.timeout * 1000);
    }

    let exit: ChildExit;
    try {
      exit = await new Promise<ChildExit>((done, fail) => {
        let settled = false;
        child.on("close", (code, signal) => {
          if (!settled) {
            settled = true;
            done({ code, signal });
          }
        });
        child.on("error", (err) => {
          logger.debug(`Child process error: ${err.message}`);
          if (!settled) {
            settled = true;
            fail(spawnFailureError(wrangler.args[0] ?? "", err, this.cwd));
          }
        });
      });
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      interrupts.dispose();
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      await tail.cleanup();
      if (daemonSessionId) {
        await retainLocalDaemonSession(daemonSessionId);
      }
    }

    const exitCode = exit.signal
      ? signalExitCode(exit.signal)
      : (exit.code ?? EXIT.GENERAL);
    if (exitCode === 0) {
      return;
    }
    // The user stopped the app: however it ended is what they asked for, so
    // exit with its code and print no error.
    if (interrupted) {
      this.process.exitCode = exitCode;
      return;
    }
    throw new CliError(
      exit.signal
        ? `Process exited with code ${exitCode} (killed by ${exit.signal})`
        : `Process exited with code ${exitCode}`,
      exitCode,
    );
  },
});

/** How the wrapped app ended, from the child's `close` event. */
type ChildExit = {
  /** Exit code, or `null` when a signal killed it. */
  code: number | null;
  /** The signal that killed it, or `null` when it exited. */
  signal: NodeJS.Signals | null;
};

/**
 * How long to wait before passing on a SIGINT that the terminal seemed to
 * deliver already. Long enough for most apps to finish shutting down, so they
 * don't get a second SIGINT, which many treat as "force quit".
 */
const INTERRUPT_FALLBACK_MS = 3000;

/**
 * Pass the SIGINTs the CLI receives on to the child.
 *
 * Ctrl-C signals the terminal's whole foreground process group, which holds
 * the child too, so the first SIGINT is not resent while the child is in that
 * group: sending it twice made apps such as Flask run their shutdown twice.
 * The CLI can't tell Ctrl-C from `kill -INT <cli pid>`, though, so if the
 * child is still running {@link INTERRUPT_FALLBACK_MS} later it gets the
 * SIGINT anyway. Later SIGINTs are always passed on.
 */
function interruptForwarder(child: ChildProcess): {
  forward: () => void;
  dispose: () => void;
} {
  let received = 0;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    clearTimeout(fallback);
    fallback = undefined;
    child.kill("SIGINT");
  };
  return {
    forward() {
      received += 1;
      if (received > 1 || !terminalSignalsProcess(child.pid)) {
        send();
        return;
      }
      logger.debug("The terminal already sent SIGINT to the app");
      fallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logger.debug("The app is still running; sending it SIGINT");
          send();
        }
      }, INTERRUPT_FALLBACK_MS);
    },
    dispose: () => clearTimeout(fallback),
  };
}

/** Default timeout for --verify when no explicit --timeout is given. */
const DEFAULT_VERIFY_TIMEOUT_S = 30;

/** Grace period before escalating SIGTERM to SIGKILL. */
const KILL_GRACE_MS = 5000;

/** Send SIGTERM, wait up to {@link KILL_GRACE_MS}, then SIGKILL if still alive. */
async function gracefulKill(child: ChildProcess): Promise<void> {
  // No pid means the spawn failed: there is nothing to kill, and `close` may
  // never fire, so waiting for it would hang.
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch (error) {
    logger.debug("Child already exited during graceful kill", error);
    return;
  }
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    new Promise<true>((r) => child.on("close", () => r(true))),
    new Promise<false>((r) => {
      graceTimer = setTimeout(() => r(false), KILL_GRACE_MS);
    }),
  ]);
  clearTimeout(graceTimer);
  if (!exited && child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      logger.debug("Child already exited during graceful kill", error);
      return;
    }
    // Only await close if the child hasn't exited yet — avoids hanging
    // if close fired between SIGKILL and listener attachment.
    if (child.exitCode === null) {
      await new Promise<void>((r) => child.on("close", () => r()));
    }
  }
}

/**
 * Bind the verify receiver without waiting out another listener.
 *
 * The receiver only lives until the first envelope and every URL the app gets
 * is built from the bound port, so any free port works. The default port is
 * tried first for SDKs that hard-code it, and a busy default (most often the
 * daemon) falls back to an OS-assigned port. A busy `--port` the user chose
 * fails right away.
 */
async function listenForVerify(
  app: Hono,
  port: number | undefined,
  host: string,
): Promise<{ server: Server; port: number; fellBack: boolean }> {
  try {
    const bound = await tryListen(app, port ?? DEFAULT_PORT, host, {
      retries: 0,
    });
    return { ...bound, fellBack: false };
  } catch (err) {
    if (!(err instanceof ValidationError && err.field === PORT_IN_USE_FIELD)) {
      throw err;
    }
    if (port !== undefined) {
      throw new ValidationError(
        `Port ${port} is already in use. Stop whatever holds it, pass a different --port, or omit --port to verify on a free port.`,
        PORT_IN_USE_FIELD,
      );
    }
    const bound = await tryListen(app, 0, host, { retries: 0 });
    logger.info(freePortNotice(DEFAULT_PORT, bound.port, "is in use"));
    return { ...bound, fellBack: true };
  }
}

/**
 * Run in --verify mode: start a background server, subscribe to the buffer
 * for the first envelope, and race between envelope arrival, timeout,
 * and child exit.
 */
// oxlint-disable-next-line require-yield -- The command contract requires an async generator even when it yields no output.
async function* runWithVerify(
  args: string[],
  flags: RunFlags,
  cwd: string,
  commandSource: string,
): AsyncGenerator<never, void, unknown> {
  const retention = createLocalRetentionBuffer(flags["max-envelopes"]);
  const buffer = retention.buffer;
  const app = buildApp(buffer, {
    uiActions: isLoopbackHost(flags.host),
    retention,
  });
  const {
    server,
    port: boundPort,
    fellBack,
  } = await listenForVerify(app, flags.port, flags.host);
  const url = formatLocalServerUrl(flags.host, boundPort);
  // No viewer link: this receiver shuts down after the first envelope.
  logger.info(`Verify server listening on ${bold(url)}`);

  const spotlightUrl = `${url}/stream`;

  let subscriptionId: string | undefined;
  const envelopeReceived = new Promise<void>((resolveEnvelope) => {
    subscriptionId = buffer.subscribe(() => {
      resolveEnvelope();
    });
  });

  const childEnv = buildChildEnv(spotlightUrl, commandSource, cwd);
  const wrangler = await injectWranglerSpotlightBinding(
    args,
    spotlightUrl,
    cwd,
  );
  if (wrangler.injected) {
    logger.info(wranglerInjectedMessage());
  }

  let child: ChildProcess;
  const useJson = flags.format === "json";
  try {
    const [cmd = "", ...cmdArgs] = wrangler.args;
    child = spawnUserCommand(cmd, cmdArgs, {
      cwd,
      resolveCwd: cwd,
      env: childEnv,
      stdio: childStdio(useJson),
    });
    forwardChildOutput(child, useJson);
  } catch (err) {
    await shutdownServer(server);
    throw spawnFailureError(wrangler.args[0] ?? "", err, cwd);
  }

  let signalReceived: NodeJS.Signals | null = null;
  const interrupts = interruptForwarder(child);
  const onSigint = () => {
    signalReceived = "SIGINT";
    interrupts.forward();
  };
  const onSigterm = () => {
    signalReceived = "SIGTERM";
    child.kill("SIGTERM");
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // A spawn failure (e.g. ENOENT) emits `error`; `close` may also fire with
  // a negative errno code, which is not a real exit code of the app.
  let spawnError: Error | undefined;
  const childExited = new Promise<{ kind: "exited"; code: number }>((r) => {
    child.on("close", (code) =>
      r({ kind: "exited" as const, code: code ?? 1 }),
    );
    child.on("error", (err) => {
      logger.debug(`Child process error: ${err.message}`);
      spawnError = err;
      r({ kind: "exited" as const, code: 1 });
    });
  });

  const verifyTimeout =
    flags.timeout > 0 ? flags.timeout : DEFAULT_VERIFY_TIMEOUT_S;

  const racers: Promise<
    | { kind: "envelope" }
    | { kind: "exited"; code: number }
    | { kind: "timeout" }
  >[] = [
    envelopeReceived.then(() => ({ kind: "envelope" as const })),
    childExited,
  ];

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (verifyTimeout > 0) {
    racers.push(
      new Promise<{ kind: "timeout" }>((r) => {
        timeoutHandle = setTimeout(
          () => r({ kind: "timeout" as const }),
          verifyTimeout * 1000,
        );
      }),
    );
  }

  let outcome:
    | { kind: "envelope" }
    | { kind: "exited"; code: number }
    | { kind: "timeout" };
  try {
    outcome = await Promise.race(racers);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  // Clean up — keep signal handlers active during graceful kill
  try {
    await gracefulKill(child);
  } finally {
    if (subscriptionId) {
      buffer.unsubscribe(subscriptionId);
    }
    interrupts.dispose();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await shutdownServer(server);
  }

  // Re-emit the signal after cleanup so the default handler terminates the
  // process instead of continuing with the outcome switch below.
  if (signalReceived) {
    process.kill(process.pid, signalReceived);
    return;
  }

  switch (outcome.kind) {
    case "envelope": {
      logger.info(
        "Setup verified — your app is sending events to Sentry Local",
      );
      return;
    }
    case "timeout": {
      if (wrangler.injected) {
        logger.warn(
          `A Worker sends nothing until it handles a request, so send one to it while --verify waits. ${wranglerSetupHint()}`,
        );
      }
      if (fellBack) {
        // An SDK that ignores SENTRY_SPOTLIGHT still sends to the busy default
        // port, so it reaches whatever holds that port instead of this receiver.
        logger.warn(freePortNotice(DEFAULT_PORT, boundPort, "is in use"));
      }
      throw new VerifyFailedError(
        `Verification timed out after ${verifyTimeout}s — no events received from the SDK`,
      );
    }
    case "exited": {
      if (spawnError) {
        throw spawnFailureError(wrangler.args[0] ?? "", spawnError, cwd);
      }
      if (outcome.code === 0) {
        throw new VerifyFailedError("Process exited before sending any events");
      }
      throw new VerifyFailedError(
        `Process crashed with code ${outcome.code}`,
        outcome.code,
      );
    }
    default: {
      throw new CliError("Unexpected verification outcome", EXIT.GENERAL);
    }
  }
}

/**
 * stdio MCP server host for `sentry mcp`.
 *
 * Configures the embedded agent provider and MCP
 * telemetry, then serves `@sentry/mcp-core` over stdin/stdout. Credentials are
 * resolved by the caller (`lib/mcp.ts`) so this module never owns an auth flow.
 *
 * Loaded lazily: it pulls in mcp-core (and Zod), which normal CLI commands
 * must not pay for at startup.
 */

import {
  getAgentProvider,
  getResolvedProviderType,
  setAgentProvider,
  setProviderBaseUrls,
} from "@sentry/mcp-core/internal/agents/provider-factory";
import { buildServer } from "@sentry/mcp-core/server";
import { findRetainedSkillTools } from "@sentry/mcp-core/skills";
import { sentryBeforeSend } from "@sentry/mcp-core/telem/sentry";
import { startStdio } from "@sentry/mcp-core/transports/stdio";
import type { CredentialRouter, ServerContext } from "@sentry/mcp-core/types";
import tools from "@sentry/mcp-core/tools";
import { setServerVersion } from "@sentry/mcp-core/version";
import {
  close,
  consoleLoggingIntegration,
  flush,
  init,
  setCurrentClient,
  vercelAIIntegration,
  zodErrorsIntegration,
} from "@sentry/node";
import { getAppIdentity } from "../app-identity.js";
import { CLI_VERSION, SENTRY_CLI_DSN } from "../constants.js";
import { logger } from "../logger.js";
import { isTelemetryEnabled } from "../telemetry.js";
import { redactTelemetryEnvelope } from "../telemetry/credential-redaction.js";
import { clearStoredEnvelopes } from "../telemetry/offline-store.js";
import {
  makeStoringTransport,
  STORED_ENVELOPES_PER_RUN,
  type StoringTransport,
} from "../telemetry/offline-transport.js";
import { makeNodeTransportWithDeadline } from "../telemetry/zstd-transport.js";
import type { McpServerConfig } from "./config.js";
import { reportCliError } from "../error-reporting.js";

/** Credential wiring supplied by the CLI host. */
export type McpServeOptions = {
  accessToken: string;
  /**
   * Fetch a fresh credential after an upstream 401. Omitted for static
   * tokens, which are never refreshed.
   */
  refreshAccessToken?: () => Promise<string>;
  /**
   * Route each tool call to the stored account that knows its
   * organization. When set, it also refreshes credentials after a 401, so
   * `refreshAccessToken` is omitted.
   */
  credentialRouter?: CredentialRouter;
  env: NodeJS.ProcessEnv;
};

const SENTRY_FLUSH_TIMEOUT_MS = 5000;
const log = logger.withTag("mcp.telemetry");

type ProviderMismatch = { configured: string; availableKey: string };

/** The configured provider's key is missing while another provider's is set. */
function findProviderMismatch(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
): ProviderMismatch | undefined {
  const keys = {
    openai: Boolean(env.OPENAI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openrouter: Boolean(env.OPENROUTER_API_KEY),
  };
  if (configured === "openai" || configured === "azure-openai") {
    if (!keys.openai && (keys.anthropic || keys.openrouter)) {
      return {
        configured,
        availableKey: keys.openrouter
          ? "OPENROUTER_API_KEY"
          : "ANTHROPIC_API_KEY",
      };
    }
  } else if (configured === "anthropic") {
    if (!keys.anthropic && (keys.openai || keys.openrouter)) {
      return {
        configured,
        availableKey: keys.openrouter ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY",
      };
    }
  } else if (
    configured === "openrouter" &&
    !keys.openrouter &&
    (keys.openai || keys.anthropic)
  ) {
    return {
      configured,
      availableKey: keys.openai ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
    };
  }
  return;
}

function expectedProviderKey(provider: string): string {
  if (provider === "openai" || provider === "azure-openai") {
    return "OPENAI_API_KEY";
  }
  return provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
}

/** Explain why AI-powered search tools are unavailable. */
function warnNoProvider(config: McpServerConfig, env: NodeJS.ProcessEnv): void {
  const configured =
    config.agentProvider ?? env.EMBEDDED_AGENT_PROVIDER?.toLowerCase();
  const providerKeyCount = [
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.OPENROUTER_API_KEY,
  ].filter(Boolean).length;
  const mismatch = findProviderMismatch(configured, env);

  let providerConfigError: string | undefined;
  try {
    getAgentProvider();
  } catch (error) {
    providerConfigError =
      error instanceof Error ? error.message : String(error);
  }

  if (providerKeyCount > 1 && !configured) {
    logger.warn(
      [
        "Multiple LLM API keys are set, but no provider is explicitly configured.",
        "Please set EMBEDDED_AGENT_PROVIDER='openai', 'azure-openai', 'anthropic', or 'openrouter' to specify which provider to use.",
        "AI-powered search tools will be unavailable until a provider is selected.",
      ].join("\n"),
    );
  } else if (mismatch) {
    const expectedKey = expectedProviderKey(mismatch.configured);
    const providerSetting = config.agentProviderFromFlag
      ? `--agent-provider=${mismatch.configured}`
      : `EMBEDDED_AGENT_PROVIDER='${mismatch.configured}'`;
    const changeProviderHint = config.agentProviderFromFlag
      ? "Change --agent-provider to match your available API key"
      : "Change EMBEDDED_AGENT_PROVIDER to match your available API key";
    logger.warn(
      [
        `${providerSetting} but ${expectedKey} is not set.`,
        `Found ${mismatch.availableKey} instead. Either:`,
        `  - Set ${expectedKey} to use the ${mismatch.configured} provider, or`,
        `  - ${changeProviderHint}`,
        "AI-powered search tools will be unavailable until this is resolved.",
      ].join("\n"),
    );
  } else if (
    providerConfigError &&
    !providerConfigError.startsWith("No embedded agent provider configured")
  ) {
    logger.warn(
      `${providerConfigError}\nAI-powered search tools will be unavailable until this is resolved.`,
    );
  } else {
    logger.warn(
      [
        "No LLM API key found (OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY).",
        "AI-powered search tools will be unavailable.",
        "Search tools still work with direct Sentry query syntax via the 'query' parameter.",
      ].join("\n"),
    );
  }
}

/** Configure the embedded agent provider and report which one is active. */
function configureAgentProvider(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv,
): void {
  if (config.agentProvider) {
    setAgentProvider(config.agentProvider);
  }
  setProviderBaseUrls({
    openaiBaseUrl: config.openaiBaseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
  });
  // The provider factory reads model overrides from the environment.
  if (config.openaiModel) {
    env.OPENAI_MODEL = config.openaiModel;
  }
  if (config.anthropicModel) {
    env.ANTHROPIC_MODEL = config.anthropicModel;
  }

  const resolvedProvider = getResolvedProviderType();
  if (!resolvedProvider) {
    warnNoProvider(config, env);
    return;
  }

  let providerSource = "auto-detected";
  if (config.agentProviderFromFlag) {
    providerSource = "explicitly configured";
  } else if (env.EMBEDDED_AGENT_PROVIDER) {
    providerSource = "from EMBEDDED_AGENT_PROVIDER";
  }
  logger.info(
    `Using ${getAgentProvider().label} for AI-powered search tools (${providerSource}).`,
  );
  if (providerSource === "auto-detected") {
    logger.warn(
      [
        "Auto-detection of LLM provider is deprecated.",
        `Please set EMBEDDED_AGENT_PROVIDER='${resolvedProvider}' explicitly.`,
        "Auto-detection will be removed in a future release.",
      ].join("\n"),
    );
  }
}

/**
 * Start MCP telemetry.
 *
 * @internal Exported for testing
 */
export function initMcpTelemetry(config: McpServerConfig): void {
  // `init` reads `process.cwd()`, which throws when the working directory was
  // deleted. Serve without telemetry instead of crashing at startup.
  try {
    process.cwd();
  } catch (error) {
    log.debug(
      `Working directory is unavailable, starting without telemetry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const { name, packageName } = getAppIdentity();
  const scopeContext = {
    "app.server.version": CLI_VERSION,
    // Tells `@sentry/mcp-server` installs apart from `sentry mcp`.
    // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- a telemetry value, not a hint.
    "app.server.distribution": name === "sentry" ? "sentry mcp" : packageName,
    "app.transport": "stdio",
    "app.upstream.host": config.sentryHost,
    "app.url.full": config.mcpUrl,
  };
  // Unsent telemetry shares the CLI's store, so opting out clears it, as in
  // `withTelemetry()`.
  const storeTelemetry = isTelemetryEnabled();
  if (!storeTelemetry) {
    clearStoredEnvelopes();
  }
  let storingTransport: StoringTransport | undefined;

  // Always the CLI's own project, never a DSN from the environment: an MCP
  // server started from a project shell or IDE inherits the app's SENTRY_DSN.
  // Only the CLI's telemetry opt-outs turn it off.
  const client = init({
    dsn: SENTRY_CLI_DSN,
    enabled: isTelemetryEnabled(),
    tracesSampleRate: 1,
    beforeSend: sentryBeforeSend,
    initialScope: {
      tags: {
        ...scopeContext,
        "app.server.mode.experimental": config.experimental ? "true" : "false",
      },
      // SDK v11 does not copy scope tags onto streamed spans.
      attributes: {
        ...scopeContext,
        "app.server.mode.experimental": config.experimental,
      },
    },
    // Always the running release; an env override would misreport it.
    release: CLI_VERSION,
    // Same credential redaction and request deadline as the CLI's own
    // telemetry: a stalled ingest socket must not keep the process alive
    // after the client disconnects (#1956). Envelopes that fail to send are
    // stored like the CLI's own.
    transport: (transportOptions) => {
      if (storeTelemetry) {
        storingTransport = makeStoringTransport(
          transportOptions,
          makeNodeTransportWithDeadline,
        );
      }
      const transport =
        storingTransport ?? makeNodeTransportWithDeadline(transportOptions);
      return {
        send: (envelope) => transport.send(redactTelemetryEnvelope(envelope)),
        flush: (timeout) => transport.flush(timeout),
      };
    },
    integrations: [
      consoleLoggingIntegration(),
      zodErrorsIntegration(),
      vercelAIIntegration({ recordInputs: true, recordOutputs: true }),
    ],
    // The retired package fixed this at build time; keep the same value.
    environment: "stdio",
  });
  // `buildCommand` runs this inside its pre-init `exec` span, and v11 loses
  // the scope that span forked when init switches the context strategy, so
  // every span, log, and flush would find no client. Same fix as
  // `initSentry()` in telemetry.ts.
  if (client) {
    setCurrentClient(client);
  }
  // Retry what earlier runs failed to send; `close()` on disconnect waits
  // for it. The breaker sends another batch whenever ingest recovers.
  storingTransport?.sendStored(STORED_ENVELOPES_PER_RUN);
}

/**
 * Exit on fatal errors without recursing when stderr is already closed.
 *
 * @internal Exported for testing
 */
export function installProcessHandlers(): (
  error: unknown,
  label: string,
) => void {
  let exiting = false;
  function exitAfterError(error: unknown, label: string): void {
    if (exiting) {
      // oxlint-disable-next-line sentry-cli/no-process-exit -- a second fatal error while the first one is exiting.
      process.exit(1);
    }
    exiting = true;
    // Record the failure first: writing to a closed stderr below raises EPIPE,
    // whose stream handler exits with the recorded code (see stream-errors.ts).
    process.exitCode = 1;

    // If the client closed every pipe, writing to stderr can throw EPIPE
    // inside this handler and recurse forever (getsentry/sentry-mcp#1274).
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- stderr may already be closed; exiting is the only recovery.
    try {
      logger.error(label, error);
    } catch {
      // stderr may already be closed
    }
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- reporting must not block exit.
    try {
      reportCliError(error);
    } catch {
      // reporting must not block exit
    }

    // Don't depend on flush finishing — exit even if it hangs or rejects.
    // oxlint-disable-next-line sentry-cli/no-process-exit -- fatal error: exit even when the flush hangs.
    setTimeout(() => process.exit(1), SENTRY_FLUSH_TIMEOUT_MS).unref();
    // oxlint-disable-next-line sentry-cli/no-process-exit -- fatal error: exit once the flush settles.
    void flush(SENTRY_FLUSH_TIMEOUT_MS).finally(() => process.exit(1));
  }

  async function shutdown(signal: string): Promise<void> {
    // A fatal error is already flushing and will exit 1; a signal in that
    // window must not turn the crash into a successful exit.
    if (exiting) {
      return;
    }
    exiting = true;
    // The client may have closed stderr before the signal; exit cleanly anyway.
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- stderr may already be closed; shutting down is the only recovery.
    try {
      logger.info(`${signal} received, shutting down...`);
    } catch {
      // stderr may already be closed
    }
    await flush(SENTRY_FLUSH_TIMEOUT_MS);
    // oxlint-disable-next-line sentry-cli/no-process-exit -- signal shutdown, after the flush.
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    exitAfterError(error, "Uncaught exception:");
  });
  process.on("unhandledRejection", (reason) => {
    exitAfterError(reason, "Unhandled rejection:");
  });
  return exitAfterError;
}

/**
 * Warn about disabled skills that remove no tools, because another granted
 * skill still grants each of them. The logger writes to stderr, which keeps
 * stdout free for the transport.
 */
export function warnIneffectiveDisabledSkills(config: McpServerConfig): void {
  for (const skill of config.disabledSkills) {
    const retained = findRetainedSkillTools(tools, config.finalSkills, skill);
    if (retained) {
      logger.warn(
        `Disabling the "${skill}" skill removed no tools. ${retained.tools.join(", ")} stay enabled through ${retained.grantedBy.join(", ")}.`,
      );
    }
  }
}

/** Serve the MCP tools over stdio. Resolves once the client disconnects. */
export async function serveMcpStdio(
  config: McpServerConfig,
  options: McpServeOptions,
): Promise<void> {
  // @sentry/mcp-server ships at the CLI version, not mcp-core's.
  setServerVersion(CLI_VERSION);
  configureAgentProvider(config, options.env);
  initMcpTelemetry(config);
  warnIneffectiveDisabledSkills(config);

  if (config.experimental) {
    logger.info(
      "Experimental mode enabled: Forward-looking tool variants and experimental features are available.",
    );
  }

  const exitAfterError = installProcessHandlers();
  const context: ServerContext = {
    accessToken: options.accessToken,
    grantedSkills: config.finalSkills,
    constraints: {
      organizationSlug: config.organizationSlug ?? null,
      projectSlug: config.projectSlug ?? null,
      regionUrl: null,
    },
    sentryHost: config.sentryHost,
    sentryProtocol: config.sentryProtocol,
    mcpUrl: config.mcpUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    experimentalMode: config.experimental,
    transport: "stdio",
    // mcp-core uses the returned token for later tool calls, so a
    // long-running server recovers from an expired CLI session.
    onUpstreamUnauthorized: options.refreshAccessToken,
    credentialRouter: options.credentialRouter,
  };

  const server = buildServer({
    context,
    experimentalMode: config.experimental,
  });
  const connection = await startStdio(server, context).catch(
    (error: unknown) => {
      exitAfterError(error, "Server error:");
      // exitAfterError ends the process; never hand control back.
      return new Promise<never>(() => undefined);
    },
  );
  await connection.closed;
  // Send what the session recorded before the caller releases the network,
  // then disable the client: the SDK otherwise flushes metrics and client
  // reports again on every `beforeExit`, and a failed send queues a new
  // client report, so the process never drains (#1956).
  await close(SENTRY_FLUSH_TIMEOUT_MS);
}

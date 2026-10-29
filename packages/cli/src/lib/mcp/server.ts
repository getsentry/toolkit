/**
 * stdio MCP server host for `sentry mcp`.
 *
 * Parses the server flags, configures the embedded agent provider and MCP
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
import { ALL_SKILLS } from "@sentry/mcp-core/skills";
import { sentryBeforeSend } from "@sentry/mcp-core/telem/sentry";
import { startStdio } from "@sentry/mcp-core/transports/stdio";
import type { ServerContext } from "@sentry/mcp-core/types";
import { LIB_VERSION } from "@sentry/mcp-core/version";
import {
  captureException,
  consoleLoggingIntegration,
  flush,
  init,
  vercelAIIntegration,
  zodErrorsIntegration,
} from "@sentry/node";
import { CLI_VERSION } from "../constants.js";
import { mergeMcpArgs, parseMcpArgv, parseMcpEnv } from "./args.js";
import { finalizeMcpConfig, type McpServerConfig } from "./config.js";
import { buildMcpUsage } from "./usage.js";

/** What a `sentry mcp` invocation asks for. */
export type McpInvocation =
  | { kind: "output"; text: string }
  | { kind: "serve"; config: McpServerConfig };

/** Credential wiring supplied by the CLI host. */
export type McpServeOptions = {
  accessToken: string;
  /**
   * Fetch a fresh credential after an upstream 401. Omitted for static
   * tokens, which are never refreshed.
   */
  refreshAccessToken?: () => Promise<string>;
  env: NodeJS.ProcessEnv;
};

const SENTRY_FLUSH_TIMEOUT_MS = 5000;

/** Parse `sentry mcp` arguments into help/version output or a server config. */
export function parseMcpInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
): McpInvocation {
  const cli = parseMcpArgv(args);
  if (cli.help) {
    return { kind: "output", text: buildMcpUsage(ALL_SKILLS) };
  }
  if (cli.version) {
    return { kind: "output", text: `sentry mcp ${CLI_VERSION}` };
  }
  return {
    kind: "serve",
    config: finalizeMcpConfig(mergeMcpArgs(cli, parseMcpEnv(env))),
  };
}

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
    console.warn(
      "Warning: Multiple LLM API keys are set, but no provider is explicitly configured.",
    );
    console.warn(
      "Please set EMBEDDED_AGENT_PROVIDER='openai', 'azure-openai', 'anthropic', or 'openrouter' to specify which provider to use.",
    );
    console.warn(
      "AI-powered search tools will be unavailable until a provider is selected.",
    );
  } else if (mismatch) {
    const expectedKey = expectedProviderKey(mismatch.configured);
    const providerSetting = config.agentProviderFromFlag
      ? `--agent-provider=${mismatch.configured}`
      : `EMBEDDED_AGENT_PROVIDER='${mismatch.configured}'`;
    const changeProviderHint = config.agentProviderFromFlag
      ? "Change --agent-provider to match your available API key"
      : "Change EMBEDDED_AGENT_PROVIDER to match your available API key";
    console.warn(`Warning: ${providerSetting} but ${expectedKey} is not set.`);
    console.warn(`Found ${mismatch.availableKey} instead. Either:`);
    console.warn(
      `  - Set ${expectedKey} to use the ${mismatch.configured} provider, or`,
    );
    console.warn(`  - ${changeProviderHint}`);
    console.warn(
      "AI-powered search tools will be unavailable until this is resolved.",
    );
  } else if (
    providerConfigError &&
    !providerConfigError.startsWith("No embedded agent provider configured")
  ) {
    console.warn(`Warning: ${providerConfigError}`);
    console.warn(
      "AI-powered search tools will be unavailable until this is resolved.",
    );
  } else {
    console.warn(
      "Warning: No LLM API key found (OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY).",
    );
    console.warn("AI-powered search tools will be unavailable.");
    console.warn(
      "Search tools still work with direct Sentry query syntax via the 'query' parameter.",
    );
  }
  console.warn("");
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
  console.warn(
    `Using ${getAgentProvider().label} for AI-powered search tools (${providerSource}).`,
  );
  if (providerSource === "auto-detected") {
    console.warn(
      "Deprecation warning: Auto-detection of LLM provider is deprecated.",
    );
    console.warn(
      `Please set EMBEDDED_AGENT_PROVIDER='${resolvedProvider}' explicitly.`,
    );
    console.warn("Auto-detection will be removed in a future release.");
  }
  console.warn("");
}

function initMcpTelemetry(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv,
): void {
  const scopeContext = {
    "app.server.version": LIB_VERSION,
    "app.transport": "stdio",
    "app.upstream.host": config.sentryHost,
    "app.url.full": config.mcpUrl,
  };

  init({
    dsn: config.sentryDsn,
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
    release: env.SENTRY_RELEASE,
    integrations: [
      consoleLoggingIntegration(),
      zodErrorsIntegration(),
      vercelAIIntegration({ recordInputs: true, recordOutputs: true }),
    ],
    // The standalone local server fixed this at build time; keep the same value.
    environment: "stdio",
  });
}

/** Exit on fatal errors without recursing when stderr is already closed. */
function installProcessHandlers(): (error: unknown, label: string) => void {
  let exiting = false;
  function exitAfterError(error: unknown, label: string): void {
    if (exiting) {
      process.exit(1);
    }
    exiting = true;

    // If the client closed every pipe, console.error can throw EPIPE inside
    // this handler and recurse forever (getsentry/sentry-mcp#1274).
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- stderr may already be closed; exiting is the only recovery.
    try {
      console.error(label, error);
    } catch {
      // stderr may already be closed
    }
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- reporting must not block exit.
    try {
      captureException(error);
    } catch {
      // reporting must not block exit
    }

    // Don't depend on flush finishing — exit even if it hangs or rejects.
    setTimeout(() => process.exit(1), SENTRY_FLUSH_TIMEOUT_MS).unref();
    void flush(SENTRY_FLUSH_TIMEOUT_MS).finally(() => process.exit(1));
  }

  async function shutdown(signal: string): Promise<void> {
    console.error(`${signal} received, shutting down...`);
    await flush(SENTRY_FLUSH_TIMEOUT_MS);
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

/** Serve the MCP tools over stdio until the client disconnects. */
export function serveMcpStdio(
  config: McpServerConfig,
  options: McpServeOptions,
): void {
  configureAgentProvider(config, options.env);
  initMcpTelemetry(config, options.env);

  if (config.experimental) {
    console.warn(
      "Experimental mode enabled: Forward-looking tool variants and experimental features are available.",
    );
    console.warn("");
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
  };

  const server = buildServer({
    context,
    experimentalMode: config.experimental,
  });
  startStdio(server, context).catch((error: unknown) => {
    exitAfterError(error, "Server error:");
  });
}

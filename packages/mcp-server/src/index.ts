#!/usr/bin/env node

/**
 * Main CLI entry point for the Sentry MCP server.
 *
 * Handles command-line argument parsing, environment configuration, Sentry
 * initialization, and starts the MCP server with stdio transport. Supports
 * device code authentication for sentry.io when no access token is provided.
 *
 * Subcommands:
 *   auth [login]   — Force device code authentication
 *   auth logout    — Clear cached authentication
 *   auth status    — Show current authentication state
 *
 * @example CLI Usage
 * ```bash
 * npx @sentry/mcp-server --access-token=TOKEN --host=sentry.io
 * npx @sentry/mcp-server auth login
 * npx @sentry/mcp-server auth logout
 * ```
 */

import { pathToFileURL } from "node:url";

import {
  getAgentProvider,
  getResolvedProviderType,
  setAgentProvider,
  setProviderBaseUrls,
} from "@sentry/mcp-core/internal/agents/provider-factory";
import { buildServer } from "@sentry/mcp-core/server";
import { SKILLS } from "@sentry/mcp-core/skills";
import { sentryBeforeSend } from "@sentry/mcp-core/telem/sentry";
import { LIB_VERSION } from "@sentry/mcp-core/version";
import * as Sentry from "@sentry/node";
import { resolveAccessToken } from "./auth/resolve-token";
import { authCommand } from "./cli/commands/auth";
import { printCliLine } from "./cli/output";
import { merge, parseArgv, parseEnv } from "./cli/parse";
import { finalize } from "./cli/resolve";
import type { PartiallyResolvedConfig } from "./cli/types";
import { buildUsage } from "./cli/usage";
import { startStdio } from "./transports/stdio";

const defaultPackageName = "@sentry/mcp-server";
const allSkills = Object.keys(SKILLS) as ReadonlyArray<
  (typeof SKILLS)[keyof typeof SKILLS]["id"]
>;

export type McpServerOptions = {
  /**
   * Supplies credentials from a host application instead of the standalone
   * device-code and cache flow.
   */
  resolveAccessToken?: (config: PartiallyResolvedConfig) => Promise<string>;
  /**
   * Invoked when a tool call surfaces an upstream 401. The host application can
   * refresh its credential and call `setAccessToken` so later tool calls use
   * the new token without restarting the server.
   */
  onUpstreamUnauthorized?: (
    setAccessToken: (token: string) => void,
  ) => void | Promise<void>;
  /** Command name used in usage output. */
  packageName?: string;
  /** Environment used for server configuration. */
  environment?: NodeJS.ProcessEnv;
  /** Throw setup errors instead of printing usage and exiting the process. */
  throwOnError?: boolean;
};

/** Start the stdio MCP server with either standalone or host-provided auth. */
export async function runMcpServer(
  rawArgs = process.argv.slice(2),
  options: McpServerOptions = {},
) {
  const packageName = options.packageName ?? defaultPackageName;
  const usageText = buildUsage(packageName, allSkills, {
    usesHostAuthentication: options.resolveAccessToken !== undefined,
  });

  function die(error: unknown): never {
    if (options.throwOnError) {
      throw error;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usageText);
    process.exit(1);
  }

  // Handle subcommands before normal server parsing
  if (rawArgs[0] === "auth") {
    if (options.resolveAccessToken) {
      die(
        new Error("Use `sentry auth` to manage credentials for `sentry mcp`."),
      );
    }
    await authCommand(rawArgs.slice(1));
    return;
  }

  const cli = parseArgv(rawArgs);
  if (cli.help) {
    printCliLine(usageText);
    process.exit(0);
  }
  if (cli.version) {
    printCliLine(`${packageName} ${LIB_VERSION}`);
    process.exit(0);
  }
  if (cli.unknownArgs.length > 0) {
    die(new Error(`Error: Invalid argument(s): ${cli.unknownArgs.join(", ")}`));
  }

  const env = parseEnv(options.environment ?? process.env);
  const partialCfg = (() => {
    try {
      return finalize(merge(cli, env));
    } catch (err) {
      die(err);
    }
  })();

  // Resolve access token before starting the transport.
  // For sentry.io without a token, this blocks on device code flow —
  // the client won't connect until the user has authenticated.
  const cfg = await (options.resolveAccessToken
    ? options.resolveAccessToken(partialCfg).then((accessToken) => ({
        ...partialCfg,
        accessToken,
      }))
    : resolveAccessToken(partialCfg)
  ).catch((err) => {
    die(err);
  });

  // Configure embedded agent provider
  if (cfg.agentProvider) {
    setAgentProvider(cfg.agentProvider);
  }
  setProviderBaseUrls({
    openaiBaseUrl: cfg.openaiBaseUrl,
    anthropicBaseUrl: cfg.anthropicBaseUrl,
  });
  if (cfg.openaiModel) {
    process.env.OPENAI_MODEL = cfg.openaiModel;
  }
  if (cfg.anthropicModel) {
    process.env.ANTHROPIC_MODEL = cfg.anthropicModel;
  }

  // Helper functions for provider status messages
  function hasProviderConflict(): boolean {
    const providerKeyCount = [
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.OPENROUTER_API_KEY,
    ].filter(Boolean).length;
    const hasExplicitProvider =
      cfg.agentProvider || process.env.EMBEDDED_AGENT_PROVIDER;
    return providerKeyCount > 1 && !hasExplicitProvider;
  }

  function getConfiguredProvider(): string | undefined {
    return (
      cfg.agentProvider || process.env.EMBEDDED_AGENT_PROVIDER?.toLowerCase()
    );
  }

  function hasProviderMismatch(): {
    mismatch: boolean;
    configured?: string;
    availableKey?: string;
  } {
    const configured = getConfiguredProvider();
    if (!configured) return { mismatch: false };

    const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
    const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);

    // Check if configured provider's key is missing but other key is present
    if (
      (configured === "openai" || configured === "azure-openai") &&
      !hasOpenAI &&
      (hasAnthropic || hasOpenRouter)
    ) {
      return {
        mismatch: true,
        configured,
        availableKey: hasOpenRouter
          ? "OPENROUTER_API_KEY"
          : "ANTHROPIC_API_KEY",
      };
    }
    if (
      configured === "anthropic" &&
      !hasAnthropic &&
      (hasOpenAI || hasOpenRouter)
    ) {
      return {
        mismatch: true,
        configured: "anthropic",
        availableKey: hasOpenRouter ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY",
      };
    }
    if (
      configured === "openrouter" &&
      !hasOpenRouter &&
      (hasOpenAI || hasAnthropic)
    ) {
      return {
        mismatch: true,
        configured: "openrouter",
        availableKey: hasOpenAI ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
      };
    }

    return { mismatch: false };
  }

  function getProviderSource(): string {
    // Check CLI flag first (cli.agentProvider is only set by --agent-provider flag)
    if (cli.agentProvider) return "explicitly configured";
    // Then check env var (process.env takes precedence over cfg since cfg merges both)
    if (process.env.EMBEDDED_AGENT_PROVIDER)
      return "from EMBEDDED_AGENT_PROVIDER";
    return "auto-detected";
  }

  // Check for LLM API keys and warn if none available
  const resolvedProvider = getResolvedProviderType() as
    | "openai"
    | "azure-openai"
    | "anthropic"
    | "openrouter"
    | undefined;

  if (!resolvedProvider) {
    const mismatchInfo = hasProviderMismatch();
    let providerConfigError: string | undefined;
    try {
      getAgentProvider();
    } catch (error) {
      providerConfigError =
        error instanceof Error ? error.message : String(error);
    }

    if (hasProviderConflict()) {
      console.warn(
        "Warning: Multiple LLM API keys are set, but no provider is explicitly configured.",
      );
      console.warn(
        "Please set EMBEDDED_AGENT_PROVIDER='openai', 'azure-openai', 'anthropic', or 'openrouter' to specify which provider to use.",
      );
      console.warn(
        "AI-powered search tools will be unavailable until a provider is selected.",
      );
    } else if (mismatchInfo.mismatch) {
      const expectedKey =
        mismatchInfo.configured === "openai" ||
        mismatchInfo.configured === "azure-openai"
          ? "OPENAI_API_KEY"
          : mismatchInfo.configured === "openrouter"
            ? "OPENROUTER_API_KEY"
            : "ANTHROPIC_API_KEY";
      const configuredViaCliFlag = Boolean(cli.agentProvider);
      const providerSetting = configuredViaCliFlag
        ? `--agent-provider=${mismatchInfo.configured}`
        : `EMBEDDED_AGENT_PROVIDER='${mismatchInfo.configured}'`;
      const changeProviderHint = configuredViaCliFlag
        ? "Change --agent-provider to match your available API key"
        : "Change EMBEDDED_AGENT_PROVIDER to match your available API key";
      console.warn(
        `Warning: ${providerSetting} but ${expectedKey} is not set.`,
      );
      console.warn(`Found ${mismatchInfo.availableKey} instead. Either:`);
      console.warn(
        `  - Set ${expectedKey} to use the ${mismatchInfo.configured} provider, or`,
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
  } else {
    const providerSource = getProviderSource();
    const providerLabel = getAgentProvider().label;
    console.warn(
      `Using ${providerLabel} for AI-powered search tools (${providerSource}).`,
    );
    // Warn about auto-detection deprecation
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

  const scopeContext = {
    "app.server.version": LIB_VERSION,
    "app.transport": "stdio",
    "app.upstream.host": cfg.sentryHost,
    "app.url.full": cfg.mcpUrl,
  };

  Sentry.init({
    dsn: cfg.sentryDsn,
    tracesSampleRate: 1,
    beforeSend: sentryBeforeSend,
    initialScope: {
      tags: {
        ...scopeContext,
        "app.server.mode.experimental": cli.experimental ? "true" : "false",
      },
      // SDK v11 does not copy scope tags onto streamed spans.
      attributes: {
        ...scopeContext,
        "app.server.mode.experimental": cli.experimental === true,
      },
    },
    release: process.env.SENTRY_RELEASE,
    integrations: [
      Sentry.consoleLoggingIntegration(),
      Sentry.zodErrorsIntegration(),
      Sentry.vercelAIIntegration({
        recordInputs: true,
        recordOutputs: true,
      }),
    ],
    environment:
      process.env.SENTRY_ENVIRONMENT ??
      (process.env.NODE_ENV !== "production" ? "development" : "production"),
  });

  // Log experimental mode status
  if (cli.experimental) {
    console.warn(
      "Experimental mode enabled: Forward-looking tool variants and experimental features are available.",
    );
    console.warn("");
  }

  const SENTRY_TIMEOUT = 5000; // 5 seconds

  // Graceful shutdown handlers
  async function shutdown(signal: string) {
    console.error(`${signal} received, shutting down...`);
    await Sentry.flush(SENTRY_TIMEOUT);
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // If the client dies and closes all pipes, console.error can throw EPIPE
  // inside these handlers. Without a guard, that recurses forever and burns CPU.
  // See getsentry/sentry-mcp#1274.
  let exiting = false;
  function exitAfterError(error: unknown, label: string) {
    if (exiting) {
      process.exit(1);
      return;
    }
    exiting = true;

    try {
      console.error(label, error);
    } catch {
      // stderr may already be closed
    }

    try {
      Sentry.captureException(error);
    } catch {
      // reporting must not block exit
    }

    // Don't depend on flush finishing — exit even if it hangs or rejects.
    const timer = setTimeout(() => process.exit(1), SENTRY_TIMEOUT);
    timer.unref();
    void Sentry.flush(SENTRY_TIMEOUT).finally(() => process.exit(1));
  }

  process.on("uncaughtException", (error) => {
    exitAfterError(error, "Uncaught exception:");
  });

  process.on("unhandledRejection", (reason) => {
    exitAfterError(reason, "Unhandled rejection:");
  });

  const context = {
    accessToken: cfg.accessToken,
    grantedSkills: cfg.finalSkills,
    constraints: {
      organizationSlug: cfg.organizationSlug ?? null,
      projectSlug: cfg.projectSlug ?? null,
      regionUrl: null,
    },
    sentryHost: cfg.sentryHost,
    sentryProtocol: cfg.sentryProtocol,
    mcpUrl: cfg.mcpUrl,
    openaiBaseUrl: cfg.openaiBaseUrl,
    experimentalMode: cli.experimental,
    transport: "stdio" as const,
    // Let the host refresh its credential on an upstream 401 and write it back
    // so subsequent tool calls use the new token. Tool handlers read
    // `context.accessToken` fresh per call, so mutating it here is enough.
    onUpstreamUnauthorized: options.onUpstreamUnauthorized
      ? () =>
          options.onUpstreamUnauthorized?.((token) => {
            context.accessToken = token;
          })
      : undefined,
  };

  // Build server with context to filter tools based on granted skills
  // Use experimentalMode when --experimental flag is set (enables forward-looking variants)
  const server = buildServer({
    context,
    experimentalMode: cli.experimental,
  });

  startStdio(server, context).catch((err) => {
    exitAfterError(err, "Server error:");
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runMcpServer().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

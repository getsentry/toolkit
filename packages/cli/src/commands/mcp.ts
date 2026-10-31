/**
 * `sentry mcp`: run the local Sentry MCP server over stdio.
 *
 * Also the default command of the `@sentry/mcp-server` package, so
 * `npx @sentry/mcp-server` starts the same server. The server stack (mcp-core,
 * the embedded agent providers, `@sentry/node`'s MCP telemetry) loads only
 * when the server starts, not for `--help`.
 */

import { ALL_SKILLS } from "@sentry/mcp-core/skills";
import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import type { McpFlags } from "../lib/mcp/args.js";

/** An optional string flag. */
function stringFlag(brief: string) {
  return { kind: "parsed", parse: String, brief, optional: true } as const;
}

/** A boolean flag that defaults to off. */
function booleanFlag(brief: string) {
  return { kind: "boolean", brief, default: false } as const;
}

export const mcpCommand = buildCommand({
  // The server resolves its own credential: a static token, or the CLI
  // session, with its own `.sentryclirc` URL check.
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Start a local Sentry MCP server",
    fullDescription:
      "Serve the Sentry MCP tools over stdio, for MCP clients such as Claude Code, Cursor, or VS Code. " +
      "Uses the current Sentry CLI login, refreshing it as needed, and stays on the account it started with. " +
      "Log in with 'auth login' first, or pass a token with --access-token or SENTRY_ACCESS_TOKEN.\n\n" +
      "The token from --access-token or SENTRY_ACCESS_TOKEN is used as given and never refreshed, " +
      "even when a CLI login exists. An org auth token (sntrys_) only works with the host it was issued for.\n\n" +
      "Environment variables:\n" +
      "  SENTRY_ACCESS_TOKEN      Static Sentry token (same as --access-token)\n" +
      "  SENTRY_HOST, SENTRY_URL  Sentry instance (same as for other commands)\n" +
      "  MCP_URL                  MCP server URL reported in telemetry\n" +
      "  SENTRY_DSN               DSN for the server's own telemetry\n" +
      "  OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY\n" +
      "                           LLM API key for AI-powered search tools\n" +
      "  OPENAI_MODEL, ANTHROPIC_MODEL, OPENROUTER_MODEL\n" +
      "                           LLM model overrides\n" +
      "  OPENROUTER_REASONING_EFFORT\n" +
      "                           none|minimal|low|medium|high|xhigh, or empty to omit (default: high)\n" +
      "  EMBEDDED_AGENT_PROVIDER  openai, azure-openai, anthropic, or openrouter\n" +
      "  MCP_SKILLS               Skills to grant (comma-separated)\n" +
      "  MCP_DISABLE_SKILLS       Skills to remove (comma-separated)\n\n" +
      `Available skills: ${ALL_SKILLS.join(", ")}`,
    examples: [
      {
        description: "Start the server with the current CLI login",
        command: "sentry mcp",
      },
      {
        description: "Grant every skill, including seer on self-hosted",
        command: "sentry mcp --all-skills",
      },
      {
        description: "Grant only some skills",
        command: "sentry mcp --skills inspect,triage",
      },
      {
        description: "Use a self-hosted instance over plain HTTP",
        command: "sentry mcp --host sentry.internal:9000 --insecure-http",
      },
      {
        description: "Pick the LLM provider for AI-powered search",
        command: "sentry mcp --agent-provider anthropic",
      },
    ],
  },
  parameters: {
    flags: {
      "access-token": stringFlag(
        "Use this Sentry token instead of the CLI login (never refreshed)",
      ),
      host: stringFlag("Sentry host for self-hosted instances"),
      url: stringFlag("Sentry URL (https only; use --host for http)"),
      "insecure-http": booleanFlag(
        "Use http:// for a self-hosted --host value",
      ),
      "organization-slug": stringFlag("Limit every call to this organization"),
      "project-slug": stringFlag("Limit calls to this project"),
      skills: stringFlag(
        "Skills to grant, comma-separated (default: active skills; seer is left out on self-hosted)",
      ),
      "all-skills": booleanFlag(
        "Grant every active skill, including seer on self-hosted",
      ),
      "disable-skills": stringFlag("Skills to remove, comma-separated"),
      experimental: booleanFlag(
        "Enable forward-looking tool variants and experimental features",
      ),
      "agent-provider": stringFlag(
        "LLM provider for AI-powered search: openai, azure-openai, anthropic, or openrouter",
      ),
      "openai-base-url": stringFlag("OpenAI API base URL"),
      "openai-model": stringFlag("OpenAI model (default: gpt-5)"),
      "anthropic-base-url": stringFlag("Anthropic API base URL"),
      "anthropic-model": stringFlag(
        "Anthropic model (default: claude-sonnet-4-5)",
      ),
      "mcp-url": stringFlag("MCP server URL reported in telemetry"),
      "sentry-dsn": stringFlag("DSN for the server's own telemetry"),
    },
  },
  // oxlint-disable-next-line require-yield -- The server speaks JSON-RPC on stdout; the command yields no output.
  async *func(this: SentryContext, flags: McpFlags) {
    const { serveMcp } = await import("../lib/mcp.js");
    // Resolves when the client disconnects, so the runner tears down only
    // after the server is done.
    await serveMcp(flags);
  },
});

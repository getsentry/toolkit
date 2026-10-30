/** Help and version text for `sentry mcp` and `sentry-mcp`. */

import type { Skill } from "@sentry/mcp-core/skills";
import { CLI_VERSION } from "../constants.js";
import { LOGIN_COMMAND, MCP_SERVER_VERSION } from "../login-command.js";

/** The command that launched this server, for help and error text. */
export const MCP_COMMAND = MCP_SERVER_VERSION ? "sentry-mcp" : "sentry mcp";

/** The release that is running: the package version or the CLI's. */
export const MCP_VERSION = MCP_SERVER_VERSION ?? CLI_VERSION;

/** Build the `--version` output. */
export function buildMcpVersion(): string {
  return `${MCP_COMMAND} ${MCP_VERSION}`;
}

/** Build the `--help` text. */
export function buildMcpUsage(allSkills: ReadonlyArray<Skill>): string {
  return `Usage: ${MCP_COMMAND} [--access-token=<token>] [--host=<host>] [--insecure-http]

Authentication:
  Uses the active Sentry CLI session by default. Authenticate with \`${LOGIN_COMMAND}\`.
  --access-token <token>  Use this Sentry auth token instead of the CLI session
                          (never refreshed; org auth tokens must match the selected host)

Common optional flags:
  --host <host>           Change Sentry host (self-hosted)
  --url <url>             Change Sentry URL (https only; use --host for http)
  --insecure-http         Use http:// for self-hosted --host values
  --mcp-url <url>         MCP server URL reported in telemetry
  --sentry-dsn <dsn>      Override DSN used for telemetry reporting
  --experimental          Enable forward-looking tool variants and experimental features
  -h, --help              Show this help
  -v, --version           Show the version

Embedded agent configuration:
  --agent-provider <provider>   LLM provider: openai, azure-openai, anthropic, or openrouter (auto-detects from API keys)
  --openai-base-url <url>       Override OpenAI API base URL
  --openai-model <model>        Override OpenAI model (default: gpt-5)
  --anthropic-base-url <url>    Override Anthropic API base URL
  --anthropic-model <model>     Override Anthropic model (default: claude-sonnet-4-5)

Session constraints:
  --organization-slug <slug>  Force all calls to an organization
  --project-slug <slug>       Optional project constraint

Skill controls:
  --skills <list>           Specify which skills to grant (default: active, non-deprecated skills;
                            seer is excluded by default on self-hosted hosts)
  --all-skills              Grant all active, non-deprecated skills (including seer on self-hosted)
  --disable-skills <list>   Remove specific skills (e.g. --disable-skills=seer)

Available skills: ${allSkills.join(", ")}

Environment variables:
  SENTRY_ACCESS_TOKEN     Static Sentry token (alternative to --access-token)
  SENTRY_HOST, SENTRY_URL Sentry instance (same as for other sentry commands)
  MCP_URL                 MCP server URL reported in telemetry
  SENTRY_DSN              DSN used for telemetry reporting
  OPENAI_API_KEY          OpenAI API key for AI-powered search tools
  OPENAI_MODEL            OpenAI model override
  ANTHROPIC_API_KEY       Anthropic API key for AI-powered search tools
  ANTHROPIC_MODEL         Anthropic model override
  OPENROUTER_API_KEY      OpenRouter API key for AI-powered search tools
  OPENROUTER_MODEL        OpenRouter model (default: openai/gpt-5.6-luna)
  OPENROUTER_REASONING_EFFORT  OpenRouter reasoning effort: none|minimal|low|medium|high|xhigh (max→xhigh), or "" to omit (default: high)
  EMBEDDED_AGENT_PROVIDER Provider override: openai, azure-openai, anthropic, or openrouter
  MCP_SKILLS              Specify which skills to grant (comma-separated)
  MCP_DISABLE_SKILLS      Disable specific skills (comma-separated)

Examples:
  ${MCP_COMMAND}
  ${MCP_COMMAND} --all-skills
  ${MCP_COMMAND} --skills=inspect,triage
  ${MCP_COMMAND} --host=sentry.example.com
  ${MCP_COMMAND} --host=sentry.internal:9000 --insecure-http
  ${MCP_COMMAND} --access-token=TOKEN --host=sentry.example.com --skills=inspect,seer
  ${MCP_COMMAND} --agent-provider=azure-openai --openai-base-url=https://example.openai.azure.com/openai/v1/
  ${MCP_COMMAND} --agent-provider=anthropic`;
}

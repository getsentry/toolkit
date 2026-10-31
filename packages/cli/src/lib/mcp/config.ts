/**
 * Validation and defaults for `sentry mcp` settings.
 *
 * Turns merged flags and environment values into the server configuration:
 * the Sentry target, granted skills, and embedded agent provider settings.
 * The credential is resolved later, once the target host is known.
 */

import {
  ACTIVE_SKILLS,
  ALL_SKILLS,
  parseSkills,
  type Skill,
} from "@sentry/mcp-core/skills";
import {
  validateAndParseSentryUrlThrows,
  validateOpenAiBaseUrlThrows,
  validateSentryHostThrows,
} from "@sentry/mcp-core/utils/url-utils";
import { isSentryHost } from "@sentry/toolkit-core/sentry-host";
import { ValidationError } from "../errors.js";
import type { McpMergedArgs } from "./args.js";

/** Embedded agent providers the MCP server can use. */
export type McpAgentProvider =
  | "openai"
  | "azure-openai"
  | "anthropic"
  | "openrouter";

/** Validated `sentry mcp` configuration, before credential resolution. */
export type McpServerConfig = {
  /** Static token from `--access-token` or `SENTRY_ACCESS_TOKEN`. */
  accessToken?: string;
  sentryHost: string;
  sentryProtocol: "http" | "https";
  mcpUrl?: string;
  sentryDsn?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  agentProvider?: McpAgentProvider;
  agentProviderFromFlag: boolean;
  experimental: boolean;
  /** Skills granted for this session. */
  finalSkills: Set<Skill>;
  organizationSlug?: string;
  projectSlug?: string;
};

const AGENT_PROVIDERS: ReadonlySet<string> = new Set<McpAgentProvider>([
  "openai",
  "azure-openai",
  "anthropic",
  "openrouter",
]);

function isAgentProvider(value: string): value is McpAgentProvider {
  return AGENT_PROVIDERS.has(value);
}

/** Wrap mcp-core validation errors in the CLI's input validation error. */
function validated<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function formatInvalidSkills(
  invalid: string[],
  source?: string,
): string {
  const prefix = source ? `${source} provided` : "Invalid skills provided";
  return `${prefix}: ${invalid.join(", ")}\nAvailable skills: ${ALL_SKILLS.join(", ")}`;
}

/** Resolve the Sentry host from `--url` or `--host`, defaulting to sentry.io. */
export function resolveHost(url?: string, host?: string): string {
  if (url) {
    return validated(() => validateAndParseSentryUrlThrows(url));
  }
  if (host) {
    validated(() => validateSentryHostThrows(host));
    return host;
  }
  return "sentry.io";
}

/**
 * Resolve granted skills.
 *
 * stdio intentionally grants every active skill when `--skills` is absent, so
 * a local server works without extra configuration. The hosted OAuth flow
 * asks the user to choose instead. Seer is a sentry.io service: self-hosted
 * autofix endpoints answer 500 without it, so it is left out of the implicit
 * default there; `--skills=seer` or `--all-skills` opt back in.
 */
function resolveSkills(input: McpMergedArgs, sentryHost: string): Set<Skill> {
  if (input.skills && input.allSkills) {
    throw new ValidationError("--all-skills cannot be combined with --skills.");
  }

  let finalSkills: Set<Skill>;
  if (input.allSkills) {
    finalSkills = new Set<Skill>(ACTIVE_SKILLS);
  } else if (input.skills) {
    const { valid, invalid } = parseSkills(input.skills);
    if (invalid.length > 0) {
      throw new ValidationError(formatInvalidSkills(invalid));
    }
    if (valid.size === 0) {
      throw new ValidationError(
        "Invalid skills provided. No valid skills found.",
      );
    }
    finalSkills = valid;
  } else {
    finalSkills = new Set<Skill>(ACTIVE_SKILLS);
    if (!isSentryHost(sentryHost)) {
      finalSkills.delete("seer");
    }
  }

  if (input.disableSkills) {
    const { valid: skillsToDisable, invalid } = parseSkills(
      input.disableSkills,
    );
    if (invalid.length > 0) {
      throw new ValidationError(
        formatInvalidSkills(invalid, "--disable-skills"),
      );
    }
    for (const skill of skillsToDisable) {
      finalSkills.delete(skill);
    }
    if (finalSkills.size === 0) {
      throw new ValidationError(
        "All skills have been disabled. At least one skill must remain enabled.",
      );
    }
  }

  return finalSkills;
}

function resolveAgentProvider(value?: string): McpAgentProvider | undefined {
  if (!value) {
    return;
  }
  const provider = value.toLowerCase();
  if (!isAgentProvider(provider)) {
    throw new ValidationError(
      `Invalid agent provider "${value}". Must be "openai", "azure-openai", "anthropic", or "openrouter".`,
    );
  }
  return provider;
}

/** Validate merged settings and apply defaults. */
export function finalizeMcpConfig(input: McpMergedArgs): McpServerConfig {
  if (input.insecureHttp && input.url) {
    throw new ValidationError(
      "--insecure-http cannot be used with --url. Use --host for insecure self-hosted instances.",
    );
  }

  const sentryHost = resolveHost(input.url, input.host);
  if (input.insecureHttp && isSentryHost(sentryHost)) {
    throw new ValidationError(
      "--insecure-http is only supported for self-hosted Sentry hosts.",
    );
  }
  const finalSkills = resolveSkills(input, sentryHost);

  return {
    accessToken: input.accessToken,
    sentryHost,
    sentryProtocol: input.insecureHttp ? "http" : "https",
    mcpUrl: input.mcpUrl,
    sentryDsn: input.sentryDsn,
    // Anthropic base URLs follow the same rules as OpenAI ones.
    openaiBaseUrl: input.openaiBaseUrl
      ? validated(() => validateOpenAiBaseUrlThrows(input.openaiBaseUrl ?? ""))
      : undefined,
    openaiModel: input.openaiModel,
    anthropicBaseUrl: input.anthropicBaseUrl
      ? validated(() =>
          validateOpenAiBaseUrlThrows(input.anthropicBaseUrl ?? ""),
        )
      : undefined,
    anthropicModel: input.anthropicModel,
    agentProvider: resolveAgentProvider(input.agentProvider),
    agentProviderFromFlag: input.agentProviderFromFlag,
    experimental: input.experimental,
    finalSkills,
    organizationSlug: input.organizationSlug,
    projectSlug: input.projectSlug,
  };
}

import {
  ACTIVE_SKILLS,
  ALL_SKILLS,
  parseSkills,
  type Skill,
} from "@sentry/mcp-core/skills";
import {
  isSentryHost,
  validateAndParseSentryUrlThrows,
  validateOpenAiBaseUrlThrows,
  validateSentryHostThrows,
} from "@sentry/mcp-core/utils/url-utils";
import { DEFAULT_SENTRY_CLIENT_ID } from "../auth/constants";
import type { MergedArgs, PartiallyResolvedConfig } from "./types";

export function formatInvalidSkills(
  invalid: string[],
  source?: string,
): string {
  const prefix = source ? `${source} provided` : "Invalid skills provided";
  return `Error: ${prefix}: ${invalid.join(", ")}\nAvailable skills: ${ALL_SKILLS.join(", ")}`;
}

/**
 * Resolves the Sentry host from url/host inputs with validation.
 * Used by both the server flow (finalize) and auth commands (resolveAuthContext)
 * to ensure cache keys always match.
 */
export function resolveHost(url?: string, host?: string): string {
  if (url) {
    return validateAndParseSentryUrlThrows(url);
  }
  if (host) {
    validateSentryHostThrows(host);
    return host;
  }
  return "sentry.io";
}

export function finalize(input: MergedArgs): PartiallyResolvedConfig {
  if (input.insecureHttp && input.url) {
    throw new Error(
      "Error: --insecure-http cannot be used with --url or SENTRY_URL. Use --host for insecure self-hosted instances.",
    );
  }

  const sentryHost = resolveHost(input.url, input.host);

  if (input.insecureHttp && isSentryHost(sentryHost)) {
    throw new Error(
      "Error: --insecure-http is only supported for self-hosted Sentry hosts.",
    );
  }

  const sentryProtocol = input.insecureHttp ? "http" : "https";

  // Skills resolution
  //
  // IMPORTANT: stdio (CLI) intentionally defaults to all active skills when no --skills flag is provided
  //
  // This differs from the OAuth flow, which requires explicit user selection:
  // - stdio/CLI: Non-interactive, defaults to all non-deprecated skills
  // - OAuth: Interactive, requires user to explicitly select skills (with sensible defaults pre-checked)
  //
  // Rationale:
  // We don't want the MCP to break if users don't specify skills. stdio is typically used in
  // local development and CI/CD environments where maximum access by default is expected.
  // OAuth is used in multi-tenant hosted environments where users should consciously grant
  // permissions on a per-app basis.
  //
  // For OAuth validation that enforces minimum 1 skill selection, see:
  // packages/mcp-cloudflare/src/server/oauth/routes/callback.ts (lines 234-248)
  //
  let finalSkills: Set<Skill>;
  if (input.skills && input.allSkills) {
    throw new Error("Error: --all-skills cannot be combined with --skills.");
  }

  if (input.allSkills) {
    finalSkills = new Set<Skill>(ACTIVE_SKILLS);
  } else if (input.skills) {
    // Override: use only the specified skills
    const { valid, invalid } = parseSkills(input.skills);
    if (invalid.length > 0) {
      throw new Error(formatInvalidSkills(invalid));
    }
    if (valid.size === 0) {
      throw new Error("Error: Invalid skills provided. No valid skills found.");
    }
    finalSkills = valid;
  } else {
    // Default: grant all active skills when no flag is provided (see comment block above for rationale)
    finalSkills = new Set<Skill>(ACTIVE_SKILLS);

    // Seer is a sentry.io service. Self-hosted Sentry ships without it, and its
    // autofix endpoints answer 500 when the Seer backend is not configured, so
    // every `get_issue_details` call (which fetches autofix state) and every
    // `analyze_issue_with_seer` poll loop would just generate server errors.
    // Leave Seer out of the implicit default on self-hosted hosts; users who
    // do run Seer can still opt in with --skills=seer or --all-skills.
    if (!isSentryHost(sentryHost)) {
      finalSkills.delete("seer");
    }
  }

  // Disable-skills: remove specific skills from the active set
  if (input.disableSkills) {
    const { valid: skillsToDisable, invalid } = parseSkills(
      input.disableSkills,
    );
    if (invalid.length > 0) {
      throw new Error(formatInvalidSkills(invalid, "--disable-skills"));
    }
    for (const skill of skillsToDisable) {
      finalSkills.delete(skill);
    }
    if (finalSkills.size === 0) {
      throw new Error(
        "Error: All skills have been disabled. At least one skill must remain enabled.",
      );
    }
  }

  const resolvedOpenAiBaseUrl = input.openaiBaseUrl
    ? validateOpenAiBaseUrlThrows(input.openaiBaseUrl)
    : undefined;

  // Validate anthropic base URL if provided (same validation as OpenAI)
  const resolvedAnthropicBaseUrl = input.anthropicBaseUrl
    ? validateOpenAiBaseUrlThrows(input.anthropicBaseUrl)
    : undefined;

  // Validate agent provider if explicitly set
  let agentProvider:
    | "openai"
    | "azure-openai"
    | "anthropic"
    | "openrouter"
    | undefined = undefined;
  if (input.agentProvider) {
    const provider = input.agentProvider.toLowerCase();
    if (
      provider !== "openai" &&
      provider !== "azure-openai" &&
      provider !== "anthropic" &&
      provider !== "openrouter"
    ) {
      throw new Error(
        `Error: Invalid agent provider "${input.agentProvider}". Must be "openai", "azure-openai", "anthropic", or "openrouter".`,
      );
    }
    agentProvider = provider;
  }

  return {
    accessToken: input.accessToken,
    clientId: input.clientId || DEFAULT_SENTRY_CLIENT_ID,
    sentryHost,
    sentryProtocol,
    mcpUrl: input.mcpUrl,
    sentryDsn: input.sentryDsn,
    openaiBaseUrl: resolvedOpenAiBaseUrl,
    openaiModel: input.openaiModel,
    anthropicBaseUrl: resolvedAnthropicBaseUrl,
    anthropicModel: input.anthropicModel,
    agentProvider,
    finalSkills,
    organizationSlug: input.organizationSlug,
    projectSlug: input.projectSlug,
  };
}

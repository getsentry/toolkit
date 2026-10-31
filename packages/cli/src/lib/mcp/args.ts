/**
 * Argument and environment parsing for `sentry mcp` and `@sentry/mcp-server`.
 *
 * Both accept the flags and environment variables that `@sentry/mcp-server`
 * has always taken, so existing MCP client configurations keep working. Flags win
 * over environment values.
 */

/** `sentry mcp` flags, as Stricli parses them (see `commands/mcp.ts`). */
export type McpFlags = {
  readonly "access-token"?: string;
  readonly host?: string;
  readonly url?: string;
  readonly "insecure-http": boolean;
  readonly "mcp-url"?: string;
  readonly "sentry-dsn"?: string;
  readonly "openai-base-url"?: string;
  readonly "openai-model"?: string;
  readonly "anthropic-base-url"?: string;
  readonly "anthropic-model"?: string;
  readonly "agent-provider"?: string;
  readonly skills?: string;
  readonly "all-skills": boolean;
  readonly "disable-skills"?: string;
  readonly experimental: boolean;
  readonly "organization-slug"?: string;
  readonly "project-slug"?: string;
};

/**
 * Split `--flag=value` into `--flag value` where Stricli does not read the
 * joined form: an empty value (`--sentry-dsn=` turns off the server's
 * telemetry) or one with a line break (a token pasted with its newline).
 * MCP client configurations have always passed both to `@sentry/mcp-server`.
 */
export function splitInlineFlagValues(args: readonly string[]): string[] {
  return args.flatMap((arg) => {
    const match = /^(--[a-z][a-z-.\d_]*)=(.*)$/is.exec(arg);
    const [, flag, value] = match ?? [];
    return flag !== undefined &&
      value !== undefined &&
      (value === "" || /[\r\n]/.test(value))
      ? [flag, value]
      : [arg];
  });
}

/** Values read from the environment. */
export type McpEnvArgs = {
  accessToken?: string;
  mcpUrl?: string;
  sentryDsn?: string;
  openaiModel?: string;
  anthropicModel?: string;
  agentProvider?: string;
  skills?: string;
  disableSkills?: string;
};

/** Flags merged over environment values, before validation. */
export type McpMergedArgs = {
  accessToken?: string;
  host?: string;
  insecureHttp: boolean;
  url?: string;
  mcpUrl?: string;
  sentryDsn?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  agentProvider?: string;
  /** Whether `--agent-provider` (not the environment) chose the provider. */
  agentProviderFromFlag: boolean;
  skills?: string;
  allSkills: boolean;
  disableSkills?: string;
  experimental: boolean;
  organizationSlug?: string;
  projectSlug?: string;
};

/**
 * Read MCP settings from the environment.
 *
 * `SENTRY_HOST`/`SENTRY_URL` are not read here: `sentry mcp` translates the
 * CLI's configured URL into `--host`/`--url` flags before parsing.
 */
export function parseMcpEnv(env: NodeJS.ProcessEnv): McpEnvArgs {
  const fromEnv: McpEnvArgs = {};
  if (env.SENTRY_ACCESS_TOKEN) {
    fromEnv.accessToken = env.SENTRY_ACCESS_TOKEN;
  }
  if (env.MCP_URL) {
    fromEnv.mcpUrl = env.MCP_URL;
  }
  if (env.SENTRY_DSN || env.DEFAULT_SENTRY_DSN) {
    fromEnv.sentryDsn = env.SENTRY_DSN || env.DEFAULT_SENTRY_DSN;
  }
  if (env.OPENAI_MODEL) {
    fromEnv.openaiModel = env.OPENAI_MODEL;
  }
  if (env.ANTHROPIC_MODEL) {
    fromEnv.anthropicModel = env.ANTHROPIC_MODEL;
  }
  if (env.EMBEDDED_AGENT_PROVIDER) {
    fromEnv.agentProvider = env.EMBEDDED_AGENT_PROVIDER;
  }
  if (env.MCP_SKILLS) {
    fromEnv.skills = env.MCP_SKILLS;
  }
  if (env.MCP_DISABLE_SKILLS) {
    fromEnv.disableSkills = env.MCP_DISABLE_SKILLS;
  }
  return fromEnv;
}

/** Merge flags over environment values. */
export function mergeMcpArgs(flags: McpFlags, env: McpEnvArgs): McpMergedArgs {
  return {
    accessToken: flags["access-token"] ?? env.accessToken,
    url: flags.url,
    host: flags.host,
    insecureHttp: flags["insecure-http"],
    mcpUrl: flags["mcp-url"] ?? env.mcpUrl,
    sentryDsn: flags["sentry-dsn"] ?? env.sentryDsn,
    openaiBaseUrl: flags["openai-base-url"],
    openaiModel: flags["openai-model"] ?? env.openaiModel,
    anthropicBaseUrl: flags["anthropic-base-url"],
    anthropicModel: flags["anthropic-model"] ?? env.anthropicModel,
    agentProvider: flags["agent-provider"] ?? env.agentProvider,
    agentProviderFromFlag: flags["agent-provider"] !== undefined,
    // --skills and --all-skills both override MCP_SKILLS.
    skills: flags.skills ?? (flags["all-skills"] ? undefined : env.skills),
    allSkills: flags["all-skills"],
    disableSkills: flags["disable-skills"] ?? env.disableSkills,
    experimental: flags.experimental,
    organizationSlug: flags["organization-slug"],
    projectSlug: flags["project-slug"],
  };
}

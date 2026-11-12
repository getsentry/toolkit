/**
 * Argument and environment parsing for `sentry mcp` and `@sentry/mcp-server`.
 *
 * Both accept the flags and environment variables that `@sentry/mcp-server`
 * has always taken, so existing MCP client configurations keep working. Flags win
 * over environment values. The deprecated `--access-token` /
 * `SENTRY_ACCESS_TOKEN` are not read here: `serveMcp` maps them onto the CLI's
 * env token (see `lib/mcp.ts`).
 */

import { parseOrgProjectInput } from "../arg-parsing.js";
import { ValidationError } from "../errors.js";
import { validateResourceId } from "../input-validation.js";

/** `sentry mcp` flags, as Stricli parses them (see `commands/mcp.ts`). */
export type McpFlags = {
  readonly "access-token"?: string;
  /** Deprecated: `SENTRY_HOST`. */
  readonly host?: string;
  /** Deprecated: `SENTRY_URL`. */
  readonly url?: string;
  /** Deprecated: an `http://` `SENTRY_URL`. */
  readonly "insecure-http": boolean;
  readonly "mcp-url"?: string;
  readonly "openai-base-url"?: string;
  readonly "openai-model"?: string;
  readonly "anthropic-base-url"?: string;
  readonly "anthropic-model"?: string;
  readonly "agent-provider"?: string;
  readonly skills?: string;
  readonly "all-skills": boolean;
  readonly "disable-skills"?: string;
  readonly experimental: boolean;
  readonly org?: string;
  readonly project?: string;
  /** Deprecated alias of `--org`. */
  readonly "organization-slug"?: string;
  /** Deprecated alias of `--project`. */
  readonly "project-slug"?: string;
};

/** The organization, and optionally project, of a `sentry mcp` target. */
export type McpScope = {
  readonly org: string;
  readonly project?: string;
};

const TARGET_USAGE =
  "Pass <org>/ for an organization, or <org>/<project> for a project.";

/**
 * Parse the optional `[<org>/[<project>]]` positional of `sentry mcp`.
 *
 * Reads the target with the CLI's shared parser but takes only the forms that
 * name an organization: the server is scoped up front, with no project search
 * or auto-detection. A bare `<slug>` would be a project search to every other
 * command, so it is refused instead of read as an organization; under
 * `@sentry/mcp-server` it is also what an unknown command reaches. A URL is
 * refused too: the server's host comes from `SENTRY_HOST`/`SENTRY_URL`.
 *
 * @returns `undefined` for an empty target, which scopes nothing
 * @throws {ValidationError} For any other form
 */
export function parseMcpTarget(input: string): McpScope | undefined {
  const text = input.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    throw new ValidationError(
      `'${text}' is a URL. ${TARGET_USAGE} Set SENTRY_URL to pick the Sentry instance.`,
      "target",
    );
  }
  const { parsed } = parseOrgProjectInput(text);
  switch (parsed.type) {
    case "auto-detect":
      return;
    case "org-all":
      validateResourceId(parsed.org, "organization slug");
      return { org: parsed.org };
    case "explicit":
      if (/[/,]/.test(parsed.project)) {
        throw new ValidationError(
          `'${text}' names more than one project. ${TARGET_USAGE}`,
          "target",
        );
      }
      validateResourceId(parsed.org, "organization slug");
      validateResourceId(parsed.project, "project slug");
      return { org: parsed.org, project: parsed.project };
    case "project-search":
      throw new ValidationError(
        text.includes("/")
          ? `'${text}' has no organization. ${TARGET_USAGE}`
          : `'${text}' names no command, and a target needs an organization: pass '${text}/' for the organization, or '<org>/${text}' for a project.`,
        "target",
      );
  }
}

/**
 * Deprecated flags and what replaces each: a CLI-wide flag, or the
 * environment variable every other command reads the Sentry instance from.
 */
const DEPRECATED_FLAGS = [
  ["organization-slug", "--org"],
  ["project-slug", "--project"],
  ["host", "SENTRY_HOST"],
  ["url", "SENTRY_URL"],
  ["insecure-http", "an http:// SENTRY_URL"],
] as const;

/** The deprecated flags `flags` uses, with their replacements. */
export function deprecatedFlags(
  flags: McpFlags,
): { flag: string; replacement: string }[] {
  return DEPRECATED_FLAGS.filter(
    ([old]) => flags[old] !== undefined && flags[old] !== false,
  ).map(([flag, replacement]) => ({ flag, replacement }));
}

/**
 * A scope's value, from the target positional, the CLI-wide flag, or the
 * flag's deprecated alias. Any two of them must agree.
 */
function scopeFlag(
  flags: McpFlags,
  name: "org" | "project",
  alias: "organization-slug" | "project-slug",
  fromTarget: string | undefined,
): string | undefined {
  const value = flags[name];
  const aliased = flags[alias];
  if (value !== undefined && aliased !== undefined && value !== aliased) {
    throw new ValidationError(
      `--${name} and --${alias} name different values; pass only --${name}.`,
    );
  }
  const fromFlag = value ?? aliased;
  if (
    fromTarget !== undefined &&
    fromFlag !== undefined &&
    fromTarget !== fromFlag
  ) {
    const flag = value === undefined ? alias : name;
    throw new ValidationError(
      `The target and --${flag} name different values; pass only the target.`,
    );
  }
  return fromTarget ?? fromFlag;
}

/**
 * Split `--flag=value` into `--flag value` where Stricli does not read the
 * joined form: an empty value or one with a line break (a token pasted with
 * its newline). MCP client configurations have always passed both to
 * `@sentry/mcp-server`.
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
  mcpUrl?: string;
  openaiModel?: string;
  anthropicModel?: string;
  agentProvider?: string;
  skills?: string;
  disableSkills?: string;
};

/** Flags merged over environment values, before validation. */
export type McpMergedArgs = {
  host?: string;
  insecureHttp: boolean;
  url?: string;
  mcpUrl?: string;
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
  if (env.MCP_URL) {
    fromEnv.mcpUrl = env.MCP_URL;
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

/** Merge flags and the target positional over environment values. */
export function mergeMcpArgs(
  flags: McpFlags,
  env: McpEnvArgs,
  scope?: McpScope,
): McpMergedArgs {
  return {
    url: flags.url,
    host: flags.host,
    insecureHttp: flags["insecure-http"],
    mcpUrl: flags["mcp-url"] ?? env.mcpUrl,
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
    organizationSlug: scopeFlag(flags, "org", "organization-slug", scope?.org),
    projectSlug: scopeFlag(flags, "project", "project-slug", scope?.project),
  };
}

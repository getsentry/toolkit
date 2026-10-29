/**
 * Argument and environment parsing for `sentry mcp`.
 *
 * Accepts the same flags and environment variables as the retired
 * `@sentry/mcp-server` package, so existing MCP client configurations keep
 * working when they switch to `sentry mcp`. Flags win over environment values.
 */

import { parseArgs } from "node:util";

/** Values read from `sentry mcp` flags. */
export type McpCliArgs = {
  accessToken?: string;
  host?: string;
  insecureHttp?: boolean;
  url?: string;
  mcpUrl?: string;
  sentryDsn?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  agentProvider?: string;
  skills?: string;
  allSkills?: boolean;
  disableSkills?: string;
  experimental?: boolean;
  organizationSlug?: string;
  projectSlug?: string;
  help?: boolean;
  version?: boolean;
  unknownArgs: string[];
};

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
export type McpMergedArgs = Omit<McpCliArgs, "help" | "version"> & {
  /** Whether `--agent-provider` (not the environment) chose the provider. */
  agentProviderFromFlag: boolean;
};

const OPTIONS = {
  "access-token": { type: "string" },
  host: { type: "string" },
  "insecure-http": { type: "boolean" },
  url: { type: "string" },
  "mcp-url": { type: "string" },
  "sentry-dsn": { type: "string" },
  "openai-base-url": { type: "string" },
  "openai-model": { type: "string" },
  "anthropic-base-url": { type: "string" },
  "anthropic-model": { type: "string" },
  "agent-provider": { type: "string" },
  "organization-slug": { type: "string" },
  "project-slug": { type: "string" },
  skills: { type: "string" },
  "all-skills": { type: "boolean" },
  "disable-skills": { type: "string" },
  experimental: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** `parseArgs` reports known short flags under their long name. */
const KNOWN_OPTIONS = new Set<string>(Object.keys(OPTIONS));

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse `sentry mcp` flags, collecting unknown flags and positionals. */
export function parseMcpArgv(argv: string[]): McpCliArgs {
  const { values, tokens } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const unknownArgs: string[] = [];
  for (const token of tokens) {
    if (token.kind === "option" && !KNOWN_OPTIONS.has(token.name)) {
      unknownArgs.push(token.rawName);
    } else if (token.kind === "positional") {
      unknownArgs.push(token.value);
    }
  }

  return {
    accessToken: stringValue(values["access-token"]),
    host: stringValue(values.host),
    insecureHttp: values["insecure-http"] === true,
    url: stringValue(values.url),
    mcpUrl: stringValue(values["mcp-url"]),
    sentryDsn: stringValue(values["sentry-dsn"]),
    openaiBaseUrl: stringValue(values["openai-base-url"]),
    openaiModel: stringValue(values["openai-model"]),
    anthropicBaseUrl: stringValue(values["anthropic-base-url"]),
    anthropicModel: stringValue(values["anthropic-model"]),
    agentProvider: stringValue(values["agent-provider"]),
    organizationSlug: stringValue(values["organization-slug"]),
    projectSlug: stringValue(values["project-slug"]),
    skills: stringValue(values.skills),
    allSkills: values["all-skills"] === true,
    disableSkills: stringValue(values["disable-skills"]),
    experimental: values.experimental === true,
    help: values.help === true,
    version: values.version === true,
    unknownArgs,
  };
}

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
export function mergeMcpArgs(cli: McpCliArgs, env: McpEnvArgs): McpMergedArgs {
  return {
    accessToken: cli.accessToken ?? env.accessToken,
    url: cli.url,
    host: cli.host,
    insecureHttp: cli.insecureHttp === true,
    mcpUrl: cli.mcpUrl ?? env.mcpUrl,
    sentryDsn: cli.sentryDsn ?? env.sentryDsn,
    openaiBaseUrl: cli.openaiBaseUrl,
    openaiModel: cli.openaiModel ?? env.openaiModel,
    anthropicBaseUrl: cli.anthropicBaseUrl,
    anthropicModel: cli.anthropicModel ?? env.anthropicModel,
    agentProvider: cli.agentProvider ?? env.agentProvider,
    agentProviderFromFlag: cli.agentProvider !== undefined,
    // --skills and --all-skills both override MCP_SKILLS.
    skills: cli.skills ?? (cli.allSkills ? undefined : env.skills),
    allSkills: cli.allSkills === true,
    disableSkills: cli.disableSkills ?? env.disableSkills,
    experimental: cli.experimental === true,
    organizationSlug: cli.organizationSlug,
    projectSlug: cli.projectSlug,
    unknownArgs: cli.unknownArgs,
  };
}

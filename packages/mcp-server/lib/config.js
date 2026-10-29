/**
 * Flag and environment handling for the `@sentry/mcp-server` stdio proxy.
 *
 * The proxy accepts the flags of the original `@sentry/mcp-server` CLI and
 * maps the ones the hosted Sentry MCP supports onto its URL. Flags that only
 * make sense for a local server fail with an error that points to
 * `npx -y sentry mcp`, which still runs the tools locally.
 */
import { parseArgs } from "node:util";

const DEFAULT_MCP_URL = "https://mcp.sentry.dev";

const LOCAL_SERVER_HINT =
  "Run `npx -y sentry mcp` instead; it runs the Sentry MCP tools locally and accepts the same flags.";

const OPTIONS = {
  "access-token": { type: "string" },
  host: { type: "string" },
  url: { type: "string" },
  "mcp-url": { type: "string" },
  "insecure-http": { type: "boolean" },
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
};

/** Flags that configure the local embedded agent, which the hosted MCP owns. */
const LOCAL_AGENT_FLAGS = [
  "agent-provider",
  "openai-base-url",
  "openai-model",
  "anthropic-base-url",
  "anthropic-model",
];

/** Environment variables of the local embedded agent; ignored by the proxy. */
const LOCAL_AGENT_ENV = [
  "EMBEDDED_AGENT_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_REASONING_EFFORT",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A user-facing configuration error; the bin prints it and exits 1. */
export class UsageError extends Error {}

/**
 * @typedef {object} ProxyConfig
 * @property {"run"} kind
 * @property {URL} endpoint Hosted MCP endpoint, including constraints and options
 * @property {string} accessToken
 * @property {string[]} warnings Diagnostics for stderr
 */

/**
 * Resolve what the bin should do from argv and the environment.
 *
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {{ kind: "help" } | { kind: "version" } | ProxyConfig}
 * @throws {UsageError}
 */
export function resolveConfig(argv, env) {
  if (argv[0] === "auth") {
    throw new UsageError(
      "@sentry/mcp-server has no login of its own. Pass a Sentry User Auth Token with --access-token or SENTRY_ACCESS_TOKEN, or run `npx -y sentry auth login` and configure your MCP client to run `npx -y sentry mcp`.",
    );
  }

  const { values, tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const unknown = tokens.flatMap((token) => {
    if (token.kind === "positional") return [token.value];
    if (token.kind === "option" && !Object.hasOwn(OPTIONS, token.name)) {
      return [token.rawName];
    }
    return [];
  });
  if (unknown.length > 0) {
    throw new UsageError(
      `Invalid argument(s): ${unknown.join(", ")}\nRun \`sentry-mcp --help\` for usage.`,
    );
  }

  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  /** @param {string} name */
  const flag = (name) => {
    const value = values[name];
    if (value === true && OPTIONS[name].type === "string") {
      throw new UsageError(`--${name} requires a value.`);
    }
    return typeof value === "string" ? value : undefined;
  };

  for (const name of LOCAL_AGENT_FLAGS) {
    if (flag(name) !== undefined) {
      throw new UsageError(
        `--${name} is not supported: @sentry/mcp-server forwards to the hosted Sentry MCP, which uses its own embedded agent. ${LOCAL_SERVER_HINT}`,
      );
    }
  }

  assertHostedSentryHost({
    url: flag("url") ?? env.SENTRY_URL,
    host: flag("host") ?? env.SENTRY_HOST,
    insecureHttp: values["insecure-http"] === true,
  });

  const accessToken = (flag("access-token") ?? env.SENTRY_ACCESS_TOKEN)?.trim();
  if (!accessToken) {
    throw new UsageError(
      [
        "No Sentry access token. @sentry/mcp-server forwards to the hosted Sentry MCP and needs a User Auth Token:",
        "  pass --access-token=<token> or set SENTRY_ACCESS_TOKEN.",
        "Create one at https://sentry.io/settings/account/api/auth-tokens/ (scopes: org:read, project:read, project:write, team:read, team:write, event:write).",
        "To use your `sentry auth login` session instead, configure your MCP client to run `npx -y sentry mcp`.",
      ].join("\n"),
    );
  }

  const warnings = [];
  if (flag("sentry-dsn") !== undefined) {
    warnings.push(
      "--sentry-dsn is ignored: the hosted Sentry MCP reports its own telemetry.",
    );
  }
  const agentEnv = LOCAL_AGENT_ENV.filter((name) => env[name]);
  if (agentEnv.length > 0) {
    warnings.push(
      `Ignoring ${agentEnv.join(", ")}: the hosted Sentry MCP uses its own embedded agent. ${LOCAL_SERVER_HINT}`,
    );
  }

  return {
    kind: "run",
    endpoint: buildEndpoint({
      mcpUrl: flag("mcp-url") ?? env.MCP_URL,
      organizationSlug: flag("organization-slug"),
      projectSlug: flag("project-slug"),
      skills: selectSkills(
        flag("skills"),
        values["all-skills"] === true,
        env.MCP_SKILLS,
      ),
      disableSkills: flag("disable-skills") ?? env.MCP_DISABLE_SKILLS,
      experimental: values.experimental === true,
    }),
    accessToken,
    warnings,
  };
}

/**
 * Whether the hosted MCP can serve `hostname`. It only talks to sentry.io,
 * which also routes regional (`us.`, `de.`) and organization subdomains.
 *
 * @param {string} hostname
 */
export function isHostedSentryHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "sentry.io" || host.endsWith(".sentry.io");
}

/**
 * Reject Sentry hosts the hosted MCP cannot reach, such as self-hosted Sentry.
 * `--url`/`SENTRY_URL` wins over `--host`/`SENTRY_HOST`, as in the old CLI.
 *
 * @param {{ url?: string, host?: string, insecureHttp: boolean }} input
 */
function assertHostedSentryHost({ url, host, insecureHttp }) {
  let hostname = host;
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new UsageError(`Invalid Sentry URL: ${url}`);
    }
    hostname = parsed.protocol === "https:" ? parsed.host : url;
  }
  const reason = insecureHttp
    ? "--insecure-http only applies to self-hosted Sentry"
    : hostname && !isHostedSentryHost(hostname)
      ? `cannot reach ${hostname}`
      : undefined;
  if (reason) {
    throw new UsageError(
      `@sentry/mcp-server only connects to sentry.io through the hosted Sentry MCP; ${reason}. For self-hosted Sentry, run \`npx -y sentry mcp\` with the same flags; it runs the tools locally against any host.`,
    );
  }
}

/**
 * Apply the old CLI's skill precedence: `--skills` beats `--all-skills`,
 * which beats `MCP_SKILLS`. `undefined` means the hosted default (all
 * active skills, the same set as `--all-skills`).
 *
 * @param {string | undefined} skills
 * @param {boolean} allSkills
 * @param {string | undefined} envSkills
 */
function selectSkills(skills, allSkills, envSkills) {
  if (skills !== undefined && allSkills) {
    throw new UsageError("--all-skills cannot be combined with --skills.");
  }
  return allSkills ? undefined : (skills ?? envSkills);
}

/**
 * Build the hosted MCP endpoint. Constraints are path segments
 * (`/mcp/<org>/<project>`); skills and experimental mode are query
 * parameters the hosted MCP validates.
 *
 * @param {{
 *   mcpUrl?: string,
 *   organizationSlug?: string,
 *   projectSlug?: string,
 *   skills?: string,
 *   disableSkills?: string,
 *   experimental: boolean,
 * }} input
 * @returns {URL}
 */
function buildEndpoint({
  mcpUrl = DEFAULT_MCP_URL,
  organizationSlug,
  projectSlug,
  skills,
  disableSkills,
  experimental,
}) {
  let endpoint;
  try {
    endpoint = new URL(mcpUrl);
  } catch {
    throw new UsageError(`Invalid MCP URL: ${mcpUrl}`);
  }
  const isLoopback =
    endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !isLoopback) {
    throw new UsageError(
      `The MCP URL must use https:// (http:// is allowed for localhost only): ${mcpUrl}`,
    );
  }

  if (projectSlug && !organizationSlug) {
    throw new UsageError("--project-slug requires --organization-slug.");
  }
  const base = endpoint.pathname.replace(/\/+$/, "");
  const segments = [base.endsWith("/mcp") ? base : `${base}/mcp`];
  for (const slug of [organizationSlug, projectSlug]) {
    if (slug) segments.push(encodeURIComponent(slug));
  }
  endpoint.pathname = segments.join("/");

  for (const [name, list] of [
    ["skills", skills],
    ["disable-skills", disableSkills],
  ]) {
    if (list === undefined) continue;
    const entries = list
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      throw new UsageError(`--${name} must list at least one skill.`);
    }
    endpoint.searchParams.set(name, entries.join(","));
  }
  if (experimental) {
    endpoint.searchParams.set("experimental", "1");
  }
  return endpoint;
}

/**
 * @param {string} version
 * @returns {string}
 */
export function buildUsage(version) {
  return `@sentry/mcp-server ${version}: stdio proxy to the hosted Sentry MCP (sentry.io only)

Usage: sentry-mcp --access-token=<token> [options]

Authentication:
  --access-token <token>      Sentry User Auth Token (or SENTRY_ACCESS_TOKEN)

Session constraints:
  --organization-slug <slug>  Force all calls to an organization
  --project-slug <slug>       Optional project constraint (needs --organization-slug)

Skill controls:
  --skills <list>             Grant only these skills (or MCP_SKILLS)
  --all-skills                Grant all active skills (the default)
  --disable-skills <list>     Remove skills (or MCP_DISABLE_SKILLS)
  --experimental              Enable experimental tools

Other:
  --mcp-url <url>             Hosted MCP origin (or MCP_URL; default ${DEFAULT_MCP_URL})
  -h, --help                  Show this help
  -v, --version               Show the version

Self-hosted Sentry, your own LLM provider, and \`sentry auth login\` need the
local server instead:

  npx -y sentry mcp`;
}

/**
 * Environment Variable Registry
 *
 * Centralized metadata catalog for all environment variables recognized
 * by the CLI. Used by doc generators to produce configuration.md — NOT
 * used at runtime for env var access (existing `getEnv()` patterns remain).
 */

/** Metadata for a single environment variable */
export type EnvVarEntry = {
  /** Variable name (e.g., "SENTRY_AUTH_TOKEN") */
  name: string;
  /** Multi-sentence description (markdown OK). Rendered as body text under the heading. */
  description: string;
  /** Example value shown in a bash code block. If omitted, no code block is generated. */
  example?: string;
  /** Default value, mentioned in the description when provided. */
  defaultValue?: string;
  /** Install-script-only variable (not used at runtime by the CLI binary). */
  installOnly?: boolean;
  /**
   * Surface this variable in the branded `sentry --help` output (and in the
   * `envVars` array of `sentry help --json`). Reserve for the highest-signal
   * variables — the full list lives in `configuration.md`.
   */
  topLevel?: boolean;
  /** Short one-line description used in the branded help summary. Falls back to `description` when absent. */
  briefDescription?: string;
  /** Include in the self-hosted.md env var table. */
  selfHosted?: boolean;
  /** Include in the DEVELOPMENT.md env var table. One-line description for the table cell. */
  devGuide?: string;
};

/**
 * All user-facing environment variables recognized by the Sentry CLI.
 *
 * Ordered by documentation priority: auth → targeting → URL → paths →
 * install → display → logging/telemetry → cache/pagination → database.
 * The generator preserves this order in the output.
 */
export const ENV_VAR_REGISTRY: readonly EnvVarEntry[] = [
  // -- Auth --
  {
    name: "SENTRY_AUTH_TOKEN",
    description:
      "Authentication token for the Sentry API. This is the primary way to authenticate in CI/CD pipelines and scripts where interactive login is not possible.\n\nYou can create auth tokens in your [Sentry account settings](https://sentry.io/settings/account/api/auth-tokens/). When a stored OAuth login from `sentry auth login` also exists, the stored login takes priority — set `SENTRY_FORCE_ENV_TOKEN=1` to override.",
    example: "sntrys_YOUR_TOKEN_HERE",
    topLevel: true,
    briefDescription: "Auth token used for API requests (CI, scripts).",
    devGuide:
      "API token for non-interactive use (lower priority than stored OAuth by default)",
  },
  {
    name: "SENTRY_TOKEN",
    description:
      "Legacy alias for `SENTRY_AUTH_TOKEN`. If both are set, `SENTRY_AUTH_TOKEN` takes precedence.",
  },
  {
    name: "SENTRY_FORCE_ENV_TOKEN",
    description:
      "When set, environment variable tokens (`SENTRY_AUTH_TOKEN` / `SENTRY_TOKEN`) take precedence over the stored OAuth token from `sentry auth login`. By default, the stored OAuth token takes priority because it supports automatic refresh. Set this if you want to ensure the environment variable token is always used, which is useful for self-hosted setups or CI environments.",
    example: "1",
    topLevel: true,
    briefDescription: "Prefer the env-var token over a stored OAuth login.",
    selfHosted: true,
    devGuide: "Force env token to take priority over stored OAuth token",
  },
  // -- Targeting --
  {
    name: "SENTRY_ORG",
    description:
      "Default organization slug. Skips organization auto-detection.",
    example: "my-org",
    topLevel: true,
    briefDescription: "Default organization slug.",
    selfHosted: true,
  },
  {
    name: "SENTRY_PROJECT",
    description:
      "Default project slug. Can also include the org in `org/project` format.\n\nWhen using the `org/project` combo format, `SENTRY_ORG` is ignored.",
    example: "my-org/my-project",
    topLevel: true,
    briefDescription: "Default project slug (or `org/project`).",
    selfHosted: true,
  },
  {
    name: "SENTRY_DSN",
    description:
      "Sentry DSN for project auto-detection. This is the same DSN you use in `Sentry.init()`. The CLI resolves it to determine your organization and project.\n\nThe CLI also detects DSNs from `.env` files and source code automatically — see [DSN Auto-Detection](./features/#dsn-auto-detection).",
    example: "https://key@o123.ingest.us.sentry.io/456",
    topLevel: true,
    briefDescription: "DSN used to auto-detect org + project.",
  },
  // -- Release --
  {
    name: "SENTRY_RELEASE",
    description:
      "Explicit release version for `sentry release propose-version`. When set, " +
      "the command returns this value immediately without checking CI environment " +
      "variables or local git history. Useful in CI pipelines where the release " +
      "version is determined by a prior step.",
    example: "1.0.0",
  },
  // -- URL --
  {
    name: "SENTRY_HOST",
    description:
      "Base URL of your Sentry instance. **Only needed for [self-hosted Sentry](./self-hosted/).** SaaS users (sentry.io) should not set this.\n\nWhen set, all API requests (including OAuth login) are directed to this URL instead of `https://sentry.io`. The CLI also sets this automatically when you pass a self-hosted Sentry URL as a command argument.\n\n`SENTRY_HOST` takes precedence over `SENTRY_URL`. Both work identically — use whichever you prefer.",
    example: "https://sentry.example.com",
    defaultValue: "https://sentry.io",
    topLevel: true,
    briefDescription: "Base URL of your Sentry instance (self-hosted).",
    selfHosted: true,
    devGuide: "Sentry instance URL (for self-hosted, takes precedence)",
  },
  {
    name: "SENTRY_URL",
    description:
      "Alias for `SENTRY_HOST`. If both are set, `SENTRY_HOST` takes precedence.",
    defaultValue: "https://sentry.io",
    selfHosted: true,
    devGuide: "Alias for `SENTRY_HOST`",
  },
  {
    name: "SENTRY_CLIENT_ID",
    description:
      "Client ID of a public OAuth application on your Sentry instance. **Required for [self-hosted Sentry](./self-hosted/)** (26.1.0+) to use `sentry auth login` with the device flow. See the [Self-Hosted guide](./self-hosted/#1-create-a-public-oauth-application) for how to create one.",
    example: "your-oauth-client-id",
    selfHosted: true,
    devGuide: "Sentry OAuth app client ID",
  },
  // -- Custom headers --
  {
    name: "SENTRY_CUSTOM_HEADERS",
    description:
      "Custom HTTP headers to include in all requests to your Sentry instance. " +
      "**Only applies to [self-hosted Sentry](./self-hosted/).** Ignored when targeting sentry.io.\n\n" +
      "Use semicolon-separated `Name: Value` pairs. Useful for environments behind " +
      "reverse proxies that require additional headers for authentication " +
      "(e.g., Google IAP, Cloudflare Access).\n\n" +
      "Can also be set persistently with `sentry cli defaults headers`.",
    example: '"X-IAP-Token: my-proxy-token"',
    selfHosted: true,
  },
  // -- Paths --
  {
    name: "SENTRY_CONFIG_DIR",
    description:
      "Override the directory where the CLI stores its database (credentials, caches, defaults). Follows the [XDG Base Directory specification](https://specifications.freedesktop.org/basedir/latest/): defaults to `$XDG_CONFIG_HOME/sentry/` (i.e. `~/.config/sentry/` when `XDG_CONFIG_HOME` is unset). For backward compatibility, a pre-existing legacy `~/.sentry/` directory that contains `cli.db` is still used.",
    example: "/path/to/config",
    defaultValue: "~/.config/sentry/",
    devGuide:
      "Override credentials/cache directory (XDG default: ~/.config/sentry/)",
  },
  {
    name: "SENTRY_INSTALL_DIR",
    description:
      "Override the directory where the CLI binary is installed. Used by the install script and `sentry cli upgrade` to control the binary location.",
    example: "/usr/local/bin",
    installOnly: true,
  },
  // -- Install --
  {
    name: "SENTRY_VERSION",
    description:
      "Pin a specific version for the [install script](./getting-started/#install-script). Accepts a version number (e.g., `0.40.0`) or `nightly`. The `--version` flag takes precedence if both are set.\n\nThis is useful in CI/CD pipelines and Dockerfiles where you want reproducible installations without inline flags.",
    example: "nightly",
    installOnly: true,
  },
  {
    name: "SENTRY_INIT",
    description:
      "Used with the install script. When set to `1`, the installer runs `sentry init` after installing the binary to guide you through project setup.",
    example: "1",
    installOnly: true,
  },
  // -- Init wizard --
  {
    name: "SENTRY_INIT_TUI",
    description:
      "Control the TUI (terminal user interface) for `sentry init`. Set to `0` to disable the interactive TUI and use plain text logging output instead. Useful in CI/CD pipelines or environments without full terminal support.",
    example: "0",
  },
  // -- TLS / Certificates --
  {
    name: "NODE_EXTRA_CA_CERTS",
    description:
      "Path to a PEM file containing additional CA certificates to trust. " +
      "Useful behind corporate TLS-intercepting proxies (Zscaler, Netskope, etc.).\n\n" +
      "Can also be set persistently with `sentry cli defaults ca-cert`.",
    example: "/path/to/corporate-ca.pem",
    selfHosted: true,
  },
  // -- Display --
  {
    name: "SENTRY_PLAIN_OUTPUT",
    description:
      "Force plain text output (no colors or ANSI formatting). Takes precedence over `NO_COLOR`.",
    example: "1",
  },
  {
    name: "SENTRY_NO_GRAPHICS",
    description:
      "Disable inline terminal graphics (kitty and sixel) on terminals that support them; the banner falls back to block art, and image attachments printed by `sentry api` are written as raw bytes instead of rendered inline. You can also set this persistently with `sentry cli defaults graphics off`.",
    example: "1",
  },
  {
    name: "SENTRY_NO_SIXEL",
    description:
      "Deprecated alias for `SENTRY_NO_GRAPHICS`. Still honored for backward compatibility.",
    example: "1",
  },
  {
    name: "NO_COLOR",
    description:
      "Standard convention to disable color output. See [no-color.org](https://no-color.org/). Respected when `SENTRY_PLAIN_OUTPUT` is not set.",
    example: "1",
    topLevel: true,
    briefDescription: "Disable colored output (no-color.org convention).",
  },
  {
    name: "FORCE_COLOR",
    description:
      "Force color output on interactive terminals. Only takes effect when stdout is a TTY. Set to `0` to force plain output, `1` to force color. Ignored when stdout is piped.",
    example: "1",
  },
  {
    name: "SENTRY_OUTPUT_FORMAT",
    description:
      "Force the output format for all commands. Currently only `json` is supported. This is primarily used by the [library API](./library-usage/) (`createSentrySDK()`) to get JSON output without passing `--json` flags.",
    example: "json",
  },
  // -- Logging & telemetry --
  {
    name: "SENTRY_LOG_LEVEL",
    description:
      "Controls the verbosity of diagnostic output. Defaults to `info`.\n\nValid values: `error`, `warn`, `log`, `info`, `debug`, `trace`\n\nEquivalent to passing `--log-level debug` on the command line. CLI flags take precedence over the environment variable.",
    example: "debug",
    defaultValue: "info",
    topLevel: true,
    briefDescription: "Log verbosity (error, warn, info, debug, trace).",
    devGuide:
      "Diagnostic log level (`error`, `warn`, `log`, `info`, `debug`, `trace`)",
  },
  {
    name: "SENTRY_CLI_NO_TELEMETRY",
    description:
      "Disable CLI telemetry (error tracking for the CLI itself). The CLI sends anonymized error reports to help improve reliability — set this to opt out.",
    example: "1",
    devGuide: "Disable CLI telemetry (error tracking)",
  },
  {
    name: "DO_NOT_TRACK",
    description:
      "Industry-standard opt-out for telemetry. When set to `1`, the CLI disables all telemetry, equivalent to `SENTRY_CLI_NO_TELEMETRY=1`.",
    example: "1",
  },
  {
    name: "SENTRY_PIPELINE",
    description:
      "Identifies the Sentry build plugin that invoked the CLI (e.g., `sentry-webpack-plugin/3.0.0`). Used internally by `sentry build upload` to attribute uploads to the correct plugin. You typically don't need to set this manually — it is set automatically by Sentry build integrations.",
  },
  {
    name: "SENTRY_CLI_NO_UPDATE_CHECK",
    description:
      "Disable the automatic update check that runs periodically in the background.",
    example: "1",
  },
  // -- Cache & pagination --
  {
    name: "SENTRY_NO_CACHE",
    description:
      "Disable API response caching. When set, the CLI will not cache API responses and will always make fresh requests.",
    example: "1",
  },
  {
    name: "SENTRY_MAX_PAGINATION_PAGES",
    description:
      "Cap the maximum number of pages fetched during auto-pagination. Useful for limiting API calls when using large `--limit` values.",
    example: "10",
    defaultValue: "50",
  },
  // -- Database --
  {
    name: "SENTRY_CLI_NO_AUTO_REPAIR",
    description:
      "Disable automatic database schema repair. By default, the CLI automatically repairs its SQLite database when it detects schema drift. Set this to `1` to prevent auto-repair.",
    example: "1",
  },
];

/**
 * Subset of env vars surfaced in the branded `sentry --help` output and in
 * the `envVars` array of `sentry help --json`.
 *
 * Order is preserved from {@link ENV_VAR_REGISTRY}.
 */
export const TOP_LEVEL_ENV_VARS: readonly EnvVarEntry[] =
  ENV_VAR_REGISTRY.filter((entry) => entry.topLevel);

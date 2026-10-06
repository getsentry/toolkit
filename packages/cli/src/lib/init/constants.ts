export const DEFAULT_MASTRA_API_URL =
  "https://sentry-init-agent.getsentry.workers.dev";

export const MASTRA_API_URL =
  process.env.MASTRA_API_URL ?? DEFAULT_MASTRA_API_URL;

export const WORKFLOW_ID = "sentry-wizard";

export const INIT_PROTOCOL_VERSION = 1 as const;
export const INIT_REQUEST_CONFLICT_CODE = "init_request_conflict" as const;

export const SENTRY_DOCS_URL = "https://docs.sentry.io/platforms/";

/** Command that installs the Sentry coding-agent plugin (skills) into detected agents. */
export const SENTRY_AGENT_INSTALL_COMMAND = "npx @sentry/ai install";

export const MAX_FILE_BYTES = 262_144; // 256KB per file
export const MAX_OUTPUT_BYTES = 65_536; // 64KB stdout/stderr truncation
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000; // 2 minutes
export const API_TIMEOUT_MS = 210_000; // 3.5 minutes timeout for Mastra API calls

// Exit codes returned by the remote workflow.
// These are internal to the workflow protocol — they're mapped to EXIT.*
// constants (from src/lib/errors.ts) before reaching process exit.
export const EXIT_PLATFORM_NOT_DETECTED = 20;
export const EXIT_DEPENDENCY_INSTALL_FAILED = 30;
export const EXIT_VERIFICATION_FAILED = 50;

// Step ID used in dry-run special-case logic
export const VERIFY_CHANGES_STEP = "verify-changes";

// The feature that is always included in every setup
export const REQUIRED_FEATURE = "errorMonitoring";

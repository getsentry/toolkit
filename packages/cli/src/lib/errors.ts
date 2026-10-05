/**
 * CLI Error Hierarchy
 *
 * Unified error classes for consistent error handling across the CLI.
 *
 * ## Exit Code Ranges
 *
 * Each error class maps to a semantic exit code so scripts and agents can
 * react to failure categories without parsing stderr. Codes are grouped
 * into decades inspired by HTTP status semantics:
 *
 * | Range | Category          | HTTP Analogy         |
 * |-------|-------------------|----------------------|
 * | 0     | Success           | 200 OK               |
 * | 1     | General error     | 500 Internal         |
 * | 10–19 | Auth & identity   | 401/403              |
 * | 20–29 | Input & config    | 400/404/422          |
 * | 30–39 | API & network     | 502/503/504          |
 * | 40–49 | Feature/billing   | 402/451              |
 * | 50–59 | Operations        | —                    |
 * | 60–69 | Command-specific  | —                    |
 *
 * @see https://cli.sentry.dev/exit-codes/ for full reference
 */

import { redactCredentialText } from "./credential-redaction.js";
import {
  buildBillingUrl,
  buildOrgSettingsUrl,
  buildSeerSettingsUrl,
} from "./sentry-urls.js";

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

/**
 * Semantic exit codes for all CLI error classes.
 *
 * Grouped into decades so scripts can match on ranges:
 * `if code >= 10 && code < 20 → auth problem`.
 *
 * All codes stay below 128 to avoid collision with Unix signal exits (128+N).
 */
export const EXIT = {
  /** Catch-all for unexpected errors */
  GENERAL: 1,

  // 10–19: Auth & identity (HTTP 401/403 family)
  /** Not authenticated — run `sentry auth login` */
  AUTH_NOT_AUTHENTICATED: 10,
  /** Token expired — re-authenticate */
  AUTH_EXPIRED: 11,
  /** Token invalid / rejected */
  AUTH_INVALID: 12,
  /** Request blocked by host-scope trust check */
  AUTH_HOST_SCOPE: 13,

  // 20–29: Input & config (HTTP 400/404/422 family)
  /** Configuration or DSN error */
  CONFIG: 20,
  /** Input validation failed */
  VALIDATION: 21,
  /** Required context (org, project, etc.) missing */
  CONTEXT_MISSING: 22,
  /** User-provided value could not be resolved */
  RESOLUTION: 23,

  // 30–39: API & network (HTTP 502/503/504 family)
  /** Sentry API returned an error */
  API: 30,
  /** Operation timed out */
  TIMEOUT: 31,

  // 40–49: Feature / billing (HTTP 402/451 family)
  /** Seer not enabled for the organization */
  SEER_NOT_ENABLED: 40,
  /** Seer requires a paid plan */
  SEER_NO_BUDGET: 41,
  /** AI features disabled by org admin */
  SEER_AI_DISABLED: 42,

  // 50–59: Operations
  /** CLI upgrade failed */
  UPGRADE: 50,
  /** OAuth device flow error */
  DEVICE_FLOW: 51,

  // 60–69: Command-specific
  /** Command produced output but should exit non-zero */
  OUTPUT_ERROR: 60,
  /** Init wizard error (generic) */
  WIZARD: 61,
  /** Init wizard: dependency installation failed */
  WIZARD_DEPS: 62,
  /** Init wizard: codemod plan or apply failed */
  WIZARD_CODEMOD: 63,
  /** Init wizard: user stopped after verification */
  WIZARD_VERIFY: 64,
} as const;

/**
 * Base class for all CLI errors.
 *
 * @param message - Error message for display
 * @param exitCode - Process exit code (default: 1)
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.GENERAL) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }

  /**
   * Format error for user display. Override in subclasses to add details.
   */
  format(): string {
    return this.message;
  }
}

/**
 * Host-scoping trust violation — thrown by the fetch-layer and entry-point
 * guards when a request's destination doesn't match the active token's
 * scoped host.
 *
 * Distinct from plain `CliError` so that `withAuthGuard` can re-throw these
 * (like `AuthError`) while still swallowing `ApiError` and other transient
 * failures.
 *
 * Two construction forms:
 * - `new HostScopeError(source, destinationUrl, tokenHost)` — standard
 *   mismatch message used by most guard sites.
 * - `new HostScopeError(message)` — freeform message for the login-command
 *   refusal (different shape: "confirm with --url", not a mismatch).
 */
export class HostScopeError extends CliError {
  constructor(
    sourceOrMessage: string,
    destinationUrl?: string,
    tokenHost?: string | undefined
  ) {
    if (destinationUrl === undefined) {
      super(sourceOrMessage, EXIT.AUTH_HOST_SCOPE);
    } else if (tokenHost === undefined) {
      super(
        `${sourceOrMessage}: ${destinationUrl}\n` +
          "Refusing to route requests to this host because no Sentry credentials are configured for it.\n" +
          `To use this host, run: sentry auth login --url ${destinationUrl}`,
        EXIT.AUTH_HOST_SCOPE
      );
    } else {
      super(
        `${sourceOrMessage}: ${destinationUrl}\n` +
          `Refusing to route requests here because it doesn't match the host your Sentry credentials are for (${tokenHost}).\n` +
          `To use this host, run: sentry auth login --url ${destinationUrl}\n` +
          "To keep using your current credentials, remove this URL override.",
        EXIT.AUTH_HOST_SCOPE
      );
    }
    this.name = "HostScopeError";
  }
}

/**
 * API request errors from Sentry.
 *
 * @param message - Error summary
 * @param status - HTTP status code
 * @param detail - Detailed error message from API response
 * @param endpoint - API endpoint that failed
 */
export class ApiError extends CliError {
  readonly status: number;
  readonly detail?: string;
  readonly endpoint?: string;

  /**
   * Set by centralized 403 enrichment in `infrastructure.ts`.
   * Command-layer code can check this to avoid double-enriching
   * the error detail with scope/token hints.
   */
  readonly enriched403: boolean;

  // biome-ignore lint/nursery/useMaxParams: established 4-param shape; enriched403 is a defaulted extension
  constructor(
    message: string,
    status: number,
    detail?: string,
    endpoint?: string,
    enriched403 = false
  ) {
    super(message, EXIT.API);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.endpoint = endpoint;
    this.enriched403 = enriched403;
  }

  override format(): string {
    let msg = this.message;
    if (this.endpoint) {
      msg += `\n  Endpoint: ${this.endpoint}`;
    }
    if (this.detail && this.detail !== this.message) {
      msg += `\n  ${this.detail}`;
    }
    return msg;
  }
}

export type AuthErrorReason = "not_authenticated" | "expired" | "invalid";

/** Options for AuthError */
export type AuthErrorOptions = {
  /** Skip auto-login flow when this error is caught (for auth commands) */
  skipAutoAuth?: boolean;
};

/**
 * Authentication errors.
 *
 * @param reason - Type of auth failure
 * @param message - Custom message (uses default if not provided)
 * @param options - Additional options (e.g., skipAutoAuth for auth commands)
 */
export class AuthError extends CliError {
  readonly reason: AuthErrorReason;
  /** When true, the auto-login flow should not be triggered for this error */
  readonly skipAutoAuth: boolean;

  constructor(
    reason: AuthErrorReason,
    message?: string,
    options?: AuthErrorOptions
  ) {
    const defaultMessages: Record<AuthErrorReason, string> = {
      not_authenticated: "Not authenticated. Run 'sentry auth login' first.",
      expired:
        "Authentication expired. Run 'sentry auth login' to re-authenticate.",
      invalid: "Invalid authentication token.",
    };
    const exitCodes: Record<AuthErrorReason, number> = {
      not_authenticated: EXIT.AUTH_NOT_AUTHENTICATED,
      expired: EXIT.AUTH_EXPIRED,
      invalid: EXIT.AUTH_INVALID,
    };
    super(message ?? defaultMessages[reason], exitCodes[reason]);
    this.name = "AuthError";
    this.reason = reason;
    this.skipAutoAuth = options?.skipAutoAuth ?? false;
  }
}

/** Malformed credentials are reportable without retaining their secret value. */
export class MalformedAuthTokenError extends AuthError {
  constructor() {
    super(
      "invalid",
      "Invalid authentication token. Copy it again as a single line without spaces or control characters, " +
        "or run 'sentry auth login' to replace stored credentials."
    );
    this.name = "MalformedAuthTokenError";
  }
}

/**
 * Configuration or DSN errors.
 *
 * @param message - Error description
 * @param suggestion - Helpful hint for resolving the error
 */
export class ConfigError extends CliError {
  readonly suggestion?: string;

  constructor(message: string, suggestion?: string) {
    super(message, EXIT.CONFIG);
    this.name = "ConfigError";
    this.suggestion = suggestion;
  }

  override format(): string {
    let msg = this.message;
    if (this.suggestion) {
      msg += `\n\nSuggestion: ${this.suggestion}`;
    }
    return msg;
  }
}

/**
 * Thrown when a command produces valid output but should exit non-zero.
 *
 * Unlike other errors, the output data is rendered to stdout (not stderr)
 * through the normal output system — the `buildCommand` wrapper catches
 * this before it reaches the global error handler. Think "HTTP 404 body":
 * useful data, but the operation itself failed.
 *
 * @param data - The output data to render (same type as CommandOutput.data)
 */
export class OutputError extends CliError {
  readonly data: unknown;

  constructor(data: unknown) {
    super("", EXIT.OUTPUT_ERROR);
    this.name = "OutputError";
    this.data = data;
  }
}

const DEFAULT_CONTEXT_ALTERNATIVES = [
  "Run from a directory with a Sentry DSN in source code or .env files",
  "Set SENTRY_ORG and SENTRY_PROJECT (or SENTRY_DSN) environment variables",
  "Run 'sentry org list' to find your organization slug",
  "Run 'sentry project list <org>/' to find project slugs",
] as const;

/**
 * Build the formatted context error message with usage hints.
 *
 * @param resource - What is required (e.g., "Organization", "Trace ID and span ID")
 * @param command - Single-line CLI usage example (e.g., "sentry org view <org-slug>")
 * @param alternatives - Alternative ways to provide the context
 * @param note - Optional informational context (e.g., "Found 2 DSN(s) that could not be resolved").
 *   Rendered as a separate "Note:" section after alternatives. Use this for diagnostic
 *   information that explains what the CLI tried — keep alternatives purely actionable.
 * @param isAutoDetect - When true, the headline explains that auto-detection was attempted
 *   and failed rather than stating the value "is required". Callers that omit `alternatives`
 *   (using defaults) trigger this automatically via the {@link ContextError} constructor.
 * @returns Formatted multi-line error message
 */
function buildContextMessage(
  resource: string,
  command: string,
  alternatives: string[],
  options?: { note?: string; isAutoDetect?: boolean }
): string {
  const { note, isAutoDetect } = options ?? {};
  // Compound resources ("X and Y") need plural grammar
  const isPlural = resource.includes(" and ");
  const pronoun = isPlural ? "them" : "it";

  const lines = isAutoDetect
    ? [
        `Could not auto-detect ${resource.toLowerCase()}.`,
        "",
        `Provide ${pronoun} explicitly:`,
        `  ${command}`,
      ]
    : [
        `${resource} ${isPlural ? "are" : "is"} required.`,
        "",
        `Specify ${pronoun} using:`,
        `  ${command}`,
      ];

  if (alternatives.length > 0) {
    lines.push("", "Or:");
    for (const alt of alternatives) {
      lines.push(`  - ${alt}`);
    }
  }
  if (note) {
    lines.push("", `Note: ${note}`);
  }
  return lines.join("\n");
}

/**
 * Build the formatted resolution error message for entities that could not be found or resolved.
 *
 * @param resource - The entity that could not be resolved (e.g., "Issue 99124558")
 * @param headline - Describes the failure (e.g., "not found", "is ambiguous", "could not be resolved")
 * @param hint - Primary usage example or suggestion
 * @param suggestions - Additional help bullets shown under "Or:"
 * @returns Formatted multi-line error message
 */
function buildResolutionMessage(
  resource: string,
  headline: string,
  hint: string,
  suggestions: string[]
): string {
  const lines = [`${resource} ${headline}.`, "", "Try:", `  ${hint}`];
  if (suggestions.length > 0) {
    lines.push("", "Or:");
    for (const s of suggestions) {
      lines.push(`  - ${s}`);
    }
  }
  return lines.join("\n");
}

/**
 * Missing required context errors (org, project, etc).
 *
 * Use when the user **omitted** a required value entirely. For cases where the
 * user **provided** a value that couldn't be matched, use {@link ResolutionError}
 * instead. For malformed input, use {@link ValidationError}.
 *
 * When `alternatives` is omitted (using defaults), the error assumes auto-detection
 * was attempted and produces a "Could not auto-detect ..." headline. When `alternatives`
 * is explicitly provided (including `[]`), the error uses "... is/are required." instead.
 *
 * @param resource - What is required (e.g., "Organization", "Organization and project").
 *   Use " and " to join compound resources — triggers plural grammar ("are required").
 * @param command - **Single-line** CLI usage example (e.g., "sentry org view <org-slug>").
 *   Must not contain newlines — multi-line messages indicate a resolution failure
 *   that should use {@link ResolutionError}.
 * @param alternatives - Alternative ways to resolve (defaults to DSN/project detection hints).
 *   Pass `[]` when the defaults are irrelevant (e.g., for missing positional IDs like Trace ID).
 * @param note - Optional informational context rendered as a separate "Note:" section.
 *   Use for diagnostic info (e.g., "Found 2 DSN(s) that could not be resolved").
 *   Keep alternatives purely actionable — put explanations here instead.
 */
export class ContextError extends CliError {
  readonly resource: string;
  readonly command: string;
  readonly alternatives: string[];
  readonly note?: string;

  constructor(
    resource: string,
    command: string,
    alternatives?: string[],
    note?: string
  ) {
    // When alternatives is omitted, auto-detection was tried and failed
    const isAutoDetect = alternatives === undefined;
    const resolvedAlternatives = alternatives ?? [
      ...DEFAULT_CONTEXT_ALTERNATIVES,
    ];

    // Include full formatted message so it's shown even when caught by external handlers
    super(
      buildContextMessage(resource, command, resolvedAlternatives, {
        note,
        isAutoDetect,
      }),
      EXIT.CONTEXT_MISSING
    );
    this.name = "ContextError";
    this.resource = resource;
    this.command = command;
    this.alternatives = resolvedAlternatives;
    this.note = note;

    // Dev-time assertion: command must be a single-line CLI usage example.
    // Multi-line commands are a sign the caller should use ResolutionError.
    if (command.includes("\n")) {
      throw new Error(
        "ContextError command must be a single-line CLI usage hint. " +
          `Use ResolutionError for resolution failures. Got: "${command.slice(0, 80)}..."`
      );
    }
  }

  override format(): string {
    // Message already contains the formatted output
    return this.message;
  }
}

/**
 * Resolution errors for entities that could not be found or resolved.
 *
 * Use when the user **provided** a value but it couldn't be matched — as
 * opposed to {@link ContextError}, which is for when the user **omitted** a
 * required value entirely.
 *
 * Output format:
 * ```
 * Project 'cli' not found.
 *
 * Try:
 *   sentry issue list <org>/cli
 *
 * Or:
 *   - No project with this slug found in any accessible organization
 * ```
 *
 * @param resource - The entity that failed to resolve (e.g., "Issue 99124558", "Project 'cli'")
 * @param headline - Short phrase describing the failure (e.g., "not found", "is ambiguous", "could not be resolved")
 * @param hint - Primary usage example or suggestion (shown under "Try:")
 * @param suggestions - Additional help bullets shown under "Or:" (defaults to empty)
 */
export class ResolutionError extends CliError {
  readonly resource: string;
  readonly headline: string;
  readonly hint: string;
  readonly suggestions: string[];

  constructor(
    resource: string,
    headline: string,
    hint: string,
    suggestions: string[] = []
  ) {
    super(
      buildResolutionMessage(resource, headline, hint, suggestions),
      EXIT.RESOLUTION
    );
    this.name = "ResolutionError";
    this.resource = resource;
    this.headline = headline;
    this.hint = hint;
    this.suggestions = suggestions;
  }

  override format(): string {
    return this.message;
  }
}

/**
 * Build a {@link ValidationError} message with Try: examples and optional Note: section.
 *
 * Matches {@link buildResolutionMessage} / {@link buildContextMessage} formatting so
 * agent consumers get actionable recovery commands plus diagnostic context in a
 * predictable shape. Always pass `field` when constructing the error — unfielded
 * validation errors collapse into one Sentry fingerprint.
 *
 * @param headline - What failed validation
 * @param examples - CLI commands or steps shown under "Try:"
 * @param note - Optional diagnostic context rendered as "Note:" (not actionable)
 */
export function buildValidationMessage(
  headline: string,
  examples: string[],
  note?: string
): string {
  const lines = [headline];
  if (examples.length > 0) {
    lines.push("", "Try:");
    for (const example of examples) {
      lines.push(`  ${example}`);
    }
  }
  if (note) {
    lines.push("", `Note: ${note}`);
  }
  return lines.join("\n");
}

/**
 * Convenience wrapper around {@link buildValidationMessage} that returns a
 * {@link ValidationError} with the given field name.
 */
export function validationError(
  headline: string,
  examples: string[],
  field?: string,
  note?: string
): ValidationError {
  return new ValidationError(
    buildValidationMessage(headline, examples, note),
    field
  );
}

/**
 * Input validation errors.
 *
 * @param message - Validation failure description
 * @param field - Name of the invalid field
 */
export class ValidationError extends CliError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, EXIT.VALIDATION);
    this.name = "ValidationError";
    this.field = field;
  }
}

/**
 * OAuth device flow errors (RFC 8628).
 *
 * @param code - OAuth error code (e.g., "authorization_pending", "slow_down")
 * @param description - Human-readable error description
 */
export class DeviceFlowError extends CliError {
  readonly code: string;

  constructor(code: string, description?: string) {
    super(description ?? code, EXIT.DEVICE_FLOW);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

// Upgrade Errors

export type UpgradeErrorReason =
  | "unknown_method"
  | "unsupported_operation"
  | "network_error"
  | "execution_failed"
  | "version_not_found"
  | "offline_cache_miss";

/**
 * Upgrade-related errors.
 *
 * @param reason - Type of upgrade failure
 * @param message - Custom message (uses default if not provided)
 */
export class UpgradeError extends CliError {
  readonly reason: UpgradeErrorReason;

  constructor(reason: UpgradeErrorReason, message?: string) {
    const defaultMessages: Record<UpgradeErrorReason, string> = {
      unknown_method:
        "Could not detect installation method. Use --method to specify.",
      unsupported_operation:
        "This operation is not supported for this installation method.",
      network_error: "Failed to fetch version information.",
      execution_failed: "Upgrade command failed.",
      version_not_found: "The specified version was not found.",
      offline_cache_miss:
        "Cannot upgrade offline — no pre-downloaded update is available.",
    };
    super(message ?? defaultMessages[reason], EXIT.UPGRADE);
    this.name = "UpgradeError";
    this.reason = reason;
  }
}

/** Upgrade failure caused by transport rather than an HTTP or metadata error. */
export class UpgradeTransportError extends UpgradeError {
  constructor(message: string) {
    super("network_error", message);
    this.name = "UpgradeTransportError";
  }
}

// Seer Errors

export type SeerErrorReason = "not_enabled" | "no_budget" | "ai_disabled";

/**
 * Seer-specific errors with actionable suggestions.
 *
 * @param reason - Type of Seer failure
 * @param orgSlug - Organization slug for constructing settings URLs
 */
export class SeerError extends CliError {
  readonly reason: SeerErrorReason;
  readonly orgSlug?: string;

  constructor(reason: SeerErrorReason, orgSlug?: string) {
    const messages: Record<SeerErrorReason, string> = {
      not_enabled: "Seer is not enabled for this organization.",
      no_budget: "Seer requires a paid plan.",
      ai_disabled: "AI features are disabled for this organization.",
    };
    const exitCodes: Record<SeerErrorReason, number> = {
      not_enabled: EXIT.SEER_NOT_ENABLED,
      no_budget: EXIT.SEER_NO_BUDGET,
      ai_disabled: EXIT.SEER_AI_DISABLED,
    };
    super(messages[reason], exitCodes[reason]);
    this.name = "SeerError";
    this.reason = reason;
    this.orgSlug = orgSlug;
  }

  override format(): string {
    // When org slug is known, suggest the direct trial start command.
    // The interactive trial prompt in bin.ts handles TTY users; this
    // message is the fallback for non-interactive contexts (AI agents, CI)
    // where the prompt can't fire — hence the direct command suggestion
    // (CLI-1D/BW/98, 237 users combined).
    const trialHint = this.orgSlug
      ? `\n\nStart a free trial:\n  sentry trial start seer ${this.orgSlug}`
      : "\n\nYou may be eligible for a free trial:\n  sentry trial list";

    // When org slug is known, provide direct URLs to settings
    if (this.orgSlug) {
      const suggestions: Record<SeerErrorReason, string> = {
        not_enabled: `To enable Seer:\n  ${buildSeerSettingsUrl(this.orgSlug)}${trialHint}`,
        no_budget: `To use Seer features, upgrade your plan:\n  ${buildBillingUrl(this.orgSlug, "seer")}${trialHint}`,
        // ai_disabled is an admin decision — don't suggest trial
        ai_disabled: `To enable AI features:\n  ${buildOrgSettingsUrl(this.orgSlug, "hideAiFeatures")}`,
      };
      return `${this.message}\n\n${suggestions[this.reason]}`;
    }

    // Fallback when org slug is unknown - give generic guidance
    const fallbackSuggestions: Record<SeerErrorReason, string> = {
      not_enabled: `To enable Seer, visit your organization's Seer settings in Sentry.${trialHint}`,
      no_budget: `To use Seer features, upgrade your plan in your organization's billing settings.${trialHint}`,
      // ai_disabled is an admin decision — don't suggest trial
      ai_disabled:
        "To enable AI features, check the 'Hide AI Features' setting in your organization settings.",
    };
    return `${this.message}\n\n${fallbackSuggestions[this.reason]}`;
  }
}

/**
 * Timeout errors for long-running polling operations.
 *
 * Use when a polling loop exceeds its time budget. Provides structured
 * hints so the user knows the operation may still complete in the background.
 *
 * @param message - What timed out (e.g., "Operation timed out after 6 minutes.")
 * @param hint - Actionable suggestion (e.g., "Run the command again — the analysis may finish in the background.")
 */
export class TimeoutError extends CliError {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message, EXIT.TIMEOUT);
    this.name = "TimeoutError";
    this.hint = hint;
  }

  override format(): string {
    let msg = this.message;
    if (this.hint) {
      msg += `\n\n${this.hint}`;
    }
    return msg;
  }
}

/**
 * Error thrown by the init wizard when it has already displayed
 * the error via clack UI. The `rendered` flag tells the framework
 * error handler to skip its own formatting.
 */
export class WizardError extends CliError {
  readonly rendered: boolean;

  constructor(
    message: string,
    options?: { rendered?: boolean; exitCode?: number }
  ) {
    super(message, options?.exitCode ?? EXIT.WIZARD);
    this.name = "WizardError";
    this.rendered = options?.rendered ?? true;
  }
}

// Error Utilities

/**
 * Thrown when an operation is cancelled via an AbortSignal.
 *
 * Matches the `error.name === "AbortError"` convention used throughout the
 * codebase (version-check.ts, sentry-client.ts, binary.ts) to detect and
 * silently swallow cancellation errors.
 */
export class AbortError extends Error {
  override name = "AbortError" as const;
  constructor() {
    super("The operation was aborted");
  }
}

/**
 * Convert an unknown value to a human-readable string.
 *
 * Handles Error instances (`.message`), plain objects (`JSON.stringify`),
 * strings (as-is), and other primitives (`String()`).
 * Use this instead of bare `String(value)` when the value might be a
 * plain object — `String({})` produces the unhelpful `"[object Object]"`.
 *
 * @param value - Any thrown or unknown value
 * @returns Human-readable string representation
 */
export function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value && typeof value === "object") {
    // JSON.stringify can throw on circular references or BigInt values.
    // Fall back to String() which is always safe.
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Format any error for user display.
 * Uses CliError.format() for CLI errors, falls back to stringifyUnknown.
 *
 * @param error - Any thrown value
 * @returns Formatted error string
 */
export function formatError(error: unknown): string {
  return redactCredentialText(
    error instanceof CliError ? error.format() : stringifyUnknown(error)
  );
}

/**
 * Get process exit code for an error.
 *
 * @param error - Any thrown value
 * @returns Exit code (from CliError.exitCode or 1 for other errors)
 */
export function getExitCode(error: unknown): number {
  if (error instanceof CliError) {
    return error.exitCode;
  }
  return 1;
}

/**
 * Sentry's search-query parser emits a 400 whose detail begins with this phrase
 * when the user's `--query` cannot be parsed (e.g. `is:403`, `lastSeen:>=-24h`,
 * an empty `status:`). The server is telling us the user-supplied query is
 * malformed — a user input error, not the CLI constructing a bad request.
 */
const SEARCH_QUERY_PARSE_MARKER = "Error parsing search query";

/**
 * Whether an {@link ApiError} is a Sentry search-query parse failure (HTTP 400
 * whose detail reports an unparseable query). The CLI preserves the server's
 * detail when re-wrapping list errors (`enrichIssueListError` in
 * `commands/issue/list.ts` prepends the original detail), so a substring match
 * is robust to that wrapping.
 *
 * Shared by the three 4xx classifiers so they agree on these 400s:
 * `classifySilenced` (Sentry capture), {@link isUserError} (upgrade nudge), and
 * `isUserApiError` (span attribution).
 */
export function isSearchQueryParseError(error: ApiError): boolean {
  return (
    error.status === 400 &&
    (error.detail?.includes(SEARCH_QUERY_PARSE_MARKER) ?? false)
  );
}

/**
 * Standard actionable hint shown when a user-supplied search query is rejected.
 * Exported so command boundaries can reuse it alongside command-specific hints.
 */
export const SEARCH_QUERY_HELP =
  "Check your --query syntax (Sentry search reference: https://docs.sentry.io/concepts/search/)";

/**
 * Convert a Sentry search-query parse failure into a {@link ValidationError}
 * when the user actually supplied the query; otherwise return the error
 * unchanged.
 *
 * HTTP 400 means the server rejected our request as malformed, which has two
 * very different causes that are only distinguishable at the command boundary
 * (where `flags.query` is in scope):
 *
 * - **The user typed an invalid `--query`** — a user input mistake. We surface
 *   a clean, actionable {@link ValidationError} (correct exit code, no "CLI
 *   bug" upgrade nudge) instead of a raw "400 Bad Request".
 * - **The CLI built the query itself** (no user `--query`) — a genuine CLI
 *   defect. The original {@link ApiError} (status 400) is returned untouched so
 *   it stays reported to Sentry as the bug it is.
 *
 * This is why search-query 400s are no longer special-cased in the error
 * classifiers (`classifySilenced`, {@link isUserError}, `isUserApiError`):
 * silencing every "Error parsing search query" 400 also hid the CLI-authored
 * ones, papering over real bugs.
 *
 * @param error - The error thrown by a list/search API call
 * @param userQuery - The user-supplied search query (`flags.query`), if any
 * @param extraSuggestions - Optional command-specific hints appended after the
 *   standard search-syntax help
 * @returns A {@link ValidationError} for user-query mistakes, else `error`
 */
export function toSearchQueryError(
  error: unknown,
  userQuery: string | undefined,
  extraSuggestions: readonly string[] = []
): unknown {
  if (
    userQuery &&
    error instanceof ApiError &&
    isSearchQueryParseError(error)
  ) {
    const lines: string[] = [];
    if (error.detail) {
      lines.push(error.detail, "");
    }
    lines.push("Suggestions:");
    for (const suggestion of [SEARCH_QUERY_HELP, ...extraSuggestions]) {
      lines.push(`  • ${suggestion}`);
    }
    return new ValidationError(lines.join("\n"), "query");
  }
  return error;
}

/**
 * Whether an error is a raw network-level fetch failure — the CLI could not
 * reach the Sentry API at all (offline, DNS failure, connection
 * refused/timeout). Node's `fetch` (undici) rejects with exactly
 * `TypeError: "fetch failed"` for every such failure (the real errno is in
 * `cause`).
 *
 * This reflects the user's environment, not a CLI bug, so it is treated as a
 * user error (no upgrade nudge) and is not reported to Sentry — the same
 * rationale as dropping EPIPE/EBADF OS noise in `beforeSend`.
 *
 * NOTE: This deliberately does NOT match `ApiError` with `status === 0`. That
 * status is shared by genuine connectivity failures AND TLS certificate errors,
 * and the latter are actionable user-configuration issues (e.g. a missing CA
 * cert) that must stay visible. Callers that want the "user environment, not a
 * CLI bug" treatment for `status === 0` check it explicitly.
 */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

/**
 * Classify errors caused by user input, configuration, auth state, or account
 * settings. These errors already tell the user what to fix, so upgrade nudges
 * should use the neutral update banner instead of implying a CLI bug fix.
 *
 * Generic {@link CliError} instances are treated as user-facing by default.
 * Explicit non-user subclasses must be checked before that fallback.
 */
export function isUserError(error: unknown): boolean {
  // A raw "fetch failed" TypeError is a network-level failure — the user's
  // environment, not a CLI bug.
  if (isNetworkError(error)) {
    return true;
  }

  if (error instanceof ApiError) {
    // Status 0 = no HTTP response (network failure or TLS cert error) — the
    // user's environment/config, not a CLI bug.
    if (error.status === 0) {
      return true;
    }
    // 400 means the CLI constructed a bad request, which is a CLI bug — not a
    // user error. (A user's unparseable `--query` is converted to a
    // ValidationError at the command boundary via toSearchQueryError, so it
    // never reaches here as an ApiError.)
    return error.status > 400 && error.status < 500;
  }

  if (
    error instanceof AbortError ||
    error instanceof TimeoutError ||
    error instanceof UpgradeError
  ) {
    return false;
  }

  if (
    error instanceof AuthError ||
    error instanceof HostScopeError ||
    error instanceof ConfigError ||
    error instanceof ContextError ||
    error instanceof ResolutionError ||
    error instanceof ValidationError ||
    error instanceof DeviceFlowError ||
    error instanceof SeerError ||
    error instanceof OutputError ||
    error instanceof WizardError
  ) {
    return true;
  }

  return error instanceof CliError;
}

/** Result when the guarded operation succeeded */
export type AuthGuardSuccess<T> = { ok: true; value: T };

/** Result when a non-auth error was caught */
export type AuthGuardFailure = { ok: false; error: unknown };

/** Discriminated union returned by {@link withAuthGuard} */
export type AuthGuardResult<T> = AuthGuardSuccess<T> | AuthGuardFailure;

/**
 * Execute an async operation, rethrowing {@link AuthError} and
 * {@link HostScopeError} while capturing all other failures in a
 * discriminated result.
 *
 * This is the standard "safe fetch" pattern used throughout the CLI:
 *
 * - `AuthError` propagates so the auto-login flow in bin.ts can trigger.
 * - `HostScopeError` propagates so the user sees the security-fix
 *   rejection with its actionable message. Without this, host-scoping
 *   violations would be silently swallowed into "no results" and the
 *   caller might fall back to a second authenticated request that ALSO
 *   trips the guard (doubling the log noise and masking the root cause).
 *
 * Transient failures (network, `ApiError` for 4xx/5xx, permissions) are
 * captured in `{ ok: false, error }` so callers can degrade gracefully.
 *
 * @param fn - Async operation that may throw
 * @returns `{ ok: true, value }` on success, `{ ok: false, error }` on transient failure
 * @throws {AuthError} Always re-thrown so the auto-login flow can trigger
 * @throws {HostScopeError} Always re-thrown so host-scoping rejections surface to the user
 */
export async function withAuthGuard<T>(
  fn: () => Promise<T>
): Promise<AuthGuardResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof AuthError || error instanceof HostScopeError) {
      throw error;
    }
    return { ok: false, error };
  }
}

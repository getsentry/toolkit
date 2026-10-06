/**
 * Central error reporting for CLI command failures.
 *
 * Provides two things:
 *
 * 1. **Silencing rules** — `OutputError`, network failures (offline/DNS/proxy),
 *    `AuthError` (except `MalformedAuthTokenError`), 401–499 `ApiError`,
 *    and 400 `ApiError`s that report an unparseable user search query are not
 *    sent to Sentry as issues. A `cli.error.silenced` metric preserves volume +
 *    user/org context.
 *
 *    `ContextError` (a required value the user omitted) is deliberately NOT
 *    silenced: its volume is the signal driving auto-detection/UX improvements
 *    (e.g. single-org auto-select, the interactive picker), so it must stay
 *    visible (CLI-3B).
 *    `MalformedAuthTokenError` is also captured to keep token-formatting
 *    failures visible; its fixed message never includes the rejected token.
 *
 * 2. **Grouping tags** — enriches every error event with `cli_error.*` tags
 *    that Sentry's server-side fingerprint rules use for stable grouping.
 *    The rules live in Settings → Issue Grouping → Fingerprint Rules and
 *    can be adjusted without a deploy.
 *
 * Fingerprint normalization is handled server-side, NOT in code. See the
 * project's fingerprint rules for the active grouping policy.
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import { redactCredentialText } from "./credential-redaction.js";
import {
  ApiError,
  AuthError,
  CliError,
  ContextError,
  DeviceFlowError,
  HostScopeError,
  isNetworkError,
  MalformedAuthTokenError,
  OutputError,
  ResolutionError,
  SeerError,
  TimeoutError,
  UpgradeError,
  ValidationError,
  WizardError,
} from "./errors.js";
import { isSaaS } from "./sentry-urls.js";

// ---------------------------------------------------------------------------
// Silencing
// ---------------------------------------------------------------------------

/**
 * Reasons an error may be silenced (not sent to Sentry as an issue).
 * Exposed as the `reason` attribute on the `cli.error.silenced` metric.
 */
type SilenceReason =
  | "output_error"
  | "auth_expected"
  | "api_user_error"
  | "network_error"
  | "process_exit"
  | "user_validation"
  | "user_input_error"
  | "seer_unavailable_self_hosted";

/**
 * Classify whether an error should be silenced.
 * Returns the reason string when silenced, `null` when it should be captured.
 *
 * @internal Exported for `telemetry.ts` (session-crash decision) and testing.
 */
export function classifySilenced(error: unknown): SilenceReason | null {
  if (error instanceof OutputError) {
    return "output_error";
  }
  // A raw `TypeError: "fetch failed"` (CLI-16W) means the CLI could not reach
  // Sentry at all (offline, DNS, connection refused/timeout). There is nothing
  // actionable in a "user is offline" report, so drop it — same rationale as
  // EPIPE/EBADF OS noise in `beforeSend`. Note: TLS cert errors are wrapped as
  // ApiError(status 0), NOT matched here, so they stay captured/actionable.
  if (isNetworkError(error)) {
    return "network_error";
  }
  // A ContextError means the user omitted a required value (no org/project
  // could be resolved, a required ID was not provided, etc.). It is NOT
  // silenced: the volume of these is the signal we use to drive auto-detection
  // and UX improvements (single-org auto-select, the interactive picker, the
  // enriched error). Silencing it hid that signal AND skipped the fix, so it
  // stays captured (CLI-3B). The accompanying `resolveOrgProjectOrGuide`
  // changes aim to drive this volume down by helping users succeed instead.
  //
  // Missing, expired, and rejected credentials are expected auth states.
  // Malformed tokens stay visible to investigate configuration/formatting
  // failures, using an error that never contains the credential (CLI-19).
  if (
    error instanceof AuthError &&
    !(error instanceof MalformedAuthTokenError)
  ) {
    return "auth_expected";
  }
  // A ValidationError with field "project.ambiguous_org" means the user
  // supplied a project slug that exists in multiple organizations — pure
  // user-input ambiguity, not a CLI bug. Silence it so it doesn't pollute
  // the issue tracker; the user sees a clear disambiguation message.
  if (
    error instanceof ValidationError &&
    error.field === "project.ambiguous_org"
  ) {
    return "user_validation";
  }
  // A ValidationError with field "input" means the --input file path the user
  // supplied does not exist on disk. Pure user-input noise, not a CLI bug —
  // the user sees a clear "File not found" message (CLI-1JY).
  if (error instanceof ValidationError && error.field === "input") {
    return "user_input_error";
  }
  // A ResolutionError means the user provided a value (event ID, project slug,
  // etc.) that was looked up but not found. This is pure user-input noise, not
  // a CLI bug — the user sees a clear "not found" message (CLI-RP).
  if (error instanceof ResolutionError) {
    return "user_input_error";
  }
  if (error instanceof ApiError && error.status > 400 && error.status < 500) {
    return "api_user_error";
  }
  // On SaaS, SeerError stays captured: it feeds the marketing dashboard for
  // Seer upsell/trial signal. Self-hosted instances cannot enable Seer or
  // start a trial, so there it is pure feature-gate noise (CLI-1WP).
  if (error instanceof SeerError && !isSaaS()) {
    return "seer_unavailable_self_hosted";
  }
  // A child process launched by `sentry local run` or `sentry monitor run`
  // that exits with a non-zero code throws `CliError("Process exited with
  // code N")`. These are expected user-script failures, not CLI bugs — no
  // actionable signal comes from capturing them (CLI-20G).
  if (
    error instanceof CliError &&
    error.message.startsWith("Process exited with code")
  ) {
    return "process_exit";
  }
  // A 400 (Bad Request) signals a malformed request the CLI built — a code
  // defect — so it is always captured. A user's unparseable `--query` is NOT a
  // 400 here: it is converted to a ValidationError at the command boundary
  // (toSearchQueryError) so the user gets an actionable message and the bug
  // signal for CLI-authored bad queries is preserved (CLI-FA).
  return null;
}

/** Emit a metric for silenced errors so volume remains visible. */
function recordSilencedError(error: unknown, reason: SilenceReason): void {
  const attributes: Record<string, string | number> = {
    error_class: error instanceof Error ? error.name : typeof error,
    reason,
  };
  if (error instanceof ApiError) {
    attributes.api_status = error.status;
  }
  if (error instanceof AuthError) {
    attributes.auth_reason = error.reason;
  }
  if (error instanceof SeerError) {
    attributes.seer_reason = error.reason;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    Sentry.metrics.distribution("cli.error.silenced", 1, { attributes });
  } catch {
    // Metric emission must never block error handling.
  }

  // Structured log for user API errors — `detail` is often the most actionable
  // field and is searchable in Sentry Logs.
  if (reason === "api_user_error" && error instanceof ApiError) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      Sentry.logger.info("cli.api_error_silenced", {
        status: error.status,
        endpoint: error.endpoint,
        detail: error.detail,
      });
    } catch {
      // Logger may not be initialized — ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// Grouping tags
// ---------------------------------------------------------------------------

/** Endpoint normalization patterns — compiled once at module scope. */
const ENDPOINT_PATTERNS: [RegExp, string][] = [
  [/\/organizations\/[^/]+/, "/organizations/{org}"],
  [/\/projects\/[^/]+\/[^/]+/, "/projects/{org}/{project}"],
  [/\/issues\/[^/]+/, "/issues/{id}"],
  [/\/events\/[^/]+/, "/events/{id}"],
  [/\/groups\/[^/]+/, "/groups/{id}"],
  [/\/releases\/[^/]+/, "/releases/{version}"],
  [/\/teams\/[^/]+\/[^/]+/, "/teams/{org}/{team}"],
  [/\/dashboards\/[^/]+/, "/dashboards/{id}"],
  [/\/customers\/[^/]+/, "/customers/{org}"],
];

/**
 * Strip remaining bare numeric segments (e.g. /12345/) but preserve
 * the API version prefix /0/ which is always the second segment.
 */
const BARE_NUMERIC_SEGMENT_RE = /(?<=\/api\/0\/.*)\/\d+(?=\/|$)/g;

/**
 * Normalize an API endpoint path by parameterizing variable segments.
 *
 * Replaces org slugs, project slugs, issue IDs, event IDs, and other
 * entity identifiers with placeholders so that server-side fingerprint
 * rules can sub-group `ApiError` by endpoint shape rather than exact path.
 *
 * `"/api/0/projects/my-org/my-project/events/abc123/"` →
 * `"/api/0/projects/{org}/{project}/events/{id}/"`
 */
export function normalizeEndpoint(endpoint: string): string {
  let result = endpoint;
  for (const [pattern, replacement] of ENDPOINT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(BARE_NUMERIC_SEGMENT_RE, "/{id}");
}

/**
 * Strip quoted substrings, numeric/hex IDs, and org/project paths from a
 * resource string to produce a stable "kind" for grouping.
 *
 * `"Project 'my-app' not found"` → `"Project not found"`
 * `"Issue 7420431306 not found."` → `"Issue not found."`
 * `"Issue 19 not found."` → `"Issue not found."`
 * `"not found in neurio/installer-app"` → `"not found"`
 */
export function extractResourceKind(resource: string): string {
  return (
    resource
      .replace(/'[^']*'/g, "")
      .replace(/"[^"]*"/g, "")
      .replace(/\b[0-9a-f]{16,32}\b/gi, "")
      .replace(/\bin\s+[\w-]+(?:\/[\w-]+)*/g, "")
      // Strip hyphenated slugs after known entity names (e.g., "Organization my-company").
      // Requires at least one hyphen to avoid stripping English words ("Project not found").
      // Safe for current callers: resource values with slugs use quotes (stripped above),
      // and headline values don't start with entity names.
      .replace(
        /\b(Organization|Dashboard|Dashboards|Project|Team)\s+[\w][\w-]*-[\w-]*/gi,
        "$1"
      )
      .replace(/\b\d+\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Extract the first N words from the first line of an error message, after
 * stripping quoted user data. Used as a grouping-key fallback when an error
 * class lacks a structured `field`/`reason` to key on.
 *
 * `"Invalid trace ID \"abc\". Expected ..."` → `"Invalid trace ID"` (with maxWords=3)
 */
export function extractMessagePrefix(message: string, maxWords = 3): string {
  const firstLine = redactCredentialText(message).split("\n", 1)[0] ?? "";
  return firstLine
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, maxWords)
    .join(" ");
}

/**
 * Derive a stable `cli_error.kind` grouping key from an error instance.
 *
 * Returns `undefined` when the error is not a recognized CLI error class
 * (the caller should still set `cli_error.class` for basic grouping).
 */
function deriveErrorKind(error: Error): string | undefined {
  if (error instanceof ContextError) {
    return error.resource;
  }
  if (error instanceof ResolutionError) {
    return (
      extractResourceKind(error.resource) +
      " " +
      extractResourceKind(error.headline)
    );
  }
  // Fall back to the first few words of the message when no field is set
  // (e.g. validateHexId throws with no `field`, so using field would
  // collapse every unfielded ValidationError into one group).
  if (error instanceof ValidationError) {
    return error.field ?? extractMessagePrefix(error.message);
  }
  if (error instanceof ApiError) {
    return String(error.status);
  }
  if (error instanceof SeerError) {
    return error.reason;
  }
  if (error instanceof AuthError) {
    return error.reason;
  }
  if (error instanceof UpgradeError) {
    return error.reason;
  }
  if (error instanceof DeviceFlowError) {
    return error.code;
  }
  if (error instanceof TimeoutError) {
    return "timeout";
  }
  if (error instanceof HostScopeError) {
    return "host_scope";
  }
  if (error instanceof WizardError) {
    return "wizard";
  }
  // Catch-all for bare CliError — must be checked AFTER all subclasses
  // because instanceof matches the entire prototype chain.
  // ConfigError and OutputError intentionally fall through here:
  // ConfigError has no structured field beyond message; OutputError is
  // silenced by classifySilenced() before reaching deriveErrorKind().
  if (error instanceof CliError) {
    return extractMessagePrefix(error.message, 4);
  }
  return;
}

/**
 * Set `cli_error.*` tags on a Sentry scope for an error that will be
 * captured. These tags are matched by server-side fingerprint rules to
 * achieve stable grouping without SDK-side fingerprint logic.
 *
 * Tags set:
 * - `cli_error.class` — error class name (e.g. `"ContextError"`)
 * - `cli_error.kind`  — stable grouping key derived from structured fields
 * - `cli_error.api_status` — HTTP status (ApiError only)
 * - `cli_error.api_endpoint` — normalized API path (ApiError only)
 */
function setGroupingTags(scope: Sentry.Scope, error: unknown): void {
  if (!(error instanceof Error)) {
    return;
  }

  scope.setTag("cli_error.class", error.name);

  const kind = deriveErrorKind(error);
  if (kind !== undefined) {
    scope.setTag("cli_error.kind", kind);
  }

  if (error instanceof ApiError) {
    scope.setTag("cli_error.api_status", String(error.status));
    if (error.endpoint) {
      scope.setTag("cli_error.api_endpoint", normalizeEndpoint(error.endpoint));
    }
  }
}

// ---------------------------------------------------------------------------
// Structured context
// ---------------------------------------------------------------------------

/** Attach a `cli_error` context with full structured details for Discover. */
function setCliErrorContext(scope: Sentry.Scope, error: unknown): void {
  if (error instanceof ApiError) {
    scope.setContext("api_error", {
      status: error.status,
      endpoint: error.endpoint,
      detail: error.detail,
    });
  } else if (error instanceof ContextError) {
    scope.setContext("cli_error", {
      resource: error.resource,
      command: error.command,
    });
  } else if (error instanceof ResolutionError) {
    scope.setContext("cli_error", {
      resource: error.resource,
      headline: error.headline,
      hint: error.hint,
    });
  } else if (error instanceof SeerError) {
    scope.setContext("cli_error", {
      reason: error.reason,
      org_slug: error.orgSlug,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Report an error to Sentry without rethrowing.
 *
 * Call this at the command boundary for thrown failures, and in best-effort
 * catch blocks that swallow the error so the command can continue. A debug
 * log is not a substitute: users do not run `--verbose`, so swallowed
 * unexpected failures must become Sentry issues.
 *
 * - Silenced errors (network, expected auth, 4xx) emit a metric and return
 *   without calling `captureException`.
 * - Captured errors get grouping tags + structured context on a fresh scope.
 */
export function reportCliError(error: unknown): void {
  const silenced = classifySilenced(error);
  if (silenced) {
    recordSilencedError(error, silenced);
    return;
  }

  Sentry.withScope((scope) => {
    setGroupingTags(scope, error);
    setCliErrorContext(scope, error);
    Sentry.captureException(error);
  });
}

/**
 * Enrich an error event with `cli_error.*` tags for server-side fingerprinting.
 *
 * Called from `beforeSend` to catch events that bypass {@link reportCliError}
 * (uncaught exceptions, unhandled rejections, best-effort background captures).
 * Only sets tags when `cli_error.class` isn't already present (events from
 * `reportCliError` already have them).
 */
export function enrichEventWithGroupingTags(
  event: Sentry.ErrorEvent
): Sentry.ErrorEvent {
  // Skip if reportCliError already set the tags via withScope.
  if (event.tags?.["cli_error.class"]) {
    return event;
  }

  // Use the last (outermost/thrown) exception in the chain, not the first
  // (innermost/root cause). Per the Sentry protocol, values[0] is the root
  // cause and values[n-1] is the actually-thrown exception.
  const values = event.exception?.values;
  const exc = values?.[values.length - 1];
  if (!exc?.type) {
    return event;
  }

  event.tags = event.tags ?? {};
  event.tags["cli_error.class"] = exc.type;

  // Set kind from exception message prefix so server-side rules can group
  // non-CliError exceptions (TypeError, Error, WizardCancelledError, etc.)
  // that bypass reportCliError (uncaught exceptions, unhandled rejections).
  if (exc.value) {
    event.tags["cli_error.kind"] = extractMessagePrefix(exc.value, 4);
  }

  return event;
}

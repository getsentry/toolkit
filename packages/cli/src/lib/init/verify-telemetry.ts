/**
 * Telemetry helpers shared by the post-init verification paths
 * (Spotlight-backed local verification and platform doctor verification).
 */

import { addBreadcrumb, setTag } from "@sentry/node-core/light";

/** Absolute-path pattern — scrub user-specific directory paths from telemetry. */
const ABS_PATH_RE = /(?:\/[\w.@-]+){2,}/g;

/** Key=value pattern for redaction (env vars and --flag=value args). */
const KEY_VALUE_RE = /(?:--?)?[A-Za-z_][\w-]*=\S+/g;

/** URI userinfo (user:password@ or :password@) pattern for redaction. */
const URI_USERINFO_RE = /\/\/[^@/\s]*:[^@/\s]+@/g;

/** Strip absolute paths, env-var values, and URI credentials from output. */
export function scrubOutputLine(line: string): string {
  return line
    .replace(URI_USERINFO_RE, "//[REDACTED]@")
    .replace(KEY_VALUE_RE, (m) => `${m.split("=")[0]}=[REDACTED]`)
    .replace(ABS_PATH_RE, "[PATH]");
}

type VerificationSkipReason =
  | "no_dev_command"
  | "server_bind"
  | "spawn_failed"
  | "no_flutter"
  | "no_npx";

/**
 * Expected verification skips are not failures. Emitting them with
 * `captureException` produced ERROR events on healthy completed runs.
 */
export function recordVerificationSkipped(
  reason: VerificationSkipReason,
): void {
  addBreadcrumb({
    category: "wizard.verify",
    level: "info",
    message: `skipped:${reason}`,
  });
  setTag("wizard.verify", "skipped");
}

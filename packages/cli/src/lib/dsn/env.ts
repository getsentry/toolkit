/**
 * Environment Variable Detection
 *
 * Detects DSN from SENTRY_DSN environment variable.
 * This is the highest priority source.
 */

import { getEnv } from "../env.js";
import { createDetectedDsn } from "./parser.js";
import type { DetectedDsn } from "./types.js";

/** Environment variable name for Sentry DSN */
export const SENTRY_DSN_ENV = "SENTRY_DSN";

/**
 * Framework-specific env var prefixes that expose values to client-side code.
 * Used to build both the runtime env var checklist and the .env file regex
 * so that both detection paths match the same set of variable names.
 */
export const FRAMEWORK_ENV_PREFIXES = [
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "VITE_",
  "EXPO_PUBLIC_",
  "NUXT_PUBLIC_",
] as const;

/**
 * Framework-prefixed env var names that commonly hold a Sentry DSN.
 * Checked in order after `SENTRY_DSN` (canonical name has priority).
 */
const FRAMEWORK_DSN_VARS = FRAMEWORK_ENV_PREFIXES.map(
  (prefix) => `${prefix}SENTRY_DSN`
);

/**
 * Detect DSN from environment variables.
 *
 * Checks `SENTRY_DSN` first (canonical), then common framework-prefixed
 * variants (NEXT_PUBLIC_SENTRY_DSN, REACT_APP_SENTRY_DSN, etc.).
 *
 * @returns Detected DSN or null if not set/invalid
 *
 * @example
 * // With SENTRY_DSN=https://key@o123.ingest.sentry.io/456
 * const dsn = detectFromEnv();
 * // { raw: "...", source: "env", projectId: "456", ... }
 */
export function detectFromEnv(): DetectedDsn | null {
  const env = getEnv();

  const allVars = [SENTRY_DSN_ENV, ...FRAMEWORK_DSN_VARS];
  for (const varName of allVars) {
    const value = env[varName];
    if (value) {
      const detected = createDetectedDsn(value, "env", varName);
      if (detected) {
        return detected;
      }
    }
  }

  return null;
}

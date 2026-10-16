/**
 * `Tip:` hint suppression via a persistent default plus an env override.
 *
 * `sentry cli defaults tips off` stores the preference; `SENTRY_DISABLE_TIPS`
 * overrides it at runtime (env wins). Only `Tip: ...` text is removed —
 * pagination, dry-run, cancellation, and other operational notices that share
 * the command footer channel are preserved, and so is the cache-age footer.
 *
 * getsentry/toolkit#1479
 *
 * @module
 */

import { getTipsPreference } from "./db/defaults.js";
import { getEnv } from "./env.js";
import { isTruthyEnv } from "./formatters/plain-detect.js";

/** Environment variable that disables `Tip:` hints at runtime. */
export const TIPS_DISABLE_ENV_VAR = "SENTRY_DISABLE_TIPS";

/**
 * Matches a `Tip: ...` sentence through the end of its line, either at the
 * start of the line or after other text (e.g. `"Missing: a. Tip: Use ..."`).
 */
const TIP_PATTERN = /(^|\s+)Tip:.*$/;

/**
 * Decide whether `Tip:` hints should be suppressed.
 *
 * - A truthy `SENTRY_DISABLE_TIPS` suppresses tips and wins over the stored
 *   preference, using the shared truthy-env semantics (`"0"` / `"false"` /
 *   `""` are falsy and fall through to the preference).
 * - Otherwise the stored `defaults.tips` preference applies (`off` suppresses).
 * - Default: tips are shown.
 */
export function tipsSuppressed(): boolean {
  const envVal = getEnv()[TIPS_DISABLE_ENV_VAR];
  if (envVal !== undefined && isTruthyEnv(envVal)) {
    return true;
  }
  return getTipsPreference() === false;
}

/**
 * Remove `Tip: ...` text from a hint, keeping every other line intact.
 *
 * Lines that are entirely a tip are dropped; a tip trailing other text on the
 * same line is cut off. Blank lines left at the edges are trimmed.
 *
 * @returns The remaining hint, or `undefined` when only tips were present
 */
export function stripTips(hint: string): string | undefined {
  const kept: string[] = [];
  for (const line of hint.split("\n")) {
    const remainder = line.replace(TIP_PATTERN, "");
    if (remainder === line) {
      kept.push(line);
    } else if (remainder.trim()) {
      kept.push(remainder.trimEnd());
    }
  }
  const result = kept.join("\n").replace(/^\n+|\n+$/g, "");
  return result.trim() ? result : undefined;
}

/**
 * Apply the user's tip preference to a command hint: strip `Tip:` text when
 * tips are suppressed, otherwise return the hint unchanged.
 */
export function applyTipsPreference(
  hint: string | undefined,
): string | undefined {
  if (!hint) {
    return hint;
  }
  return tipsSuppressed() ? stripTips(hint) : hint;
}

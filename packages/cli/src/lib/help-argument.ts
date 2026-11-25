/**
 * `help` typed as an argument (`sentry project help`), which the CLI answers
 * with help only after the command could not use it as a real value.
 */

import { ValidationError } from "./errors.js";

/**
 * Whether the user typed `help` (or a mistyped help flag) as an argument,
 * which `buildCommand` answers with the command's help.
 */
export function isHelpArgument(raw: unknown): boolean {
  return raw === "help" || raw === "--h" || raw === "-help";
}

/**
 * Throws when a lookup for a `help` argument found nothing, so `buildCommand`
 * shows the command's help instead of an empty result.
 *
 * Call it only after the command looked `raw` up as a real value: a project,
 * dashboard, or organization named `help` must still be found.
 *
 * @param raw - The argument as typed
 * @param matches - How many results the lookup found
 */
export function throwIfHelpMatchedNothing(raw: unknown, matches: number): void {
  if (matches === 0 && isHelpArgument(raw)) {
    throw new ValidationError(`Nothing matches '${String(raw)}'.`);
  }
}

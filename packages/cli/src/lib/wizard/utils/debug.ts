/**
 * Debug output of the setup wizards, shown with the CLI's global `--verbose`
 * or `--log-level debug`.
 */

import { logger } from "../../logger.js";

const log = logger.withTag("wizard");

/** Log `args` at the CLI logger's debug level. */
export function debug(...args: unknown[]): void {
  log.debug(...args);
}

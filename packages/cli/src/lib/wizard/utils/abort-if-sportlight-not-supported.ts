/**
 * Stop a wizard whose platform has no Spotlight setup when `--spotlight` is
 * passed.
 */

import { clack } from "./clack/prompts.js";
import { abort } from "./clack/index.js";

/**
 * Aborts the wizard with a message that Spotlight mode is not yet supported
 * for the given platform.
 */
export async function abortIfSpotlightNotSupported(
  platform: string,
): Promise<never> {
  clack.log.warn(`Spotlight mode is not yet supported for ${platform}.`);
  clack.log.info("Spotlight is currently only available for Next.js.");

  return await abort("Exiting wizard", 0);
}

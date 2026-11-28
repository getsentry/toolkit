/**
 * Latest SDK versions from Sentry's release registry, which the wizards use
 * to pin the packages and plugins they add.
 */

import { debug } from "./debug.js";

const registryUrl = "https://release-registry.services.sentry.io";

/**
 * The latest released version of `sdk` (a registry key such as
 * `sentry.dart.flutter`), or `undefined` when the registry can't be reached
 * or doesn't list it.
 */
export async function fetchSdkVersion(
  sdk: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${registryUrl}/sdks`);
    if (!response.ok) {
      debug(`Release registry responded with ${response.status}.`);
      return undefined;
    }
    const data = (await response.json()) as Record<
      string,
      { version?: unknown } | undefined
    >;
    const version = data[sdk]?.version;
    return typeof version === "string" ? version : undefined;
  } catch (error) {
    // Callers fall back to a default version, so a failed lookup is fine.
    debug("Failed to fetch latest version from release registry.", error);
  }
  return undefined;
}

/**
 * Version range checks for installed SDK and framework versions.
 */

import {
  major,
  minVersion,
  type SemVer,
  satisfies,
  subset,
  valid,
  validRange,
} from "semver";
import { debug } from "./debug.js";

/**
 * Returns the major version of an exact version or the lowest version that a
 * range permits (e.g. `^10` -> 10, `~11.2.0` -> 11). Returns `undefined` for
 * missing or unparseable input.
 */
export function getMajorVersion(
  version: string | undefined,
): number | undefined {
  if (!version) {
    return undefined;
  }
  const minVer = safeMinVersion(version);
  return minVer ? major(minVer) : undefined;
}

/**
 * The lowest version that `range` permits, like semver's `minVersion`, but
 * `undefined` instead of a throw for specifiers that are not ranges, such as
 * `latest` or `workspace:*`.
 */
export function safeMinVersion(range: string): SemVer | undefined {
  try {
    return minVersion(range) ?? undefined;
  } catch (error) {
    debug(error);
    return undefined;
  }
}

export function fulfillsVersionRange({
  version,
  acceptableVersions,
  canBeLatest,
}: {
  version: string;
  acceptableVersions: string;
  canBeLatest: boolean;
}): boolean {
  if (version === "latest") {
    return canBeLatest;
  }

  let cleanedUserVersion, isRange;

  if (valid(version)) {
    cleanedUserVersion = valid(version);
    isRange = false;
  } else if (validRange(version)) {
    cleanedUserVersion = validRange(version);
    isRange = true;
  }

  return (
    // If the given version is a bogus format, this will still be undefined and we'll automatically reject it
    !!cleanedUserVersion &&
    (isRange
      ? subset(cleanedUserVersion, acceptableVersions)
      : satisfies(cleanedUserVersion, acceptableVersions))
  );
}

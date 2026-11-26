/**
 * Detect whether a Nuxt project runs Nuxt 4, either by its installed
 * version or by `future.compatibilityVersion: 4` in its config.
 */

import { gte, minVersion } from "semver";
import { loadFile } from "magicast";
import { abortIfCancelled } from "../utils/clack/index.js";
import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";

/**
 * Whether the project uses Nuxt 4.
 *
 * @param nuxtConfig - Path of the Nuxt config file
 * @param packageVersion - The `nuxt` version range from `package.json`
 */
export async function isNuxtV4(
  nuxtConfig: string,
  packageVersion: string | undefined,
): Promise<boolean> {
  if (!packageVersion) {
    return false;
  }

  const minVer = minVersion(packageVersion);
  if (minVer && gte(minVer, "4.0.0")) {
    return true;
  }

  // At the time of writing, nuxt 4 is not on its own
  // major yet. We must read the `compatibilityVersion`
  // from the nuxt config.
  try {
    const mod = await loadFile(nuxtConfig);
    const defaultExport = mod.exports["default"];
    const config =
      defaultExport.$type === "function-call"
        ? defaultExport.$args[0]
        : defaultExport;

    if (config?.future?.compatibilityVersion === 4) {
      return true;
    }
  } catch (error) {
    // Not fatal: when the config can't be parsed, ask instead.
    debug(error);
    return await abortIfCancelled(
      clack.confirm({ message: "Are you using Nuxt version 4?" }),
    );
  }

  return false;
}

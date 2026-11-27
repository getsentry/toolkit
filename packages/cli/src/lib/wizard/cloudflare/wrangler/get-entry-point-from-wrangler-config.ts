/**
 * Read the worker entry point (`main`) from the Wrangler config.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { getObjectProperty, parseJsonC } from "../../utils/ast-utils.js";
import { debug } from "../../utils/debug.js";
import { findWranglerConfig } from "./find-wrangler-config.js";

export const defaultEntryPoint = "src/index.ts";

/**
 * Reads the main entry point from the wrangler config file
 * Returns undefined if no config exists or if main field is not specified
 */
export function getEntryPointFromWranglerConfig(): string | undefined {
  const configFile = findWranglerConfig();

  if (!configFile) {
    return undefined;
  }

  const configPath = path.join(process.cwd(), configFile);
  const configContent = readFileSync(configPath, "utf-8");
  const extname = path.extname(configFile);

  switch (extname) {
    case ".toml": {
      const mainMatch = configContent.match(/^main\s*=\s*(["'])(.+?)\1/m);

      return mainMatch?.[2];
    }

    case ".json":
    case ".jsonc":
      try {
        const { jsonObject } = parseJsonC(configContent);

        if (!jsonObject) {
          return undefined;
        }

        const mainProperty = getObjectProperty(jsonObject, "main");

        if (
          (mainProperty?.value.type === "StringLiteral" ||
            mainProperty?.value.type === "Literal") &&
          typeof mainProperty.value.value === "string"
        ) {
          return mainProperty.value.value;
        }

        return undefined;
      } catch (error) {
        // An unparseable config has no entry point we can use
        debug(error);
        return undefined;
      }

    default:
      return undefined;
  }
}

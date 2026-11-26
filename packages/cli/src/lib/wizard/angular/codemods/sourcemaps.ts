/**
 * Turn on source maps for the production build of every project in
 * `angular.json`, or show the manual steps when that file can't be edited.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reportCliError } from "../../../error-reporting.js";
import { configureAngularSourcemapGenerationFlow } from "../../sourcemaps/tools/angular.js";
import { clack } from "../../utils/clack/prompts.js";
import { debug } from "../../utils/debug.js";

interface PartialAngularJson {
  projects?: Record<
    string,
    {
      architect?: {
        build?: {
          configurations?: {
            production?: {
              sourceMap?: boolean;
            } & Record<string, unknown>;
          };
        };
      };
    }
  >;
}

/** Set `sourceMap: true` on the production build of each `angular.json` project. */
export async function addSourcemapEntryToAngularJSON(): Promise<void> {
  const angularJsonPath = path.join(process.cwd(), "angular.json");
  const angularJson = getParsedAngularJson(angularJsonPath);

  if (!angularJson || typeof angularJson !== "object") {
    await configureAngularSourcemapGenerationFlow();
    return;
  }

  const updatedAngularJson = addSourceMapsSetting(angularJson);

  if (!updatedAngularJson) {
    await configureAngularSourcemapGenerationFlow();
    return;
  }

  try {
    writeFileSync(angularJsonPath, JSON.stringify(updatedAngularJson, null, 2));
  } catch (error) {
    clack.log.error(`Failed to write sourcemap configuration to angular.json`);
    reportCliError(error);
    await configureAngularSourcemapGenerationFlow();
  }
}

/**
 * Extracted from `addSourcemapEntryToAngularJSON` and exported to allow for easier testing.
 */
export function addSourceMapsSetting(
  angularJson: PartialAngularJson,
): PartialAngularJson | undefined {
  const newAngularJson = { ...angularJson };

  const projectKeys = Object.keys(newAngularJson.projects || {});

  if (!projectKeys.length || !newAngularJson.projects) {
    return undefined;
  }

  // Emit sourcemaps from all projects in angular.json
  for (const projectKey of projectKeys) {
    const projectConfig = newAngularJson.projects[projectKey];
    if (!projectConfig) {
      continue;
    }

    if (!projectConfig.architect) {
      projectConfig.architect = {};
    }

    if (!projectConfig.architect.build) {
      projectConfig.architect.build = {};
    }

    if (!projectConfig.architect.build.configurations) {
      projectConfig.architect.build.configurations = {};
    }

    projectConfig.architect.build.configurations.production = {
      ...projectConfig.architect.build.configurations.production,
      sourceMap: true,
    };
  }

  return newAngularJson;
}

function getParsedAngularJson(
  angularJsonPath: string,
): PartialAngularJson | undefined {
  try {
    const angularJSONFile = readFileSync(angularJsonPath, "utf-8");
    return JSON.parse(angularJSONFile) as PartialAngularJson | undefined;
  } catch (error) {
    // Not fatal: without a readable angular.json, the caller shows the
    // manual steps instead. A missing or hand-broken file is not a bug.
    debug(error);
    return undefined;
  }
}

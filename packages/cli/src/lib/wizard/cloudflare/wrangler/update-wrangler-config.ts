/**
 * Add the settings the Sentry SDK needs to the Wrangler config: edit a JSON
 * or JSONC config in place, or show the change for a TOML one.
 */

import type { namedTypes as t } from "ast-types";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import recast from "recast";

import {
  getObjectProperty,
  parseJsonC,
  printJsonC,
  setOrUpdateObjectProperty,
} from "../../utils/ast-utils.js";
import {
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { findWranglerConfig } from "./find-wrangler-config.js";

const b = recast.types.builders;

type WranglerConfigUpdates = {
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  version_metadata?: {
    binding: string;
  };
  [key: string]: unknown;
};

type WranglerConfigUpdateOptions = {
  /**
   * Compatibility flags to drop from an existing `compatibility_flags` array,
   * e.g. flags superseded by one of the flags being added.
   */
  removeCompatibilityFlags?: string[] | undefined;
};

const getTomlConfigSnippet = (
  updates: WranglerConfigUpdates,
  options: WranglerConfigUpdateOptions,
) => {
  const superseded = options.removeCompatibilityFlags ?? [];
  const { main } = updates;

  return makeCodeSnippet(true, (_unchanged, plus) =>
    plus(
      `${
        superseded.length
          ? `# Remove ${superseded
              .map((flag) => `"${flag}"`)
              .join(", ")} from compatibility_flags if present\n`
          : ""
      }${main ? `main = "${main}"\n` : ""}compatibility_flags = ["nodejs_compat"]
compatibility_date = "${new Date().toISOString().slice(0, 10)}"

[version_metadata]
binding = "CF_VERSION_METADATA"`,
    ),
  );
};

/**
 * Updates the wrangler config file with the provided configuration
 * Handles .toml (instructions only), .json, and .jsonc formats
 * For arrays: merges and deduplicates values
 * For objects: deep merges
 * For other types: overwrites
 */
export async function updateWranglerConfig(
  updates: WranglerConfigUpdates,
  options: WranglerConfigUpdateOptions = {},
): Promise<boolean> {
  const configFile = findWranglerConfig();

  if (!configFile) {
    clack.log.warn("No wrangler config file found.");

    return false;
  }

  const configPath = path.join(process.cwd(), configFile);

  try {
    const configContent = readFileSync(configPath, "utf-8");
    const extname = path.extname(configFile);

    switch (extname) {
      case ".jsonc":
      case ".json":
        updateJsoncConfig(configPath, configContent, updates, options);
        clack.log.success(
          `Updated ${chalk.cyan(configFile)} with Sentry configuration.`,
        );

        break;
      case ".toml":
        await showCopyPasteInstructions({
          filename: configFile,
          codeSnippet: getTomlConfigSnippet(updates, options),
        });
        break;
    }

    return true;
  } catch (error) {
    clack.log.error(
      `Failed to update ${chalk.cyan(configFile)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Sets a string property in a JSON/JSONC config object.
 * Overwrites any existing value.
 *
 * @param jsonObject The object expression to update
 * @param propertyName The name of the string property
 * @param value The string value to set
 */
function setStringProperty(
  jsonObject: t.ObjectExpression,
  propertyName: string,
  value: string,
): void {
  setOrUpdateObjectProperty(jsonObject, propertyName, b.stringLiteral(value));
}

/**
 * Merges an array property in a JSON/JSONC config object.
 * Extracts existing array values, merges with new values, and deduplicates.
 *
 * @param jsonObject The object expression to update
 * @param propertyName The name of the array property
 * @param newValues The new array values to merge in
 * @param valuesToRemove Existing values to drop before merging
 */
function mergeArrayProperty(
  jsonObject: t.ObjectExpression,
  propertyName: string,
  newValues: string[],
  valuesToRemove: string[] = [],
): void {
  const existingProperty = getObjectProperty(jsonObject, propertyName);
  const existingValues: string[] = [];

  // Extract existing values from the AST if they exist
  if (existingProperty?.value.type === "ArrayExpression") {
    for (const element of existingProperty.value.elements) {
      if (
        element &&
        (element.type === "StringLiteral" || element.type === "Literal") &&
        typeof element.value === "string"
      ) {
        existingValues.push(element.value);
      }
    }
  }

  // Merge existing and new values, deduplicate
  const allValues = [
    ...existingValues.filter((value) => !valuesToRemove.includes(value)),
    ...newValues,
  ];
  const uniqueValues = [...new Set(allValues)];

  setOrUpdateObjectProperty(
    jsonObject,
    propertyName,
    b.arrayExpression(uniqueValues.map((value) => b.stringLiteral(value))),
  );
}

/**
 * Merges properties into a nested object property in a JSON/JSONC config object.
 * Gets or creates the nested ObjectExpression if it doesn't exist,
 * then merges the provided properties into it, preserving existing properties.
 *
 * @param jsonObject The object expression to update
 * @param propertyName The name of the nested object property
 * @param updates The properties to merge into the nested object
 */
function setObjectProperty(
  jsonObject: t.ObjectExpression,
  propertyName: string,
  updates: object,
): void {
  const existingProperty = getObjectProperty(jsonObject, propertyName);
  let nestedObject: t.ObjectExpression;

  if (existingProperty?.value.type === "ObjectExpression") {
    nestedObject = existingProperty.value;
  } else {
    nestedObject = b.objectExpression([]);
    setOrUpdateObjectProperty(jsonObject, propertyName, nestedObject);
  }

  updateJsoncObject(nestedObject, updates);
}

function updateJsoncObject(
  jsonObject: t.ObjectExpression,
  updates: object,
  options: WranglerConfigUpdateOptions = {},
): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === "string") {
      setStringProperty(jsonObject, key, value);
    } else if (Array.isArray(value)) {
      mergeArrayProperty(
        jsonObject,
        key,
        value as string[],
        key === "compatibility_flags" ? options.removeCompatibilityFlags : [],
      );
    } else if (typeof value === "object") {
      setObjectProperty(jsonObject, key, value);
    }
  }
}

/**
 * Updates a JSON/JSONC config file using jsonc-parser
 * Preserves comments and formatting while merging values
 */
function updateJsoncConfig(
  configPath: string,
  content: string,
  updates: WranglerConfigUpdates,
  options: WranglerConfigUpdateOptions,
): void {
  const { jsonObject, ast } = parseJsonC(content);

  if (!jsonObject) {
    throw new Error("Failed to parse JSON/JSONC config file");
  }

  updateJsoncObject(jsonObject, updates, options);

  const code = printJsonC(ast);

  writeFileSync(configPath, code, "utf-8");
}

/**
 * Property-Based Tests for .sentryclirc Config Reader
 *
 * Verifies merge properties that should hold for any valid config:
 * - Monotonicity: adding files never removes resolved fields
 * - Closest-wins: closest file always takes priority per-field
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  array,
  asyncProperty,
  constantFrom,
  assert as fcAssert,
  record,
} from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CONFIG_FILENAME,
  clearSentryCliRcCache,
  loadSentryCliRc,
} from "../../src/lib/sentryclirc.js";
import { cleanupTestDir, createTestConfigDir } from "../helpers.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

let testDir: string;
let savedConfigDir: string | undefined;

beforeEach(async () => {
  clearSentryCliRcCache();
  savedConfigDir = process.env.SENTRY_CONFIG_DIR;
  testDir = await createTestConfigDir("sentryclirc-prop-", {
    isolateProjectRoot: true,
  });
  process.env.SENTRY_CONFIG_DIR = testDir;
});

afterEach(async () => {
  clearSentryCliRcCache();
  if (savedConfigDir !== undefined) {
    process.env.SENTRY_CONFIG_DIR = savedConfigDir;
  }
  await cleanupTestDir(testDir);
});

// Arbitraries

const slugChars = "abcdefghijklmnopqrstuvwxyz0123456789";
const slugArb = array(constantFrom(...slugChars.split("")), {
  minLength: 1,
  maxLength: 15,
}).map((chars) => chars.join(""));

const tokenArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
  {
    minLength: 5,
    maxLength: 20,
  }
).map((chars) => `sntrys_${chars.join("")}`);

/** Generate a partial config (each field may or may not be present) */
const partialConfigArb = record(
  {
    org: slugArb,
    project: slugArb,
    token: tokenArb,
  },
  { requiredKeys: [] }
);

type PartialConfig = { org?: string; project?: string; token?: string };

/** Serialize a partial config to .sentryclirc INI format */
function serializeConfig(config: PartialConfig): string {
  const lines: string[] = [];
  if (config.org || config.project) {
    lines.push("[defaults]");
    if (config.org) {
      lines.push(`org = ${config.org}`);
    }
    if (config.project) {
      lines.push(`project = ${config.project}`);
    }
  }
  if (config.token) {
    lines.push("[auth]");
    lines.push(`token = ${config.token}`);
  }
  return lines.join("\n");
}

/** Counter for creating unique subdirectories per property iteration */
let iterCounter = 0;

/** Create an isolated dir tree for one property test iteration */
function createIterDirs(): { parentDir: string; childDir: string } {
  iterCounter += 1;
  const parentDir = join(testDir, `iter-${iterCounter}`);
  const childDir = join(parentDir, "child");
  mkdirSync(childDir, { recursive: true });
  return { parentDir, childDir };
}

describe("property: loadSentryCliRc", () => {
  test("monotonicity: adding a parent config never removes resolved fields", async () => {
    await fcAssert(
      asyncProperty(
        partialConfigArb,
        partialConfigArb,
        async (childConfig, parentConfig) => {
          clearSentryCliRcCache();
          const { parentDir, childDir } = createIterDirs();

          // Create child with its config
          writeFileSync(
            join(childDir, CONFIG_FILENAME),
            serializeConfig(childConfig),
            "utf-8"
          );

          // Load with child only
          const resultChildOnly = await loadSentryCliRc(childDir);
          const fieldsChildOnly: string[] = [];
          if (resultChildOnly.org) fieldsChildOnly.push("org");
          if (resultChildOnly.project) fieldsChildOnly.push("project");
          if (resultChildOnly.token) fieldsChildOnly.push("token");

          clearSentryCliRcCache();

          // Now add parent config
          writeFileSync(
            join(parentDir, CONFIG_FILENAME),
            serializeConfig(parentConfig),
            "utf-8"
          );

          // Load again with parent also present
          const resultBoth = await loadSentryCliRc(childDir);

          // All fields that were set with child-only should still be set
          for (const field of fieldsChildOnly) {
            expect(resultBoth[field as keyof typeof resultBoth]).toBeDefined();
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("closest-wins: child config values always take priority over parent", async () => {
    await fcAssert(
      asyncProperty(
        partialConfigArb,
        partialConfigArb,
        async (childConfig, parentConfig) => {
          clearSentryCliRcCache();
          const { parentDir, childDir } = createIterDirs();

          // Write parent config
          writeFileSync(
            join(parentDir, CONFIG_FILENAME),
            serializeConfig(parentConfig),
            "utf-8"
          );

          // Write child config
          writeFileSync(
            join(childDir, CONFIG_FILENAME),
            serializeConfig(childConfig),
            "utf-8"
          );

          const result = await loadSentryCliRc(childDir);

          // For every field set in child config, the result should match the child's value
          if (childConfig.org) {
            expect(result.org).toBe(childConfig.org);
          }
          if (childConfig.project) {
            expect(result.project).toBe(childConfig.project);
          }
          if (childConfig.token) {
            expect(result.token).toBe(childConfig.token);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parent fills gaps: fields not in child come from parent", async () => {
    await fcAssert(
      asyncProperty(
        partialConfigArb,
        partialConfigArb,
        async (childConfig, parentConfig) => {
          clearSentryCliRcCache();
          const { parentDir, childDir } = createIterDirs();

          // Write parent config
          writeFileSync(
            join(parentDir, CONFIG_FILENAME),
            serializeConfig(parentConfig),
            "utf-8"
          );

          // Write child config
          writeFileSync(
            join(childDir, CONFIG_FILENAME),
            serializeConfig(childConfig),
            "utf-8"
          );

          const result = await loadSentryCliRc(childDir);

          // For fields NOT in child config, they should come from parent
          if (!childConfig.org && parentConfig.org) {
            expect(result.org).toBe(parentConfig.org);
          }
          if (!childConfig.project && parentConfig.project) {
            expect(result.project).toBe(parentConfig.project);
          }
          if (!childConfig.token && parentConfig.token) {
            expect(result.token).toBe(parentConfig.token);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

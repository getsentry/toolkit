/**
 * Property-based tests for detectDevCommand.
 *
 * Verifies that any script name in the priority set, when placed in a
 * package.json scripts object, is detected by detectDevCommand.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  asyncProperty,
  constantFrom,
  assert as fcAssert,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { detectDevCommand } from "../../src/lib/dev-script.js";
import { TEST_TMP_DIR } from "../constants.js";

const SCRIPT_NAMES = ["dev", "develop", "serve", "start"] as const;

/**
 * Arbitrary for a non-empty script value containing only safe chars
 * (letters, digits, spaces, dashes, dots). Avoids unicode/control chars
 * that would break the split assertion or filesystem.
 */
const scriptValueArb = string({
  unit: constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 -.".split("")),
  minLength: 1,
  maxLength: 30,
}).filter((s) => s.trim().length > 0);

describe("property: detectDevCommand", () => {
  test("any recognized script name in package.json is detected", async () => {
    await fcAssert(
      asyncProperty(
        constantFrom(...SCRIPT_NAMES),
        scriptValueArb,
        async (name, value) => {
          // Each iteration gets its own directory to avoid cross-contamination
          const dir = await mkdtemp(join(TEST_TMP_DIR, "dev-prop-"));
          try {
            await writeFile(
              join(dir, "package.json"),
              JSON.stringify({ scripts: { [name]: value } })
            );
            const result = await detectDevCommand(dir);
            expect(result).not.toBeNull();
            expect(result!.source).toBe(`package.json scripts.${name}`);
          } finally {
            // Best-effort cleanup — suppress errors
            rm(dir, { recursive: true, force: true }).catch(() => {
              /* intentionally empty */
            });
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});

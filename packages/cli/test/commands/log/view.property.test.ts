/**
 * Property-Based Tests for Log View Command
 *
 * Uses fast-check to verify invariants of parsePositionalArgs()
 * that should hold for any valid input.
 */

import {
  array,
  assert as fcAssert,
  property,
  stringMatching,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { parsePositionalArgs } from "../../../src/commands/log/view.js";
import { ContextError } from "../../../src/lib/errors.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Valid log IDs (32-char hex) */
const logIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** Valid org/project slugs */
const slugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/);

describe("parsePositionalArgs properties", () => {
  test("single valid log ID: returns it in rawLogIds with undefined targetArg", async () => {
    await fcAssert(
      property(logIdArb, (input) => {
        const result = parsePositionalArgs([input]);
        expect(result.rawLogIds).toEqual([input]);
        expect(result.targetArg).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single arg org/project/logId: splits into target and rawLogIds", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb, logIdArb), ([org, project, logId]) => {
        const combined = `${org}/${project}/${logId}`;
        const result = parsePositionalArgs([combined]);
        expect(result.targetArg).toBe(`${org}/${project}`);
        expect(result.rawLogIds).toEqual([logId]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single arg with one slash: throws ContextError (missing log ID)", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb), ([org, project]) => {
        expect(() => parsePositionalArgs([`${org}/${project}`])).toThrow(
          ContextError
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("two args (target + logId): first is targetArg, second is in rawLogIds", async () => {
    await fcAssert(
      property(tuple(slugArb, logIdArb), ([slug, logId]) => {
        const result = parsePositionalArgs([slug, logId]);
        expect(result.targetArg).toBe(slug);
        expect(result.rawLogIds).toEqual([logId]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("org/project target + logId: correctly splits target and rawLogIds", async () => {
    await fcAssert(
      property(tuple(slugArb, slugArb, logIdArb), ([org, project, logId]) => {
        const target = `${org}/${project}`;
        const result = parsePositionalArgs([target, logId]);

        expect(result.targetArg).toBe(target);
        expect(result.rawLogIds).toEqual([logId]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("multiple log IDs: all IDs present in result", async () => {
    await fcAssert(
      property(
        tuple(slugArb, array(logIdArb, { minLength: 1, maxLength: 5 })),
        ([slug, ids]) => {
          const args = [slug, ...ids];
          const result = parsePositionalArgs(args);

          expect(result.targetArg).toBe(slug);
          expect(result.rawLogIds).toEqual(ids);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("newline-joined IDs in single arg: split correctly", async () => {
    await fcAssert(
      property(
        tuple(slugArb, array(logIdArb, { minLength: 2, maxLength: 5 })),
        ([slug, ids]) => {
          const combined = ids.join("\n");
          const result = parsePositionalArgs([slug, combined]);

          expect(result.targetArg).toBe(slug);
          expect(result.rawLogIds).toEqual(ids);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parsing is deterministic: same input always produces same output", async () => {
    await fcAssert(
      property(tuple(slugArb, logIdArb), ([slug, logId]) => {
        const result1 = parsePositionalArgs([slug, logId]);
        const result2 = parsePositionalArgs([slug, logId]);
        expect(result1).toEqual(result2);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty args always throws ContextError", () => {
    expect(() => parsePositionalArgs([])).toThrow(ContextError);
  });

  test("result always has non-empty rawLogIds array", async () => {
    await fcAssert(
      property(tuple(slugArb, logIdArb), ([slug, logId]) => {
        const result = parsePositionalArgs([slug, logId]);
        expect(result.rawLogIds.length).toBeGreaterThan(0);
        for (const id of result.rawLogIds) {
          expect(typeof id).toBe("string");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result targetArg is undefined for single ID, defined for target + ID", async () => {
    // Single arg case
    await fcAssert(
      property(logIdArb, (input) => {
        const result = parsePositionalArgs([input]);
        expect(result.targetArg).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );

    // Two+ args case
    await fcAssert(
      property(tuple(slugArb, logIdArb), ([slug, logId]) => {
        const result = parsePositionalArgs([slug, logId]);
        expect(result.targetArg).toBeDefined();
        expect(typeof result.targetArg).toBe("string");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

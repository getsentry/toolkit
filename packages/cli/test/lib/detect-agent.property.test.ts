/**
 * Property-Based Tests for Agent Normalization
 *
 * Uses fast-check to verify invariants that should hold for any input
 * to normalizeAgent(), regardless of content.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { AGENT_ALIASES, normalizeAgent } from "../../src/lib/detect-agent.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/** Characters valid in agent names (lowercase alphanum + hyphens). */
const agentNameChars = "abcdefghijklmnopqrstuvwxyz0123456789-";

/**
 * Values treated as boolean-ish garbage by normalizeAgent.
 * Excluded from the agent name arbitrary to prevent false failures
 * in compound tests where version/role extraction is asserted.
 */
const GARBAGE_NAMES = new Set([
  "0",
  "1",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
]);

/** Generate valid-looking agent names (lowercase, no leading/trailing dash, not garbage). */
const agentNameArb = array(constantFrom(...agentNameChars.split("")), {
  minLength: 2,
  maxLength: 20,
})
  .map((chars) => chars.join(""))
  .filter(
    (s) =>
      /^[a-z]/.test(s) &&
      !s.endsWith("-") &&
      !s.includes("--") &&
      !GARBAGE_NAMES.has(s)
  );

/** Generate semver-ish version strings. */
const versionArb = tuple(
  constantFrom(...Array.from({ length: 20 }, (_, i) => String(i))),
  constantFrom(...Array.from({ length: 20 }, (_, i) => String(i))),
  constantFrom(...Array.from({ length: 100 }, (_, i) => String(i)))
).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Generate role strings. */
const roleArb = constantFrom("agent", "assistant", "bot", "worker", "cli");

/** Truthy garbage — signals "agent present" but unnamed → { name: "unknown" }. */
const truthyGarbageArb = constantFrom("1", "true", "yes", "on", "TRUE", "YES");

/** Falsy garbage — signals "no agent" / opt-out → undefined. */
const falsyGarbageArb = constantFrom("0", "false", "no", "off", "False", "NO");

/** Generate compound agent strings: name/version/role. */
const compoundArb = tuple(agentNameArb, versionArb, roleArb).map(
  ([name, version, role]) => `${name}/${version}/${role}`
);

describe("property: normalizeAgent", () => {
  test("name is always lowercase when defined", () => {
    fcAssert(
      property(oneof(agentNameArb, compoundArb, truthyGarbageArb), (raw) => {
        const result = normalizeAgent(raw);
        expect(result).toBeDefined();
        expect(result!.name).toBe(result!.name.toLowerCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("name is always non-empty when defined", () => {
    fcAssert(
      property(oneof(agentNameArb, compoundArb, truthyGarbageArb), (raw) => {
        const result = normalizeAgent(raw);
        expect(result).toBeDefined();
        expect(result!.name.length).toBeGreaterThan(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("truthy garbage always produces 'unknown'", () => {
    fcAssert(
      property(truthyGarbageArb, (raw) => {
        const result = normalizeAgent(raw);
        expect(result).toEqual({ name: "unknown" });
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("falsy garbage always returns undefined", () => {
    fcAssert(
      property(falsyGarbageArb, (raw) => {
        expect(normalizeAgent(raw)).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("version is always digits-and-dots when present", () => {
    fcAssert(
      property(compoundArb, (raw) => {
        const result = normalizeAgent(raw);
        expect(result).toBeDefined();
        if (result?.version) {
          expect(result.version).toMatch(/^\d+(\.\d+)*$/);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("version never has leading v", () => {
    fcAssert(
      property(
        tuple(agentNameArb, versionArb).map(([name, ver]) => `${name}/v${ver}`),
        (raw) => {
          const result = normalizeAgent(raw);
          expect(result).toBeDefined();
          if (result?.version) {
            expect(result.version.startsWith("v")).toBe(false);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("alias keys always resolve to their mapped value", () => {
    fcAssert(
      property(constantFrom(...AGENT_ALIASES.keys()), (aliasKey) => {
        const result = normalizeAgent(aliasKey);
        expect(result).toBeDefined();
        expect(result!.name).toBe(AGENT_ALIASES.get(aliasKey));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: normalizing the name again yields same name", () => {
    fcAssert(
      property(oneof(agentNameArb, compoundArb), (raw) => {
        const first = normalizeAgent(raw);
        expect(first).toBeDefined();
        const second = normalizeAgent(first!.name);
        expect(second).toBeDefined();
        expect(second!.name).toBe(first!.name);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("compound: name/version always extracts version", () => {
    fcAssert(
      property(tuple(agentNameArb, versionArb), ([name, version]) => {
        const result = normalizeAgent(`${name}/${version}`);
        expect(result).toBeDefined();
        expect(result!.version).toBe(version);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("compound: name/version/role always extracts role", () => {
    fcAssert(
      property(
        tuple(agentNameArb, versionArb, roleArb),
        ([name, version, role]) => {
          const result = normalizeAgent(`${name}/${version}/${role}`);
          expect(result).toBeDefined();
          expect(result!.role).toBe(role);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("simple name never has version or role", () => {
    fcAssert(
      property(agentNameArb, (name) => {
        const result = normalizeAgent(name);
        expect(result).toBeDefined();
        expect(result!.version).toBeUndefined();
        expect(result!.role).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

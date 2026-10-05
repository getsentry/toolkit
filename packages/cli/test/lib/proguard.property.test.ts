/**
 * Property-based + golden tests for ProGuard mapping UUID computation.
 *
 * The golden vectors are taken directly from the legacy `sentry-cli`
 * integration test fixtures (`tests/integration/_cases/proguard/`) and verify
 * byte-for-byte parity with the `rust-proguard` crate's `uuid()`.
 */

import { assert as fcAssert, property, uint8Array } from "fast-check";
import { describe, expect, test } from "vitest";
import {
  computeProguardUuid,
  PROGUARD_NAMESPACE,
} from "../../src/lib/proguard.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/** Lowercase hyphenated UUID shape (8-4-4-4-12 hex). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("proguard: computeProguardUuid", () => {
  test("derived namespace matches legacy sentry-cli", () => {
    // uuidv5(NAMESPACE_DNS, "guardsquare.com")
    expect(PROGUARD_NAMESPACE).toBe("4f44f30f-24be-53d0-bab6-f47c7120ad6c");
  });

  test("golden: 'void\\n' fixture", () => {
    // tests/integration/_fixtures/proguard.txt (5 bytes)
    const uuid = computeProguardUuid(Buffer.from("void\n", "utf-8"));
    expect(uuid).toBe("5db7294d-87fc-5726-a5c0-4a90679657a5");
  });

  test("golden: sample mapping.txt fixture", () => {
    // tests/integration/_fixtures/proguard/upload/mapping.txt (155 bytes)
    const mapping =
      "HelloWorld -> HelloWorld:\n" +
      '# {"fileName":"HelloWorld.java","id":"sourceFile"}\n' +
      "    1:1:void <init>() -> <init>\n" +
      "    3:4:void main(java.lang.String[]) -> main\n";
    const uuid = computeProguardUuid(Buffer.from(mapping, "utf-8"));
    expect(uuid).toBe("c038584d-c366-570c-ad1e-034fa0d194d7");
  });

  test("always returns a well-formed lowercase UUID with version 5", () => {
    fcAssert(
      property(uint8Array(), (bytes) => {
        const uuid = computeProguardUuid(Buffer.from(bytes));
        expect(uuid).toMatch(UUID_RE);
        // Version nibble (first char of 3rd group) is always 5.
        expect(uuid[14]).toBe("5");
        // Variant nibble (first char of 4th group) is RFC 4122 (8/9/a/b).
        expect(["8", "9", "a", "b"]).toContain(uuid[19]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic: same bytes yield the same UUID", () => {
    fcAssert(
      property(uint8Array(), (bytes) => {
        const a = computeProguardUuid(Buffer.from(bytes));
        const b = computeProguardUuid(Buffer.from(bytes));
        expect(a).toBe(b);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("differs when content differs", () => {
    fcAssert(
      property(uint8Array({ minLength: 1 }), (bytes) => {
        const original = Buffer.from(bytes);
        const mutated = Buffer.from(bytes);
        // Flip the first byte to guarantee different content.
        mutated[0] = (mutated[0]! + 1) % 256;
        expect(computeProguardUuid(original)).not.toBe(
          computeProguardUuid(mutated)
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

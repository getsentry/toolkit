import { array, constantFrom, assert as fcAssert, property } from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  parseReleaseArg,
  resolveReleaseTarget,
} from "../../src/commands/release/parse.js";
import { ContextError, ValidationError } from "../../src/lib/errors.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

vi.mock("../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../src/lib/resolve-target.js";

const slugChars = "abcdefghijklmnopqrstuvwxyz0123456789";

const simpleSlugArb = array(constantFrom(...slugChars.split("")), {
  minLength: 1,
  maxLength: 15,
}).map((chars) => chars.join(""));

const slugWithHyphensArb = array(constantFrom(...`${slugChars}-`.split("")), {
  minLength: 2,
  maxLength: 20,
})
  .map((chars) => chars.join(""))
  .filter((s) => !(s.startsWith("-") || s.endsWith("-") || s.includes("--")));

const versionArb = array(
  constantFrom(..."0123456789.abcdefghijklmnopqrstuvwxyz-+@".split("")),
  { minLength: 1, maxLength: 20 }
).map((chars) => chars.join(""));

describe("property: parseReleaseArg", () => {
  test("round-trip: org/version → orgSlug + '/' + version === input", () => {
    fcAssert(
      property(slugWithHyphensArb, versionArb, (slug, version) => {
        const input = `${slug}/${version}`;
        const result = parseReleaseArg(input, "test");
        if (result.orgSlug) {
          expect(`${result.orgSlug}/${result.version}`).toBe(input);
        } else {
          expect(result.version).toBe(input);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("version with @ is never split into org", () => {
    fcAssert(
      property(
        versionArb.filter((v) => v.includes("@")),
        (version) => {
          const result = parseReleaseArg(version, "test");
          // The @ in the prefix would make it not match SLUG_RE
          // so the whole string should be the version
          expect(result.version).toBe(version);
          expect(result.orgSlug).toBeUndefined();
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("valid slug prefix always extracts org", () => {
    fcAssert(
      property(
        simpleSlugArb,
        versionArb.filter((v) => v.length > 0),
        (slug, version) => {
          const input = `${slug}/${version}`;
          const result = parseReleaseArg(input, "test");
          expect(result.orgSlug).toBe(slug);
          expect(result.version).toBe(version);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("plain version without slash returns no org", () => {
    fcAssert(
      property(
        versionArb.filter((v) => !v.includes("/") && v.length > 0),
        (version) => {
          const result = parseReleaseArg(version, "test");
          expect(result.orgSlug).toBeUndefined();
          expect(result.version).toBe(version);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("unit: parseReleaseArg edge cases", () => {
  test("empty string throws ValidationError", () => {
    expect(() => parseReleaseArg("", "test")).toThrow(ValidationError);
  });

  test("sentry-cli@0.24.0 is a plain version (no org)", () => {
    const result = parseReleaseArg("sentry-cli@0.24.0", "test");
    expect(result.version).toBe("sentry-cli@0.24.0");
    expect(result.orgSlug).toBeUndefined();
  });

  test("my-org/1.0.0 extracts org and version", () => {
    const result = parseReleaseArg("my-org/1.0.0", "test");
    expect(result.orgSlug).toBe("my-org");
    expect(result.version).toBe("1.0.0");
  });

  test("my-org/sentry-cli@0.24.0 extracts org and version with @", () => {
    const result = parseReleaseArg("my-org/sentry-cli@0.24.0", "test");
    expect(result.orgSlug).toBe("my-org");
    expect(result.version).toBe("sentry-cli@0.24.0");
  });

  test("version with leading slash treated as plain version", () => {
    const result = parseReleaseArg("/1.0.0", "test");
    expect(result.version).toBe("/1.0.0");
    expect(result.orgSlug).toBeUndefined();
  });
});

describe("unit: resolveReleaseTarget", () => {
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    resolveOrgSpy.mockRestore();
  });

  const USAGE = "sentry release archive [<org>/]<version>";

  test("resolves version and org from a target", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    const result = await resolveReleaseTarget("my-org/1.0.0", USAGE, "/tmp");
    expect(result).toEqual({ version: "1.0.0", org: "my-org" });
    expect(resolveOrgSpy).toHaveBeenCalledWith({ org: "my-org", cwd: "/tmp" });
  });

  test("forwards detectedFrom from the resolved org", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org", detectedFrom: "DSN" });
    const result = await resolveReleaseTarget("1.0.0", USAGE, "/tmp");
    expect(result.detectedFrom).toBe("DSN");
  });

  test("throws ContextError when target is undefined", async () => {
    await expect(
      resolveReleaseTarget(undefined, USAGE, "/tmp")
    ).rejects.toThrow(ContextError);
  });

  test("throws ContextError when target is whitespace", async () => {
    await expect(resolveReleaseTarget("   ", USAGE, "/tmp")).rejects.toThrow(
      "Release version"
    );
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);
    await expect(resolveReleaseTarget("1.0.0", USAGE, "/tmp")).rejects.toThrow(
      ContextError
    );
  });
});

import { describe, expect, test, vi, afterEach } from "vitest";
import {
  resolveRunCode,
  buildStageExtra,
  toClosedRunError,
  formatProgress,
} from "../../../src/commands/onboarding/progress.js";
import {
  ApiError,
  ContextError,
  ValidationError,
} from "../../../src/lib/errors.js";

// ---------------------------------------------------------------------------
// resolveRunCode
// ---------------------------------------------------------------------------

describe("resolveRunCode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("returns the flag value when it matches the pattern", () => {
    expect(resolveRunCode("abcd12efg0")).toBe("abcd12efg0");
  });

  test("falls back to SENTRY_ONBOARDING_RUN_CODE when no flag is passed", () => {
    vi.stubEnv("SENTRY_ONBOARDING_RUN_CODE", "ZZZZZZZZZZ");
    expect(resolveRunCode(undefined)).toBe("ZZZZZZZZZZ");
  });

  test("throws ContextError when no flag and no env var", () => {
    vi.stubEnv("SENTRY_ONBOARDING_RUN_CODE", "");
    expect(() => resolveRunCode(undefined)).toThrow(ContextError);
  });

  test("throws ValidationError for a code that is not 10 alphanumeric characters", () => {
    expect(() => resolveRunCode("short")).toThrow(ValidationError);
    expect(() => resolveRunCode("has_symbols!")).toThrow(ValidationError);
    expect(() => resolveRunCode("11chars_too")).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// buildStageExtra
// ---------------------------------------------------------------------------

function flags(
  stage: string,
  overrides: Record<string, string | undefined> = {},
) {
  return {
    stage,
    status: "active",
    json: false,
    ...overrides,
  } as Parameters<typeof buildStageExtra>[0];
}

describe("buildStageExtra", () => {
  test("returns connection method extra for connect_agent", () => {
    expect(buildStageExtra(flags("connect_agent"))).toEqual({ method: "cli" });
  });

  test("returns projectSlugs extra for create_project with --project", () => {
    expect(
      buildStageExtra(flags("create_project", { project: "web,api" })),
    ).toEqual({ projectSlugs: ["web", "api"] });
  });

  test("returns issueIds extra for receive_verification_error with --issue", () => {
    expect(
      buildStageExtra(
        flags("receive_verification_error", { issue: "123,456" }),
      ),
    ).toEqual({ issueIds: ["123", "456"] });
  });

  test("returns undefined for stages with no extra metadata", () => {
    expect(buildStageExtra(flags("analyze_project"))).toBeUndefined();
    expect(buildStageExtra(flags("instrument_app"))).toBeUndefined();
  });

  test("throws ValidationError when --project is used on the wrong stage", () => {
    expect(() =>
      buildStageExtra(flags("instrument_app", { project: "my-org" })),
    ).toThrow(ValidationError);
  });

  test("throws ValidationError when --issue is used on the wrong stage", () => {
    expect(() =>
      buildStageExtra(flags("connect_agent", { issue: "123" })),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// toClosedRunError
// ---------------------------------------------------------------------------

describe("toClosedRunError", () => {
  test.each([404, 409, 410])(
    "wraps HTTP %i as an ApiError with the stop message",
    (status) => {
      const original = new ApiError("not found", status, undefined, "/path");
      const result = toClosedRunError(original);
      expect(result).toBeInstanceOf(ApiError);
      expect((result as ApiError).status).toBe(status);
      expect((result as ApiError).message).toContain(
        "no longer accepts updates",
      );
    },
  );

  test("passes non-closed API errors through unchanged", () => {
    const original = new ApiError("server error", 500, undefined, "/path");
    expect(toClosedRunError(original)).toBe(original);
  });

  test("passes non-ApiError through unchanged", () => {
    const original = new Error("network failure");
    expect(toClosedRunError(original)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// formatProgress
// ---------------------------------------------------------------------------

describe("formatProgress", () => {
  test("says yes when continueUpdates is true", () => {
    expect(formatProgress({ continueUpdates: true })).toContain("yes");
  });

  test("says no when continueUpdates is false", () => {
    expect(formatProgress({ continueUpdates: false })).toContain("no");
  });
});

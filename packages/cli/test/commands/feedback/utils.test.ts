/**
 * Feedback resolution tests.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveFeedback } from "../../../src/commands/feedback/utils.js";
import { ApiError, type ResolutionError } from "../../../src/lib/errors.js";
import type { SentryIssue } from "../../../src/types/index.js";

vi.mock("../../../src/commands/issue/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/commands/issue/utils.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as issueUtils from "../../../src/commands/issue/utils.js";

function issue(overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    id: "123",
    shortId: "TEST-PROJECT-1A",
    title: "User Feedback",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveFeedback", () => {
  test("uses issue resolution with feedback-specific command hints", async () => {
    const resolveIssueSpy = vi
      .spyOn(issueUtils, "resolveIssue")
      .mockResolvedValue({
        org: "test-org",
        issue: issue({
          issueCategory: "feedback",
          issueType: "feedback",
          metadata: { message: "Broken" },
        }),
      });

    const resolved = await resolveFeedback("TEST-PROJECT-1A", "/tmp");

    expect(resolveIssueSpy).toHaveBeenCalledWith({
      issueArg: "TEST-PROJECT-1A",
      cwd: "/tmp",
      command: "view",
      commandBase: "sentry feedback",
    });
    expect(resolved.feedback.issueCategory).toBe("feedback");
  });

  test("rejects ordinary issues with an issue-view recovery hint", async () => {
    vi.spyOn(issueUtils, "resolveIssue").mockResolvedValue({
      org: "test-org",
      issue: issue({ issueCategory: "error", issueType: "error" }),
    });

    await expect(
      resolveFeedback("TEST-PROJECT-1A", "/tmp")
    ).rejects.toMatchObject<Partial<ResolutionError>>({
      name: "ResolutionError",
      hint: "sentry issue view test-org/TEST-PROJECT-1A",
    });
  });

  test("translates short-ID 404s to feedback-specific recovery", async () => {
    vi.spyOn(issueUtils, "resolveIssue").mockRejectedValue(
      new ApiError("Short ID not found", 404)
    );

    await expect(
      resolveFeedback("TEST-PROJECT-404", "/tmp")
    ).rejects.toMatchObject<Partial<ResolutionError>>({
      name: "ResolutionError",
      hint: "sentry feedback view <org>/TEST-PROJECT-404",
      suggestions: ["List available Feedback: sentry feedback list"],
    });
  });

  test("keeps mutation recovery hints on the requested command", async () => {
    const resolveIssueSpy = vi
      .spyOn(issueUtils, "resolveIssue")
      .mockRejectedValue(new ApiError("Short ID not found", 404));

    await expect(
      resolveFeedback("TEST-PROJECT-404", "/tmp", "resolve")
    ).rejects.toMatchObject<Partial<ResolutionError>>({
      name: "ResolutionError",
      hint: "sentry feedback resolve <org>/TEST-PROJECT-404",
    });
    expect(resolveIssueSpy).toHaveBeenCalledWith({
      issueArg: "TEST-PROJECT-404",
      cwd: "/tmp",
      command: "resolve",
      commandBase: "sentry feedback",
    });
  });
});

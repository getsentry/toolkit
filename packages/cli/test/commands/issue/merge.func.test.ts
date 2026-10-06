/**
 * Issue Merge Command Tests
 *
 * Tests for `sentry issue merge` func() body — arg validation, cross-org
 * rejection, --into parent selection, and API call shape.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mergeCommand } from "../../../src/commands/issue/merge.js";

vi.mock("../../../src/commands/issue/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/commands/issue/utils.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as issueUtils from "../../../src/commands/issue/utils.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import {
  ApiError,
  AuthError,
  ResolutionError,
} from "../../../src/lib/errors.js";
import type { SentryIssue } from "../../../src/types/sentry.js";

function makeMockIssue(overrides?: Partial<SentryIssue>): SentryIssue {
  return {
    id: "100",
    shortId: "CLI-A",
    title: "Boom",
    culprit: "handler",
    count: "10",
    userCount: 1,
    firstSeen: "2026-03-01T00:00:00Z",
    lastSeen: "2026-04-03T12:00:00Z",
    level: "error",
    status: "unresolved",
    permalink: "https://sentry.io/organizations/test-org/issues/100/",
    project: { id: "1", slug: "cli", name: "cli" },
    ...overrides,
  } as SentryIssue;
}

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

describe("mergeCommand.func()", () => {
  let resolveIssueSpy: ReturnType<typeof spyOn>;
  let mergeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    mergeSpy = vi.spyOn(apiClient, "mergeIssues");
  });

  afterEach(() => {
    resolveIssueSpy.mockRestore();
    mergeSpy.mockRestore();
  });

  test("rejects when fewer than 2 issues are provided (0 positionals, no --into)", async () => {
    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false })
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("needs at least 2 issue IDs");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("rejects when 1 positional is given without --into (shows --into hint)", async () => {
    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false }, "CLI-A")
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("needs at least 2 issue IDs");
    expect(err.message).toContain("--into");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("rejects when 0 positionals + --into (still needs at least 1 positional)", async () => {
    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false, into: "CLI-B" })
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("needs at least 2 issue IDs");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("accepts 1 positional + --into as a valid 2-issue merge (CLI-1AE fix)", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    // Sentry honors the --into preference in this case
    mergeSpy.mockResolvedValue({ parent: "10B", children: ["10A"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    // The user's actual pattern that triggered CLI-1AE:
    //   sentry issue merge CLI-A --into CLI-B
    await func.call(context, { json: false, into: "CLI-B" }, "CLI-A");

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    const callArgs = mergeSpy.mock.calls[0] as [string, string[]];
    expect(callArgs[0]).toBe("test-org");
    // CLI-B (--into target) moved to front as preferred parent
    expect(callArgs[1][0]).toBe("10B");
    expect(new Set(callArgs[1])).toEqual(new Set(["10A", "10B"]));
  });

  test("1 positional + --into same issue triggers dedupe guard", async () => {
    // sentry issue merge CLI-A --into CLI-A — both resolve to the same group
    resolveIssueSpy.mockImplementation(() =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({ shortId: "CLI-A", id: "100" }),
      })
    );

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false, into: "CLI-A" }, "CLI-A")
      .catch((e: Error) => e);

    expect(err.message).toContain("at least 2 distinct issues");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("rejects issues where org could not be determined", async () => {
    // One issue resolves without org (e.g. bare numeric ID, no DSN match),
    // the other has a known org — without the guard, the merge would
    // silently proceed to the known org and fail with a confusing API error.
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) => {
      if (issueArg === "CLI-A") {
        return Promise.resolve({
          org: "my-org",
          issue: makeMockIssue({ shortId: "CLI-A", id: "10A" }),
        });
      }
      return Promise.resolve({
        org: undefined,
        issue: makeMockIssue({ shortId: "NO-ORG", id: "999" }),
      });
    });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false }, "CLI-A", "999")
      .catch((e: Error) => e);

    expect(err.message).toContain("Could not determine the organization");
    expect(err.message).toContain("NO-ORG");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("rejects cross-org merges with a friendly message", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: issueArg === "CLI-A" ? "org-one" : "org-two",
        issue: makeMockIssue({ shortId: issueArg, id: issueArg }),
      })
    );

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false }, "CLI-A", "CLI-B")
      .catch((e: Error) => e);

    expect(err.message).toContain("Cannot merge issues across organizations");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("calls mergeIssues with the resolved numeric IDs", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    mergeSpy.mockResolvedValue({ parent: "10A", children: ["10B", "10C"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    await func.call(context, { json: false }, "CLI-A", "CLI-B", "CLI-C");

    expect(mergeSpy).toHaveBeenCalledWith("test-org", ["10A", "10B", "10C"]);
  });

  test("--into pins the parent by short ID", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    mergeSpy.mockResolvedValue({ parent: "10B", children: ["10A", "10C"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    // Pass A, B, C but pin B as parent — ordered list sent to API starts with B
    await func.call(
      context,
      { json: false, into: "CLI-B" },
      "CLI-A",
      "CLI-B",
      "CLI-C"
    );

    const callArgs = mergeSpy.mock.calls[0] as [string, string[]];
    expect(callArgs[0]).toBe("test-org");
    expect(callArgs[1][0]).toBe("10B"); // parent moved to front
    expect(new Set(callArgs[1])).toEqual(new Set(["10A", "10B", "10C"]));
  });

  test("--into accepts project-alias suffix (e.g. 'f-g')", async () => {
    // When the user passes `f-g` as --into, it doesn't match any shortId
    // on the direct-match fast path, so the command falls back to
    // resolveIssue and then matches by numeric ID.
    let callIdx = 0;
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) => {
      callIdx += 1;
      // Positional args resolve to CLI-A / CLI-B
      if (issueArg === "CLI-A" || issueArg === "CLI-B") {
        return Promise.resolve({
          org: "test-org",
          issue: makeMockIssue({
            shortId: issueArg,
            id: issueArg.replace("CLI-", "10"),
          }),
        });
      }
      // --into 'f-g' resolves (alias lookup) to CLI-B
      if (issueArg === "f-g") {
        return Promise.resolve({
          org: "test-org",
          issue: makeMockIssue({ shortId: "CLI-B", id: "10B" }),
        });
      }
      return Promise.reject(new Error(`unexpected issueArg: ${issueArg}`));
    });
    mergeSpy.mockResolvedValue({ parent: "10B", children: ["10A"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    await func.call(context, { json: false, into: "f-g" }, "CLI-A", "CLI-B");

    const callArgs = mergeSpy.mock.calls[0] as [string, string[]];
    // Parent (10B) moved to front of the merge call
    expect(callArgs[1][0]).toBe("10B");
    // Three resolve calls total: 2 positional + 1 alias fallback
    expect(callIdx).toBeGreaterThanOrEqual(3);
  });

  test("--into accepts org-qualified short ID", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          // resolveIssue returns bare short ID even if arg was org-qualified
          shortId: issueArg.split("/").pop() as string,
          id: (issueArg.split("/").pop() as string).replace("CLI-", "10"),
        }),
      })
    );
    mergeSpy.mockResolvedValue({ parent: "10B", children: ["10A", "10C"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    // User passes org-qualified form to --into; should still match.
    await func.call(
      context,
      { json: false, into: "my-org/CLI-B" },
      "CLI-A",
      "CLI-B",
      "CLI-C"
    );

    const callArgs = mergeSpy.mock.calls[0] as [string, string[]];
    expect(callArgs[1][0]).toBe("10B"); // parent still moved to front
  });

  test("--into adds a new issue not listed as a positional (CLI-1AF fix)", async () => {
    // `sentry issue merge CLI-A CLI-B --into CLI-C` should merge all three,
    // with CLI-C (the --into target) as the preferred parent. Previously the
    // --into value was dropped whenever 2+ positionals were given.
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    mergeSpy.mockResolvedValue({ parent: "10C", children: ["10A", "10B"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    await func.call(context, { json: false, into: "CLI-C" }, "CLI-A", "CLI-B");

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    const callArgs = mergeSpy.mock.calls[0] as [string, string[]];
    expect(callArgs[0]).toBe("test-org");
    // CLI-C (--into target) is included and moved to the front as parent.
    expect(callArgs[1][0]).toBe("10C");
    expect(new Set(callArgs[1])).toEqual(new Set(["10A", "10B", "10C"]));
  });

  test("JSON output maps numeric IDs back to short IDs with URL", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    mergeSpy.mockResolvedValue({ parent: "10A", children: ["10B"] });

    const { context, stdoutWrite } = createMockContext();
    const func = await mergeCommand.loader();
    await func.call(context, { json: true }, "CLI-A", "CLI-B");

    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output) as {
      org: string;
      parent: { shortId: string; id: string; url: string };
      children: { shortId: string; id: string }[];
    };
    expect(parsed.org).toBe("test-org");
    expect(parsed.parent.shortId).toBe("CLI-A");
    expect(parsed.parent.id).toBe("10A");
    // URL surfaces the canonical parent so users can click through.
    expect(parsed.parent.url).toContain("test-org");
    expect(parsed.parent.url).toContain("10A");
    expect(parsed.children).toEqual([{ shortId: "CLI-B", id: "10B" }]);
  });

  test("warns when --into preference is overridden by Sentry", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    // User asked for CLI-B, but Sentry picked CLI-A (e.g. larger by count)
    mergeSpy.mockResolvedValue({ parent: "10A", children: ["10B"] });

    // Warning now goes through log.warn() (consola → process.stderr), not
    // this.stderr.write(). Spy on process.stderr.write to capture it.
    const stderrSpy = vi.spyOn(process.stderr, "write");
    try {
      const { context } = createMockContext();
      const func = await mergeCommand.loader();
      await func.call(
        context,
        { json: false, into: "CLI-B" },
        "CLI-A",
        "CLI-B"
      );

      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderr).toContain("--into 'CLI-B' was a preference");
      expect(stderr).toContain("CLI-A as the canonical parent");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("does not warn when --into preference was honored", async () => {
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      })
    );
    // User asked for CLI-B, Sentry agreed.
    mergeSpy.mockResolvedValue({ parent: "10B", children: ["10A"] });

    const stderrSpy = vi.spyOn(process.stderr, "write");
    try {
      const { context } = createMockContext();
      const func = await mergeCommand.loader();
      await func.call(
        context,
        { json: false, into: "CLI-B" },
        "CLI-A",
        "CLI-B"
      );

      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderr).not.toContain("--into");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("rejects duplicate issue IDs after resolution (same issue in multiple forms)", async () => {
    // User passes `CLI-A` and `100` which both resolve to the same numeric
    // group id — without the dedupe guard, we'd send `?id=100&id=100` to
    // Sentry and get back a confusing 204 → "no matching issues" error.
    resolveIssueSpy.mockImplementation(() =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({ shortId: "CLI-A", id: "100" }),
      })
    );

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false }, "CLI-A", "100")
      .catch((e: Error) => e);

    expect(err.message).toContain("at least 2 distinct issues");
    expect(err.message).toContain("CLI-A");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("--into propagates auth errors instead of masking them as 'not found'", async () => {
    // --into is resolved as part of the merge set. When resolving it throws
    // AuthError, the error must propagate — not be masked as a generic
    // "not found", which would be misleading during an outage or expired
    // token.
    let callIdx = 0;
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) => {
      callIdx += 1;
      if (callIdx <= 2) {
        // First two calls resolve positional args normally
        return Promise.resolve({
          org: "test-org",
          issue: makeMockIssue({
            shortId: issueArg,
            id: issueArg.replace("CLI-", "10"),
          }),
        });
      }
      // Resolving the --into target throws an auth error
      return Promise.reject(new AuthError("invalid"));
    });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false, into: "CLI-XYZ" }, "CLI-A", "CLI-B")
      .catch((e: Error) => e);

    // AuthError bubbles up (not masked as a not-found error)
    expect(err).toBeInstanceOf(AuthError);
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("--into propagates 5xx ApiError instead of masking", async () => {
    let callIdx = 0;
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) => {
      callIdx += 1;
      if (callIdx <= 2) {
        return Promise.resolve({
          org: "test-org",
          issue: makeMockIssue({
            shortId: issueArg,
            id: issueArg.replace("CLI-", "10"),
          }),
        });
      }
      return Promise.reject(new ApiError("Internal error", 500));
    });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false, into: "CLI-XYZ" }, "CLI-A", "CLI-B")
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  test("--into that can't be resolved surfaces the not-found error", async () => {
    // --into is now always part of the merge set, so a value that doesn't
    // resolve fails during resolveAllIssues with the underlying not-found
    // error rather than being silently dropped.
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) => {
      if (issueArg === "XYZ") {
        return Promise.reject(
          new ResolutionError(
            "Issue 'XYZ'",
            "not found",
            "sentry issue view XYZ"
          )
        );
      }
      return Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg,
          id: issueArg.replace("CLI-", "10"),
        }),
      });
    });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    const err = await func
      .call(context, { json: false, into: "XYZ" }, "CLI-A", "CLI-B")
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.message).toContain("Issue 'XYZ'");
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  test("fast-path matches short IDs case-insensitively", async () => {
    // User types `--into cli-b` (lowercase) but short IDs are canonically
    // uppercase. The lowercase form resolves to the same numeric ID as the
    // `CLI-B` positional, so numeric dedupe collapses them and orderForMerge
    // still puts CLI-B (10B) at the front as the preferred parent.
    resolveIssueSpy.mockImplementation(({ issueArg }: { issueArg: string }) =>
      Promise.resolve({
        org: "test-org",
        issue: makeMockIssue({
          shortId: issueArg.toUpperCase(),
          id: issueArg.toUpperCase().replace("CLI-", "10"),
        }),
      })
    );
    mergeSpy.mockResolvedValue({ parent: "10B", children: ["10A"] });

    const { context } = createMockContext();
    const func = await mergeCommand.loader();
    await func.call(context, { json: false, into: "cli-b" }, "CLI-A", "CLI-B");

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    const callArgs = mergeSpy.mock.calls[0] as [string, string[]];
    // Dedupe leaves exactly the two distinct issues, parent (10B) at front.
    expect(new Set(callArgs[1])).toEqual(new Set(["10A", "10B"]));
    expect(callArgs[1][0]).toBe("10B");
  });
});

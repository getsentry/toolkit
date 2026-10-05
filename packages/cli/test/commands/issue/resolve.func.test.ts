/**
 * Issue Resolve Command Tests
 *
 * Tests for `sentry issue resolve` and `sentry issue unresolve` func() bodies.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveCommand } from "../../../src/commands/issue/resolve.js";

vi.mock(
  "../../../src/commands/issue/resolve-commit-spec.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/commands/issue/resolve-commit-spec.js")
      >();
    return Object.fromEntries(
      Object.entries(actual).map(([k, v]) => [
        k,
        typeof v === "function" ? vi.fn(v) : v,
      ])
    );
  }
);

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as commitSpec from "../../../src/commands/issue/resolve-commit-spec.js";
import { unresolveCommand } from "../../../src/commands/issue/unresolve.js";

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
import type { SentryIssue } from "../../../src/types/sentry.js";

function makeMockIssue(overrides?: Partial<SentryIssue>): SentryIssue {
  return {
    id: "123456789",
    shortId: "CLI-G5",
    title: "TypeError: boom",
    culprit: "handler",
    count: "10",
    userCount: 3,
    firstSeen: "2026-03-01T00:00:00Z",
    lastSeen: "2026-04-03T12:00:00Z",
    level: "error",
    status: "resolved",
    permalink: "https://sentry.io/organizations/test-org/issues/123456789/",
    project: { id: "456", slug: "test-project", name: "Test Project" },
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

describe("resolveCommand.func()", () => {
  let resolveIssueSpy: ReturnType<typeof spyOn>;
  let updateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    updateSpy = vi.spyOn(apiClient, "updateIssueStatus");
  });

  afterEach(() => {
    resolveIssueSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test("resolves immediately when no --in spec is provided", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue({ status: "unresolved" }),
    });
    updateSpy.mockResolvedValue(makeMockIssue({ status: "resolved" }));

    const { context } = createMockContext();
    const func = await resolveCommand.loader();
    await func.call(context, { json: false }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "resolved", {
      statusDetails: undefined,
      orgSlug: "test-org",
    });
  });

  test("resolves --in <version> as inRelease", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    const func = await resolveCommand.loader();
    await func.call(context, { json: false, in: "0.26.1" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "resolved", {
      statusDetails: { inRelease: "0.26.1" },
      orgSlug: "test-org",
    });
  });

  test("resolves --in @next as inNextRelease", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    const func = await resolveCommand.loader();
    await func.call(context, { json: false, in: "@next" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "resolved", {
      statusDetails: { inNextRelease: true },
      orgSlug: "test-org",
    });
  });

  test("resolves --in @commit by delegating to resolveCommitSpec", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());
    const commitSpy = vi
      .spyOn(commitSpec, "resolveCommitSpec")
      .mockResolvedValue({
        commit: "abc123def",
        repository: "getsentry/cli",
      });

    try {
      const { context } = createMockContext();
      const func = await resolveCommand.loader();
      await func.call(context, { json: false, in: "@commit" }, "CLI-G5");

      expect(commitSpy).toHaveBeenCalledWith(
        { kind: "auto" },
        "test-org",
        "/tmp"
      );
      expect(updateSpy).toHaveBeenCalledWith("123456789", "resolved", {
        statusDetails: {
          inCommit: { commit: "abc123def", repository: "getsentry/cli" },
        },
        orgSlug: "test-org",
      });
    } finally {
      commitSpy.mockRestore();
    }
  });

  test("resolves --in @commit:<repo>@<sha> via explicit spec", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());
    const commitSpy = vi
      .spyOn(commitSpec, "resolveCommitSpec")
      .mockResolvedValue({
        commit: "abc123",
        repository: "getsentry/cli",
      });

    try {
      const { context } = createMockContext();
      const func = await resolveCommand.loader();
      await func.call(
        context,
        { json: false, in: "@commit:getsentry/cli@abc123" },
        "CLI-G5"
      );

      expect(commitSpy).toHaveBeenCalledWith(
        { kind: "explicit", repository: "getsentry/cli", commit: "abc123" },
        "test-org",
        "/tmp"
      );
      expect(updateSpy).toHaveBeenCalledWith("123456789", "resolved", {
        statusDetails: {
          inCommit: { commit: "abc123", repository: "getsentry/cli" },
        },
        orgSlug: "test-org",
      });
    } finally {
      commitSpy.mockRestore();
    }
  });

  test("--in @commit without an org context throws ContextError", async () => {
    // No org resolved from the issue (e.g. bare numeric ID with no DSN cache hit)
    resolveIssueSpy.mockResolvedValue({
      org: undefined,
      issue: makeMockIssue(),
    });

    const { context } = createMockContext();
    const func = await resolveCommand.loader();
    const err = await func
      .call(context, { json: false, in: "@commit" }, "123456789")
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Organization");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test("JSON output includes resolved_in metadata", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context, stdoutWrite } = createMockContext();
    const func = await resolveCommand.loader();
    await func.call(context, { json: true, in: "0.26.1" }, "CLI-G5");

    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.resolved_in).toEqual({ inRelease: "0.26.1" });
    expect(parsed.status).toBe("resolved");
    expect(parsed.shortId).toBe("CLI-G5");
  });

  test("JSON output omits resolved_in when immediate", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context, stdoutWrite } = createMockContext();
    const func = await resolveCommand.loader();
    await func.call(context, { json: true }, "CLI-G5");

    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.resolved_in).toBeUndefined();
    expect(parsed.status).toBe("resolved");
  });
});

describe("unresolveCommand.func()", () => {
  let resolveIssueSpy: ReturnType<typeof spyOn>;
  let updateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    updateSpy = vi.spyOn(apiClient, "updateIssueStatus");
  });

  afterEach(() => {
    resolveIssueSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test("sets status to unresolved", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue({ status: "resolved" }),
    });
    updateSpy.mockResolvedValue(makeMockIssue({ status: "unresolved" }));

    const { context } = createMockContext();
    const func = await unresolveCommand.loader();
    await func.call(context, { json: false }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "unresolved", {
      orgSlug: "test-org",
    });
  });
});

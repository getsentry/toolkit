/**
 * Event List Command Tests
 *
 * Tests for the `sentry event list` command. Verifies that it produces
 * the same output as `sentry issue events` but with correct command identity
 * (pagination hints say "sentry event list", not "sentry issue events").
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/event/list.js";

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

vi.mock("../../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as paginationDb from "../../../src/lib/db/pagination.js";
import { parsePeriod } from "../../../src/lib/time-range.js";
import type { IssueEvent, SentryIssue } from "../../../src/types/sentry.js";

// Reference paginationDb early to prevent import stripping by auto-organize
const _paginationDbRef = paginationDb;

// ============================================================================
// Test fixtures
// ============================================================================

function makeMockIssue(overrides?: Partial<SentryIssue>): SentryIssue {
  return {
    id: "123456789",
    shortId: "CLI-G5",
    title: "TypeError: Cannot read property 'foo' of undefined",
    culprit: "handleRequest",
    count: "42",
    userCount: 5,
    firstSeen: "2026-03-01T00:00:00Z",
    lastSeen: "2026-04-03T12:00:00Z",
    level: "error",
    status: "unresolved",
    permalink: "https://sentry.io/organizations/test-org/issues/123456789/",
    project: { id: "456", slug: "test-project", name: "Test Project" },
    ...overrides,
  } as SentryIssue;
}

function makeMockEvent(overrides?: Partial<IssueEvent>): IssueEvent {
  return {
    id: "1",
    "event.type": "error",
    groupID: "123456789",
    eventID: "abcdef1234567890abcdef1234567890",
    projectID: "456",
    message: "TypeError: Cannot read property 'foo' of undefined",
    title: "TypeError: Cannot read property 'foo' of undefined",
    location: "src/app.js:42",
    culprit: "handleRequest",
    user: { email: "user@example.com" },
    tags: [{ key: "environment", value: "production" }],
    platform: "javascript",
    dateCreated: new Date().toISOString(),
    crashFile: null,
    metadata: null,
    ...overrides,
  };
}

const sampleEvents: IssueEvent[] = [
  makeMockEvent({
    id: "1",
    eventID: "aaaa1111bbbb2222cccc3333dddd4444",
    title: "TypeError: Cannot read property 'foo' of undefined",
    platform: "javascript",
    user: { email: "alice@example.com" },
  }),
  makeMockEvent({
    id: "2",
    eventID: "eeee5555ffff6666aaaa7777bbbb8888",
    title: "ReferenceError: x is not defined",
    platform: "python",
    user: { username: "bob" },
  }),
];

// ============================================================================
// listCommand.func() tests
// ============================================================================

describe("event list command func()", () => {
  let listIssueEventsSpy: ReturnType<typeof spyOn>;
  let resolveIssueSpy: ReturnType<typeof spyOn>;
  let resolveCursorSpy: ReturnType<typeof spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof spyOn>;

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

  beforeEach(() => {
    listIssueEventsSpy = vi.spyOn(apiClient, "listIssueEvents");
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
      cursor: undefined,
      direction: "next" as const,
    });
    advancePaginationStateSpy = vi
      .spyOn(paginationDb, "advancePaginationState")
      .mockReturnValue(undefined);
    hasPreviousPageSpy = vi
      .spyOn(paginationDb, "hasPreviousPage")
      .mockReturnValue(false);
  });

  afterEach(() => {
    listIssueEventsSpy.mockRestore();
    resolveIssueSpy.mockRestore();
    resolveCursorSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
  });

  test("outputs JSON with data array when --json flag is set", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: sampleEvents });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 25, json: true, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.hasPrev).toBe(false);
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].eventID).toBe("aaaa1111bbbb2222cccc3333dddd4444");
  });

  test("writes header and table for human output", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: sampleEvents });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Events for CLI-G5:");
    expect(output).toContain("Showing 2 events.");
    // Full ID, not a 12-char prefix. Agents copy this cell into event view,
    // and Sentry cannot search a partial event ID.
    expect(output).toContain("aaaa1111bbbb2222cccc3333dddd4444");
  });

  test("pagination hints use 'sentry event list', not 'sentry issue events'", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: sampleEvents,
      nextCursor: "1735689600:0:0",
    });
    hasPreviousPageSpy.mockReturnValue(true);

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 2, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("sentry event list");
    expect(output).not.toContain("sentry issue events");
    expect(output).toContain("-c next");
    expect(output).toContain("-c prev");
  });

  test("uses 'event-list' pagination key, not 'issue-events'", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: sampleEvents,
      nextCursor: "cursor123",
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 25, json: true, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    expect(advancePaginationStateSpy).toHaveBeenCalledWith(
      "event-list",
      expect.any(String),
      "next",
      "cursor123"
    );
  });

  test("resolveIssue receives 'sentry event' as commandBase", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    expect(resolveIssueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "list",
        commandBase: "sentry event",
      })
    );
  });

  test("throws ContextError when org is undefined", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: undefined,
      issue: makeMockIssue(),
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(
      func.call(
        context,
        { limit: 25, json: false, full: false, period: parsePeriod("7d") },
        "123456789"
      )
    ).rejects.toThrow("organization");
  });
});

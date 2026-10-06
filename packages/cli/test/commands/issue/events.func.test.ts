/**
 * Issue Events Command Tests
 *
 * Tests for the `sentry issue events` command func() body and formatters.
 *
 * Uses spyOn with namespace imports to mock api-client, issue utils,
 * and pagination DB functions without real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eventsCommand } from "../../../src/commands/issue/events.js";

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

describe("eventsCommand.func()", () => {
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
    const func = await eventsCommand.loader();
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

  test("outputs empty JSON with hasMore false when no events found", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: [] });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: true, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual({
      data: [],
      hasMore: false,
      hasPrev: false,
    });
  });

  test("writes 'No events found' when empty without --json", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: [] });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No events found for this issue.");
  });

  test("writes header and table for human output", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: sampleEvents });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Events for CLI-G5:");
    expect(output).toContain("TypeError");
    expect(output).toContain("ReferenceError");
    expect(output).toContain("Showing 2 events.");
    expect(output).toContain("aaaa1111bbbb2222cccc3333dddd4444");
  });

  test("shows next page hint when nextCursor is present", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: sampleEvents,
      nextCursor: "1735689600:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 2, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Next:");
    expect(output).toContain("-c next");
  });

  test("shows event view tip when no nextCursor", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: sampleEvents });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 100, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("Next:");
    expect(output).toContain("sentry event view");
  });

  test("uses singular 'event' for single result", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: [sampleEvents[0]] });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Showing 1 event.");
    expect(output).not.toContain("Showing 1 events.");
  });

  test("passes query and full flags to API", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      {
        limit: 10,
        json: false,
        full: true,
        query: "user.email:test@example.com",
        period: parsePeriod("24h"),
      },
      "CLI-G5"
    );

    expect(listIssueEventsSpy).toHaveBeenCalledWith("test-org", "123456789", {
      limit: 10,
      query: "user.email:test@example.com",
      full: true,
      cursor: undefined,
      statsPeriod: "24h",
    });
  });

  test("passes period flag as statsPeriod to API", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("30d") },
      "CLI-G5"
    );

    expect(listIssueEventsSpy).toHaveBeenCalledWith(
      "test-org",
      "123456789",
      expect.objectContaining({ statsPeriod: "30d" })
    );
  });

  test("includes nextCursor in JSON envelope when present", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: sampleEvents,
      nextCursor: "abc123:0:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 2, json: true, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.nextCursor).toBe("abc123:0:0");
    expect(parsed.hasMore).toBe(true);
  });

  test("omits nextCursor from JSON envelope when not present", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({ data: sampleEvents });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: true, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.nextCursor).toBeUndefined();
  });

  test("calls advancePaginationState after fetching", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: sampleEvents,
      nextCursor: "cursor123",
    });

    const { context } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: true, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    expect(advancePaginationStateSpy).toHaveBeenCalledWith(
      "issue-events",
      expect.any(String),
      "next",
      "cursor123"
    );
  });

  test("shows user email in human output", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: [makeMockEvent({ user: { email: "alice@example.com" } })],
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Email may wrap across lines in the table; check for the key parts
    expect(output).toContain("alice@example");
  });

  test("falls back to username when email is missing", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: [makeMockEvent({ user: { username: "bob" } })],
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("bob");
  });

  test("shows previous page hint when hasPreviousPage is true", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    listIssueEventsSpy.mockResolvedValue({
      data: sampleEvents,
      nextCursor: "next123",
    });
    hasPreviousPageSpy.mockReturnValue(true);

    const { context, stdoutWrite } = createMockContext();
    const func = await eventsCommand.loader();
    await func.call(
      context,
      { limit: 25, json: false, full: false, period: parsePeriod("7d") },
      "CLI-G5"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Prev:");
    expect(output).toContain("-c prev");
    expect(output).toContain("Next:");
    expect(output).toContain("-c next");
  });

  test("throws ContextError when org is undefined", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: undefined,
      issue: makeMockIssue(),
    });

    const { context } = createMockContext();
    const func = await eventsCommand.loader();

    await expect(
      func.call(
        context,
        { limit: 25, json: false, full: false, period: parsePeriod("7d") },
        "123456789"
      )
    ).rejects.toThrow("organization");
  });
});

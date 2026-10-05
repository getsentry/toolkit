/**
 * Issue Archive Command Tests
 *
 * Tests for `sentry issue archive` — the --until parser, API call
 * construction, validation errors, and human output.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  archiveCommand,
  parseUntilSpec,
} from "../../../src/commands/issue/archive.js";

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
import { ValidationError } from "../../../src/lib/errors.js";
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
    status: "ignored",
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

// ── parseUntilSpec unit tests ──────────────────────────────────────

describe("parseUntilSpec", () => {
  test("'forever' → forever", () => {
    expect(parseUntilSpec("forever")).toEqual({ kind: "forever" });
  });

  test("'Forever' (case-insensitive) → forever", () => {
    expect(parseUntilSpec("Forever")).toEqual({ kind: "forever" });
  });

  test("'auto' → escalating", () => {
    expect(parseUntilSpec("auto")).toEqual({ kind: "escalating" });
  });

  test("'Auto' (case-insensitive) → escalating", () => {
    expect(parseUntilSpec("Auto")).toEqual({ kind: "escalating" });
  });

  test("'escalating' → escalating", () => {
    expect(parseUntilSpec("escalating")).toEqual({ kind: "escalating" });
  });

  test("'30m' → duration 30 minutes", () => {
    expect(parseUntilSpec("30m")).toEqual({ kind: "duration", minutes: 30 });
  });

  test("'1h' → duration 60 minutes", () => {
    expect(parseUntilSpec("1h")).toEqual({ kind: "duration", minutes: 60 });
  });

  test("'7d' → duration 10080 minutes", () => {
    expect(parseUntilSpec("7d")).toEqual({
      kind: "duration",
      minutes: 7 * 24 * 60,
    });
  });

  test("'2hours' (verbose) → duration 120 minutes", () => {
    expect(parseUntilSpec("2hours")).toEqual({
      kind: "duration",
      minutes: 120,
    });
  });

  test("'30minutes' (verbose) → duration 30 minutes", () => {
    expect(parseUntilSpec("30minutes")).toEqual({
      kind: "duration",
      minutes: 30,
    });
  });

  test("'10x' → count 10", () => {
    expect(parseUntilSpec("10x")).toEqual({ kind: "count", count: 10 });
  });

  test("'10events' (verbose) → count 10", () => {
    expect(parseUntilSpec("10events")).toEqual({ kind: "count", count: 10 });
  });

  test("'5u' → users 5", () => {
    expect(parseUntilSpec("5u")).toEqual({ kind: "users", users: 5 });
  });

  test("'5users' (verbose) → users 5", () => {
    expect(parseUntilSpec("5users")).toEqual({ kind: "users", users: 5 });
  });

  test("'10x/5m' → count 10 with 5 minute window", () => {
    expect(parseUntilSpec("10x/5m")).toEqual({
      kind: "count",
      count: 10,
      windowMinutes: 5,
    });
  });

  test("'10events/2hours' (verbose) → count 10 with 120 minute window", () => {
    expect(parseUntilSpec("10events/2hours")).toEqual({
      kind: "count",
      count: 10,
      windowMinutes: 120,
    });
  });

  test("'5u/1h' → users 5 with 60 minute window", () => {
    expect(parseUntilSpec("5u/1h")).toEqual({
      kind: "users",
      users: 5,
      windowMinutes: 60,
    });
  });

  test("'5users/30m' → users 5 with 30 minute window", () => {
    expect(parseUntilSpec("5users/30m")).toEqual({
      kind: "users",
      users: 5,
      windowMinutes: 30,
    });
  });

  test("'100x/1d' → count 100 with 1 day window", () => {
    expect(parseUntilSpec("100x/1d")).toEqual({
      kind: "count",
      count: 100,
      windowMinutes: 24 * 60,
    });
  });

  test("future ISO date → duration in minutes", () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const spec = parseUntilSpec(future);
    expect(spec.kind).toBe("duration");
    if (spec.kind === "duration") {
      // Should be approximately 60 minutes, allow some slack
      expect(spec.minutes).toBeGreaterThanOrEqual(59);
      expect(spec.minutes).toBeLessThanOrEqual(61);
    }
  });

  test("past ISO date → throws ValidationError", () => {
    expect(() => parseUntilSpec("2020-01-01")).toThrow(ValidationError);
  });

  test("invalid value → throws with helpful message", () => {
    expect(() => parseUntilSpec("garbage")).toThrow(ValidationError);
  });

  test("'0x' → throws (zero count)", () => {
    expect(() => parseUntilSpec("0x")).toThrow(ValidationError);
  });

  test("'-1x' → throws (negative count)", () => {
    expect(() => parseUntilSpec("-1x")).toThrow(ValidationError);
  });

  test("empty slash → throws", () => {
    expect(() => parseUntilSpec("10x/")).toThrow(ValidationError);
  });

  test("duration/duration → throws (left must be count)", () => {
    expect(() => parseUntilSpec("5m/10m")).toThrow(ValidationError);
  });

  test("count/count → throws (right must be duration)", () => {
    expect(() => parseUntilSpec("10x/5x")).toThrow(ValidationError);
  });
});

// ── archiveCommand.func() integration tests ────────────────────────

describe("archiveCommand.func()", () => {
  let resolveIssueSpy: ReturnType<typeof spyOn>;
  let updateSpy: ReturnType<typeof spyOn>;
  let func: Awaited<ReturnType<typeof archiveCommand.loader>>;

  beforeEach(async () => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    updateSpy = vi.spyOn(apiClient, "updateIssueStatus");
    func = await archiveCommand.loader();
  });

  afterEach(() => {
    resolveIssueSpy.mockRestore();
    updateSpy.mockRestore();
  });

  test("no --until → archives forever", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue({ status: "unresolved" }),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    await func.call(context, { json: false }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "ignored", {
      statusDetails: undefined,
      substatus: "archived_forever",
      orgSlug: "test-org",
    });
  });

  test("--until forever → archives forever (same as no --until)", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue({ status: "unresolved" }),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    await func.call(context, { json: false, until: "forever" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "ignored", {
      statusDetails: undefined,
      substatus: "archived_forever",
      orgSlug: "test-org",
    });
  });

  test("--until auto → archives until escalating", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    await func.call(context, { json: false, until: "auto" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "ignored", {
      statusDetails: undefined,
      substatus: "archived_until_escalating",
      orgSlug: "test-org",
    });
  });

  test("--until 1h → archives with 60 min duration", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    await func.call(context, { json: false, until: "1h" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "ignored", {
      statusDetails: { ignoreDuration: 60 },
      substatus: "archived_until_condition_met",
      orgSlug: "test-org",
    });
  });

  test("--until 10x/5m → archives with count + window", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    await func.call(context, { json: false, until: "10x/5m" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "ignored", {
      statusDetails: { ignoreCount: 10, ignoreWindow: 5 },
      substatus: "archived_until_condition_met",
      orgSlug: "test-org",
    });
  });

  test("--until 5u → archives with user count", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context } = createMockContext();
    await func.call(context, { json: false, until: "5u" }, "CLI-G5");

    expect(updateSpy).toHaveBeenCalledWith("123456789", "ignored", {
      statusDetails: { ignoreUserCount: 5 },
      substatus: "archived_until_condition_met",
      orgSlug: "test-org",
    });
  });

  test("human output includes 'Archived' label", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: makeMockIssue(),
    });
    updateSpy.mockResolvedValue(makeMockIssue());

    const { context, stdoutWrite } = createMockContext();
    await func.call(context, { json: false }, "CLI-G5");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Archived");
    expect(output).toContain("CLI-G5");
  });
});

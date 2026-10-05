/**
 * Tests for the issue view command's replay integration and multi-id fetch.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
import {
  fetchMultipleIssueViews,
  MAX_WEB_ISSUES,
  viewCommand,
} from "../../../src/commands/issue/view.js";

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

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";
import { ContextError } from "../../../src/lib/errors.js";
import type { SentryEvent, SentryIssue } from "../../../src/types/index.js";

const REPLAY_ID = "346789a703f6454384f1de473b8b9fcc";
const SECOND_REPLAY_ID = "aaaaaaaa03f6454384f1de473b8b9fcc";
const DASHED_REPLAY_ID = `${REPLAY_ID.slice(0, 8)}-${REPLAY_ID.slice(8, 12)}-${REPLAY_ID.slice(12, 16)}-${REPLAY_ID.slice(16, 20)}-${REPLAY_ID.slice(20)}`;

function sampleIssue(overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    id: "12345",
    shortId: "CLI-123",
    title: "Replay-linked issue",
    permalink: "https://sentry.io/organizations/test-org/issues/12345/",
    ...overrides,
  };
}

function sampleEvent(overrides: Partial<SentryEvent> = {}): SentryEvent {
  return {
    eventID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Latest event",
    tags: [{ key: "replay.id", value: REPLAY_ID }],
    ...overrides,
  };
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

const VIEW_FLAGS = {
  json: true,
  web: false,
  force: false,
  spans: 0,
  fresh: false,
} as const;

describe("issue view replay integration", () => {
  let resolveIssueSpy: ReturnType<typeof vi.spyOn>;
  let getLatestEventSpy: ReturnType<typeof vi.spyOn>;
  let listReplayIdsForIssueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    getLatestEventSpy = vi.spyOn(apiClient, "getLatestEvent");
    listReplayIdsForIssueSpy = vi.spyOn(apiClient, "listReplayIdsForIssue");
  });

  afterEach(() => {
    resolveIssueSpy.mockRestore();
    getLatestEventSpy.mockRestore();
    listReplayIdsForIssueSpy.mockRestore();
  });

  test("includes deduplicated replay IDs in JSON output", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: sampleIssue(),
    });
    getLatestEventSpy.mockResolvedValue(sampleEvent());
    listReplayIdsForIssueSpy.mockResolvedValue([
      DASHED_REPLAY_ID,
      SECOND_REPLAY_ID,
    ]);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, VIEW_FLAGS, "CLI-123");

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.org).toBe("test-org");
    expect(parsed.replayIds).toEqual([REPLAY_ID, SECOND_REPLAY_ID]);
    expect(Array.isArray(parsed)).toBe(false);
  });

  test("renders additional related replays in human output", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: sampleIssue(),
    });
    getLatestEventSpy.mockResolvedValue(sampleEvent());
    listReplayIdsForIssueSpy.mockResolvedValue([REPLAY_ID, SECOND_REPLAY_ID]);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, force: false, spans: 0, fresh: false },
      "CLI-123"
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("Related Replays");
    expect(output).toContain(SECOND_REPLAY_ID);
    expect(output).toContain(`sentry replay view test-org/${SECOND_REPLAY_ID}`);
  });
});

describe("issue view multiple IDs", () => {
  let resolveIssueSpy: ReturnType<typeof vi.spyOn>;
  let getLatestEventSpy: ReturnType<typeof vi.spyOn>;
  let listReplayIdsForIssueSpy: ReturnType<typeof vi.spyOn>;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    getLatestEventSpy = vi
      .spyOn(apiClient, "getLatestEvent")
      .mockResolvedValue(sampleEvent());
    listReplayIdsForIssueSpy = vi
      .spyOn(apiClient, "listReplayIdsForIssue")
      .mockResolvedValue([]);
    openInBrowserSpy = vi
      .spyOn(browser, "openInBrowser")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    resolveIssueSpy.mockRestore();
    getLatestEventSpy.mockRestore();
    listReplayIdsForIssueSpy.mockRestore();
    openInBrowserSpy.mockRestore();
  });

  test("returns a JSON array for space-separated issue IDs", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => ({
        org: "test-org",
        issue: sampleIssue({
          id: options.issueArg,
          shortId: options.issueArg,
          title: options.issueArg,
        }),
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, VIEW_FLAGS, "IOS-1", "IOS-2");

    expect(resolveIssueSpy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(
      stdoutWrite.mock.calls.map((call) => call[0]).join("")
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].shortId).toBe("IOS-1");
    expect(parsed[1].shortId).toBe("IOS-2");
  });

  test("expands newline-separated IDs from a single argument", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => ({
        org: "test-org",
        issue: sampleIssue({
          id: options.issueArg,
          shortId: options.issueArg,
        }),
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, VIEW_FLAGS, "IOS-1\nIOS-2\nIOS-3");

    expect(resolveIssueSpy).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(
      stdoutWrite.mock.calls.map((call) => call[0]).join("")
    );
    expect(parsed.map((row: { shortId: string }) => row.shortId)).toEqual([
      "IOS-1",
      "IOS-2",
      "IOS-3",
    ]);
  });

  test("does not split a comma-separated positional into multiple IDs", async () => {
    resolveIssueSpy.mockResolvedValue({
      org: "test-org",
      issue: sampleIssue({ shortId: "IOS-1,IOS-2" }),
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, VIEW_FLAGS, "IOS-1,IOS-2");

    expect(resolveIssueSpy).toHaveBeenCalledTimes(1);
    expect(resolveIssueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ issueArg: "IOS-1,IOS-2" })
    );
  });

  test("keeps JSON as an array when some IDs fail", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => {
        if (options.issueArg === "MISSING") {
          throw new Error("not found");
        }
        return {
          org: "test-org",
          issue: sampleIssue({ shortId: options.issueArg }),
        };
      }
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, VIEW_FLAGS, "IOS-1", "MISSING");

    const parsed = JSON.parse(
      stdoutWrite.mock.calls.map((call) => call[0]).join("")
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].shortId).toBe("IOS-1");
  });

  test("throws when every requested issue fails", async () => {
    const error = new Error("not found");
    resolveIssueSpy.mockRejectedValue(error);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await expect(func.call(context, VIEW_FLAGS, "IOS-1", "IOS-2")).rejects.toBe(
      error
    );
  });

  test("throws ContextError when no issue ID is provided", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await expect(func.call(context, VIEW_FLAGS)).rejects.toThrow(ContextError);
  });

  test("--web opens every issue within the safety limit", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => ({
        org: "test-org",
        issue: sampleIssue({
          shortId: options.issueArg,
          permalink: `https://sentry.io/issues/${options.issueArg}/`,
        }),
      })
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true, force: false, spans: 0, fresh: false },
      "IOS-1",
      "IOS-2"
    );

    expect(resolveIssueSpy).toHaveBeenCalledTimes(2);
    expect(openInBrowserSpy).toHaveBeenNthCalledWith(
      1,
      "https://sentry.io/issues/IOS-1/",
      "issue"
    );
    expect(openInBrowserSpy).toHaveBeenNthCalledWith(
      2,
      "https://sentry.io/issues/IOS-2/",
      "issue"
    );
  });

  test("--web caps opened issues unless --force is passed", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => ({
        org: "test-org",
        issue: sampleIssue({ shortId: options.issueArg }),
      })
    );
    const issueArgs = Array.from(
      { length: MAX_WEB_ISSUES + 2 },
      (_, index) => `IOS-${index + 1}`
    );

    const func = await viewCommand.loader();
    await func.call(
      createMockContext().context,
      { json: false, web: true, force: false, spans: 0, fresh: false },
      ...issueArgs
    );
    expect(openInBrowserSpy).toHaveBeenCalledTimes(MAX_WEB_ISSUES);

    openInBrowserSpy.mockClear();
    resolveIssueSpy.mockClear();
    await func.call(
      createMockContext().context,
      { json: false, web: true, force: true, spans: 0, fresh: false },
      ...issueArgs
    );
    expect(openInBrowserSpy).toHaveBeenCalledTimes(issueArgs.length);
  });
});

describe("fetchMultipleIssueViews", () => {
  let resolveIssueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolveIssueSpy = vi.spyOn(issueUtils, "resolveIssue");
    vi.spyOn(apiClient, "getLatestEvent").mockResolvedValue(sampleEvent());
    vi.spyOn(apiClient, "listReplayIdsForIssue").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fetches multiple issues in parallel", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => ({
        org: "test-org",
        issue: sampleIssue({ shortId: options.issueArg }),
      })
    );

    const result = await fetchMultipleIssueViews({
      issueArgs: ["IOS-1", "IOS-2"],
      cwd: "/tmp",
      spans: 0,
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.issue.shortId).toBe("IOS-1");
    expect(result[1]?.issue.shortId).toBe("IOS-2");
  });

  test("warns on individual failures and continues", async () => {
    resolveIssueSpy.mockImplementation(
      async (options: { issueArg: string }) => {
        if (options.issueArg === "IOS-2") {
          throw new Error("not found");
        }
        return {
          org: "test-org",
          issue: sampleIssue({ shortId: options.issueArg }),
        };
      }
    );

    const result = await fetchMultipleIssueViews({
      issueArgs: ["IOS-1", "IOS-2"],
      cwd: "/tmp",
      spans: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.issue.shortId).toBe("IOS-1");
  });

  test("re-throws the primary error when all fetches fail", async () => {
    const error = new Error("primary failed");
    resolveIssueSpy.mockRejectedValue(error);

    await expect(
      fetchMultipleIssueViews({
        issueArgs: ["IOS-1", "IOS-2"],
        cwd: "/tmp",
        spans: 0,
      })
    ).rejects.toBe(error);
  });
});

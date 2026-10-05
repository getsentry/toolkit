/**
 * Replay View Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  parsePositionalArgs,
  viewCommand,
} from "../../../src/commands/replay/view.js";

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
import {
  ApiError,
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { ReplayDetails } from "../../../src/types/index.js";

const REPLAY_ID = "346789a703f6454384f1de473b8b9fcc";
const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function sampleReplay(overrides: Partial<ReplayDetails> = {}): ReplayDetails {
  return {
    id: REPLAY_ID,
    count_errors: 2,
    count_segments: 5,
    duration: 125,
    error_ids: [],
    info_ids: [],
    started_at: "2025-01-30T14:32:15+00:00",
    tags: {},
    project_id: "42",
    trace_ids: [TRACE_ID],
    urls: [],
    user: { display_name: "Test User" },
    warning_ids: [],
    ...overrides,
  };
}

describe("parsePositionalArgs", () => {
  test("parses replay ID only", () => {
    const result = parsePositionalArgs([REPLAY_ID]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBeUndefined();
  });

  test("parses org/replay-id shorthand", () => {
    const result = parsePositionalArgs([`test-org/${REPLAY_ID}`]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBe("test-org/");
  });

  test("normalizes dashed org/replay-id shorthand", () => {
    const result = parsePositionalArgs([
      "test-org/346789a7-03f6-4543-84f1-de473b8b9fcc",
    ]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBe("test-org/");
  });

  test("parses org/project/replay-id form", () => {
    const result = parsePositionalArgs([`test-org/cli/${REPLAY_ID}`]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBe("test-org/cli");
  });

  test("parses replay URL", () => {
    const result = parsePositionalArgs([
      `https://sentry.io/organizations/test-org/explore/replays/${REPLAY_ID}/`,
    ]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBe("test-org/");
  });

  test("parses legacy replay URL", () => {
    const result = parsePositionalArgs([
      `https://test-org.sentry.io/replays/${REPLAY_ID}/`,
    ]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBe("test-org/");
  });

  test("detects swapped args", () => {
    const result = parsePositionalArgs([REPLAY_ID, "test-org/cli"]);
    expect(result.replayId).toBe(REPLAY_ID);
    expect(result.targetArg).toBe("test-org/cli");
    expect(result.warning).toContain("reversed");
  });

  test("throws ContextError for org/project with no replay ID", () => {
    expect(() => parsePositionalArgs(["test-org/cli"])).toThrow(ContextError);
  });

  test("throws ValidationError for extra positional args", () => {
    expect(() =>
      parsePositionalArgs(["test-org/cli", REPLAY_ID, "extra-arg"])
    ).toThrow(ValidationError);
  });
});

describe("viewCommand.func", () => {
  let getProjectSpy: ReturnType<typeof spyOn>;
  let resolveReplaySpy: ReturnType<typeof spyOn>;
  let getReplayRecordingSegmentsSpy: ReturnType<typeof spyOn>;
  let getTraceMetaSpy: ReturnType<typeof spyOn>;
  let listIssuesPaginatedSpy: ReturnType<typeof spyOn>;
  let resolveTargetSpy: ReturnType<typeof spyOn>;
  let openInBrowserSpy: ReturnType<typeof spyOn>;

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
    getProjectSpy = vi.spyOn(apiClient, "getProject").mockResolvedValue({
      id: "42",
      slug: "cli",
      name: "CLI",
    });
    resolveReplaySpy = vi.spyOn(apiClient, "resolveReplay");
    getReplayRecordingSegmentsSpy = vi
      .spyOn(apiClient, "getReplayRecordingSegments")
      .mockResolvedValue([
        [
          {
            timestamp: 1_735_500_000_000,
            data: { href: "/checkout" },
          },
        ],
      ]);
    getTraceMetaSpy = vi.spyOn(apiClient, "getTraceMeta").mockResolvedValue({
      errors: 2,
      logs: 4,
      performance_issues: 1,
      span_count: 8,
      span_count_map: {},
      transaction_child_count_map: [],
    });
    listIssuesPaginatedSpy = vi
      .spyOn(apiClient, "listIssuesPaginated")
      .mockResolvedValue({
        data: [
          {
            id: "100",
            shortId: "CLI-123",
            title: "Checkout error",
          },
        ],
      });
    resolveTargetSpy = vi.spyOn(resolveTarget, "resolveOrgOptionalFromArg");
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser").mockResolvedValue();
  });

  afterEach(() => {
    getProjectSpy.mockRestore();
    resolveReplaySpy.mockRestore();
    getReplayRecordingSegmentsSpy.mockRestore();
    getTraceMetaSpy.mockRestore();
    listIssuesPaginatedSpy.mockRestore();
    resolveTargetSpy.mockRestore();
    openInBrowserSpy.mockRestore();
  });

  test("renders JSON output", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(
      sampleReplay({
        error_ids: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, fresh: false },
      REPLAY_ID
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe(REPLAY_ID);
    expect(parsed.org).toBe("test-org");
    expect(parsed.activity[0]?.label).toBe("page.view");
    expect(parsed.relatedIssues[0]?.shortId).toBe("CLI-123");
    expect(parsed.relatedTraces[0]?.spanCount).toBe(8);
    expect(parsed.trace_ids[0]).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(getReplayRecordingSegmentsSpy).toHaveBeenCalledWith(
      "test-org",
      "42",
      REPLAY_ID,
      { expectedSegments: 5 }
    );
    expect(listIssuesPaginatedSpy).toHaveBeenCalledWith(
      "test-org",
      "",
      expect.objectContaining({
        perPage: 1,
        query: "event.id:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })
    );
  });

  test("opens the replay in the browser with --web", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(sampleReplay());

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true, fresh: false },
      `test-org/${REPLAY_ID}`
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      "https://test-org.sentry.io/explore/replays/346789a703f6454384f1de473b8b9fcc/",
      "replay"
    );
  });

  test("opens the replay URL target from a replay URL with --web", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: undefined });
    resolveReplaySpy.mockResolvedValue(sampleReplay());

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true, fresh: false },
      `https://sentry.io/organizations/test-org/explore/replays/${REPLAY_ID}/`
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      "https://test-org.sentry.io/explore/replays/346789a703f6454384f1de473b8b9fcc/",
      "replay"
    );
  });

  test("opens the linked replay id in the browser when given a trace id", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(sampleReplay());

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true, fresh: false },
      TRACE_ID
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      "https://test-org.sentry.io/explore/replays/346789a703f6454384f1de473b8b9fcc/",
      "replay"
    );
  });

  test("converts missing replays into ResolutionError", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockRejectedValue(
      new ApiError("Failed to get replay", 404, "Not Found")
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false, fresh: false }, REPLAY_ID)
    ).rejects.toThrow(ResolutionError);
  });

  test("rejects replays outside the explicit project scope", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(sampleReplay({ project_id: "999" }));

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false, fresh: false }, REPLAY_ID)
    ).rejects.toThrow(ResolutionError);
  });

  test("allows archived replays with no project ID in explicit project scope", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(
      sampleReplay({
        count_segments: 0,
        is_archived: true,
        project_id: null,
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false, fresh: false },
      REPLAY_ID
    );

    expect(getProjectSpy).not.toHaveBeenCalled();
    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.is_archived).toBe(true);
  });

  test("renders activity and related sections in human output", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(
      sampleReplay({
        error_ids: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        urls: ["/checkout"],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, fresh: false },
      REPLAY_ID
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("Activity");
    expect(output).toContain("page.view");
    expect(output).toContain("Related");
    expect(output).toContain("CLI-123");
    expect(output).toContain("sentry trace view test-org/");
  });

  test("anchors activity offsets to the replay start time", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "test-org", project: "cli" });
    resolveReplaySpy.mockResolvedValue(
      sampleReplay({
        started_at: "2025-01-01T00:00:00.000Z",
      })
    );
    getReplayRecordingSegmentsSpy.mockResolvedValue([
      [
        {
          timestamp: Date.parse("2025-01-01T00:00:05.000Z"),
          data: { href: "/checkout" },
        },
      ],
    ]);

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false, fresh: false },
      REPLAY_ID
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("5s");
  });
});

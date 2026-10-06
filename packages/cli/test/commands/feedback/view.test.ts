/**
 * Feedback View Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../src/commands/feedback/view.js";
import type { SentryEvent, SentryFeedback } from "../../../src/types/index.js";

vi.mock("../../../src/commands/feedback/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/commands/feedback/utils.js")
    >();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as feedbackUtils from "../../../src/commands/feedback/utils.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";

const REPLAY_ID = "346789a703f6454384f1de473b8b9fcc";
const EXTRA_REPLAY_ID = "aaaaaaaa03f6454384f1de473b8b9fcc";

function feedback(): SentryFeedback {
  return {
    id: "5146636313",
    shortId: "TEST-PROJECT-2SDJ",
    title: "User Feedback",
    issueCategory: "feedback",
    issueType: "feedback",
    status: "unresolved",
    hasSeen: false,
    firstSeen: "2026-07-16T12:00:00Z",
    permalink:
      "https://sentry.io/organizations/test-org/feedback/?feedbackSlug=test-project%3A5146636313",
    project: { id: "42", slug: "test-project", name: "Test Project" },
    metadata: {
      message: "Checkout is broken\nPlease help",
      name: "Ada",
      contact_email: "ada@example.com",
      source: "new_feedback_envelope",
    },
  };
}

function event(): SentryEvent {
  return {
    eventID: "abc123def456abc123def456abc12345",
    title: "User Feedback",
    dateReceived: "2026-07-16T12:00:00Z",
    contexts: {
      feedback: {
        url: "https://example.com/checkout",
        associated_event_id: "def456abc123def456abc123def456ab",
      },
    },
    tags: [{ key: "replay.id", value: REPLAY_ID }],
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

describe("feedback view", () => {
  let resolveFeedbackSpy: ReturnType<typeof vi.spyOn>;
  let getLatestEventSpy: ReturnType<typeof vi.spyOn>;
  let listReplayIdsSpy: ReturnType<typeof vi.spyOn>;
  let listAttachmentsSpy: ReturnType<typeof vi.spyOn>;
  let openInBrowserSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeedbackSpy = vi
      .spyOn(feedbackUtils, "resolveFeedback")
      .mockResolvedValue({ org: "test-org", feedback: feedback() });
    getLatestEventSpy = vi
      .spyOn(apiClient, "getLatestEvent")
      .mockResolvedValue(event());
    listReplayIdsSpy = vi
      .spyOn(apiClient, "listReplayIdsForIssue")
      .mockResolvedValue([REPLAY_ID, EXTRA_REPLAY_ID]);
    listAttachmentsSpy = vi
      .spyOn(apiClient, "listEventAttachments")
      .mockResolvedValue([
        {
          id: "attachment-1",
          event_id: "abc123def456abc123def456abc12345",
          type: "event.attachment",
          name: "screenshot.png",
          mimetype: "image/png",
          dateCreated: "2026-07-16T12:00:00Z",
          size: 2048,
          headers: {},
          sha1: null,
        },
      ]);
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("flattens feedback and enrichment data in JSON", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      {
        json: true,
        web: false,
        fresh: false,
      },
      "TEST-PROJECT-2SDJ"
    );

    expect(listAttachmentsSpy).toHaveBeenCalledWith(
      "test-org",
      "test-project",
      "abc123def456abc123def456abc12345"
    );
    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(JSON.parse(output)).toMatchObject({
      shortId: "TEST-PROJECT-2SDJ",
      org: "test-org",
      event: { eventID: "abc123def456abc123def456abc12345" },
      replayIds: [REPLAY_ID, EXTRA_REPLAY_ID],
      attachments: [{ id: "attachment-1", name: "screenshot.png" }],
    });
  });

  test("renders message, linked error, replay, and attachment context", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      {
        json: false,
        web: false,
        fresh: false,
      },
      "TEST-PROJECT-2SDJ"
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("Checkout is broken");
    expect(output).toContain("sentry event view");
    expect(output).toContain("def456abc123def456abc123def456ab");
    expect(output).toContain(EXTRA_REPLAY_ID);
    expect(output).toContain("screenshot.png");
    expect(output).toContain("2.0 KB");
  });

  test("keeps core feedback output when optional enrichments fail", async () => {
    getLatestEventSpy.mockRejectedValue(new Error("event unavailable"));
    listReplayIdsSpy.mockRejectedValue(new Error("replays unavailable"));

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      {
        json: true,
        web: false,
        fresh: false,
      },
      "5146636313"
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(JSON.parse(output)).toMatchObject({
      shortId: "TEST-PROJECT-2SDJ",
      event: null,
      replayIds: [],
      attachments: [],
    });
    expect(listAttachmentsSpy).not.toHaveBeenCalled();
  });

  test("keeps event context when attachment enrichment fails", async () => {
    listAttachmentsSpy.mockRejectedValue(new Error("attachments unavailable"));

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      {
        json: true,
        web: false,
        fresh: false,
      },
      "TEST-PROJECT-2SDJ"
    );

    const output = stdoutWrite.mock.calls.map((call) => call[0]).join("");
    expect(JSON.parse(output)).toMatchObject({
      shortId: "TEST-PROJECT-2SDJ",
      event: { eventID: "abc123def456abc123def456abc12345" },
      attachments: [],
    });
  });

  test("opens the feedback permalink without enrichment calls", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      {
        json: false,
        web: true,
        fresh: false,
      },
      "TEST-PROJECT-2SDJ"
    );

    expect(openInBrowserSpy).toHaveBeenCalledWith(
      feedback().permalink,
      "feedback"
    );
    expect(getLatestEventSpy).not.toHaveBeenCalled();
    expect(listReplayIdsSpy).not.toHaveBeenCalled();
    expect(listAttachmentsSpy).not.toHaveBeenCalled();
    expect(resolveFeedbackSpy).toHaveBeenCalled();
  });
});

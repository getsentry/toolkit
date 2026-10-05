/**
 * Feedback formatter tests.
 */

import stringWidth from "string-width";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  formatFeedbackList,
  formatFeedbackView,
  formatReopenedFeedback,
  formatResolvedFeedback,
  formatSpamFeedback,
} from "../../../src/lib/formatters/feedback.js";
import type { SentryFeedback } from "../../../src/types/index.js";

const originalPlainOutput = process.env.SENTRY_PLAIN_OUTPUT;

function feedback(overrides: Partial<SentryFeedback> = {}): SentryFeedback {
  return {
    id: "1",
    shortId: "WEB-1",
    title: "User Feedback",
    issueCategory: "feedback",
    issueType: "feedback",
    status: "unresolved",
    hasSeen: false,
    firstSeen: "2026-07-16T12:00:00Z",
    project: { id: "1", slug: "web", name: "Web" },
    metadata: { message: "Button | failed\nwith **markdown**" },
    ...overrides,
  };
}

beforeAll(() => {
  process.env.SENTRY_PLAIN_OUTPUT = "1";
});

afterAll(() => {
  if (originalPlainOutput === undefined) {
    delete process.env.SENTRY_PLAIN_OUTPUT;
  } else {
    process.env.SENTRY_PLAIN_OUTPUT = originalPlainOutput;
  }
});

describe.each([
  { format: formatResolvedFeedback, action: "Resolved" },
  { format: formatReopenedFeedback, action: "Reopened" },
  { format: formatSpamFeedback, action: "Marked" },
])("$action feedback", ({ format, action }) => {
  test("renders a terminal-safe confirmation", () => {
    const output = format(
      feedback({ shortId: "\x1b[31mWEB-1\x1b[0m\n\u202e" })
    );

    expect(output).toContain(`${action} feedback`);
    expect(output).toContain("WEB-1");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\u202e");
  });
});

describe("formatFeedbackList", () => {
  test("renders anonymous, unread feedback without breaking the table", () => {
    const output = formatFeedbackList({
      feedback: [feedback()],
      hasMore: false,
      hasPrev: false,
      org: "test-org",
      project: "web",
    });

    expect(output).toContain("Anonymous");
    expect(output).toContain("Unread");
    expect(output).toContain("Button");
  });

  test("maps ignored feedback to Spam and combines name with email", () => {
    const output = formatFeedbackList({
      feedback: [
        feedback({
          status: "ignored",
          hasSeen: true,
          metadata: {
            message: "Spam",
            name: "Ada",
            contact_email: "ada@example.com",
          },
        }),
      ],
      hasMore: false,
      hasPrev: false,
      org: "test-org",
    });

    expect(output).toContain("Ada");
    expect(output).toContain("Spam");
    expect(output).toContain("Read");
  });

  test("does not label an absent read state as unread", () => {
    const output = formatFeedbackList({
      feedback: [feedback({ hasSeen: undefined })],
      hasMore: false,
      hasPrev: false,
      org: "test-org",
    });

    expect(output).toContain("Unknown");
    expect(output).not.toContain("Unread");
  });

  test("describes an empty previous page as a page, not an empty result", () => {
    const output = formatFeedbackList({
      feedback: [],
      hasMore: false,
      hasPrev: true,
      org: "test-org",
    });

    expect(output).toBe("No feedback on this page.");
  });

  test("flattens every message line break in compact output", () => {
    const savedColumns = process.stdout.columns;
    process.stdout.columns = 60;

    try {
      const output = formatFeedbackList({
        feedback: [feedback({ metadata: { message: "First\nSecond\nThird" } })],
        hasMore: false,
        hasPrev: false,
        org: "test-org",
      });

      expect(output).toContain("First Second Third");
      expect(output).not.toContain("\nSecond");
      expect(output).not.toContain("\nThird");
    } finally {
      process.stdout.columns = savedColumns;
    }
  });
});

describe("formatFeedbackView", () => {
  test("escapes message markdown while preserving multiple lines", () => {
    const output = formatFeedbackView({
      org: "test-org",
      feedback: feedback(),
      event: null,
      replayIds: [],
      attachments: [],
    });

    expect(output).toContain("Button | failed");
    expect(output).toContain("with **markdown**");
  });

  test("truncates long list messages but preserves the complete detail message", () => {
    const savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    const savedColumns = process.stdout.columns;
    const longMessage = `${"Checkout failed ".repeat(20)}\nTAIL **marker**`;
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    process.stdout.columns = 60;

    try {
      const item = feedback({ metadata: { message: longMessage } });
      const listOutput = formatFeedbackList({
        feedback: [item],
        hasMore: false,
        hasPrev: false,
        org: "test-org",
        project: "web",
      });
      const viewOutput = formatFeedbackView({
        org: "test-org",
        feedback: item,
        event: null,
        replayIds: [],
        attachments: [],
      });

      expect(listOutput).toContain("…");
      expect(
        Math.max(...listOutput.split("\n").map((line) => stringWidth(line)))
      ).toBeLessThanOrEqual(60);
      expect(viewOutput).toContain("TAIL **marker**");
    } finally {
      if (savedPlain === undefined) {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      } else {
        process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
      }
      process.stdout.columns = savedColumns;
    }
  });

  test("removes terminal control sequences from untrusted fields", () => {
    const savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const maliciousControlSequences = [
      "\u001b[2J",
      "\u001b]52;c;dGVzdA==\u0007",
      "\u009b2J",
      "\u202e",
    ];
    const item = feedback({
      metadata: {
        message: `Checkout ${maliciousControlSequences.join("")}failed`,
        name: `Ada${maliciousControlSequences.join("")}`,
        summary: `Summary${maliciousControlSequences.join("")}`,
      },
    });

    try {
      const listOutput = formatFeedbackList({
        feedback: [item],
        hasMore: false,
        hasPrev: false,
        org: "test-org",
        project: "web",
      });
      const viewOutput = formatFeedbackView({
        org: "test-org",
        feedback: item,
        event: {
          eventID: "abc123def456abc123def456abc12345",
          title: "User Feedback",
          user: {
            name: `Mallory${maliciousControlSequences.join("")}`,
          },
          tags: [
            {
              key: "unsafe",
              value: `tag${maliciousControlSequences.join("")}`,
            },
          ],
        },
        replayIds: [],
        attachments: [
          {
            id: "attachment-1",
            event_id: "event-1",
            type: "event.attachment",
            name: `screen${maliciousControlSequences.join("")}.png`,
            mimetype: "image/png",
            dateCreated: "2026-07-16T12:00:00Z",
            size: 10,
            headers: {},
            sha1: null,
          },
        ],
      });

      for (const sequence of maliciousControlSequences) {
        expect(listOutput).not.toContain(sequence);
        expect(viewOutput).not.toContain(sequence);
      }
      expect(listOutput).toContain("Ada");
      expect(viewOutput).toContain("Checkout");
      expect(viewOutput).toContain("Mallory");
      expect(viewOutput).toContain("screen.png");
    } finally {
      if (savedPlain === undefined) {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      } else {
        process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
      }
    }
  });
});

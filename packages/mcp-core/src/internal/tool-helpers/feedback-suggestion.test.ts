import { describe, expect, it } from "vitest";
import {
  FEEDBACK_TOOL_NAME,
  formatFeedbackSuggestion,
} from "./feedback-suggestion";

const condition = "If this keeps failing";

describe("formatFeedbackSuggestion", () => {
  it("points at a directly registered feedback tool", () => {
    expect(
      formatFeedbackSuggestion({
        condition,
        kind: "broken",
        eventId: "0123456789abcdef0123456789abcdef",
        session: {
          availableToolNames: new Set([FEEDBACK_TOOL_NAME]),
          directToolNames: new Set([FEEDBACK_TOOL_NAME]),
        },
      }),
    ).toMatchInlineSnapshot(
      `"If this keeps failing, use the Sentry tool \`submit_feedback_to_sentry_team\` with kind='broken' and eventId='0123456789abcdef0123456789abcdef' to report it to the Sentry MCP team."`,
    );
  });

  it("points at a catalog-only feedback tool through the gateway", () => {
    expect(
      formatFeedbackSuggestion({
        condition,
        kind: "missing",
        session: {
          availableToolNames: new Set([
            FEEDBACK_TOOL_NAME,
            "search_sentry_tools",
            "execute_sentry_tool",
          ]),
          directToolNames: new Set([
            "search_sentry_tools",
            "execute_sentry_tool",
          ]),
        },
      }),
    ).toMatchInlineSnapshot(
      `"If this keeps failing, use the Sentry tool \`submit_feedback_to_sentry_team\` with kind='missing' to report it to the Sentry MCP team."`,
    );
  });

  it("returns null when the feedback tool is not in the session", () => {
    expect(
      formatFeedbackSuggestion({
        condition,
        kind: "broken",
        session: { availableToolNames: new Set(["search_errors"]) },
      }),
    ).toBeNull();
  });

  it("returns null without session tool metadata", () => {
    expect(
      formatFeedbackSuggestion({ condition, kind: "broken", session: {} }),
    ).toBeNull();
  });

  it("returns null when the session surface cannot reach the tool", () => {
    expect(
      formatFeedbackSuggestion({
        condition,
        kind: "broken",
        session: {
          availableToolNames: new Set([FEEDBACK_TOOL_NAME]),
          directToolNames: new Set(["search_errors"]),
        },
      }),
    ).toBeNull();
  });
});

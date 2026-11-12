import { describe, expect, it } from "vitest";
import {
  FEEDBACK_TOOL_NAME,
  formatFeedbackSuggestion,
} from "./feedback-suggestion";

describe("formatFeedbackSuggestion", () => {
  it("names the feedback tool when the session can call it", () => {
    expect(
      formatFeedbackSuggestion("If this keeps failing", {
        availableToolNames: new Set([FEEDBACK_TOOL_NAME]),
      }),
    ).toMatchInlineSnapshot(
      `"If this keeps failing, report it to the Sentry MCP team with \`submit_feedback_to_sentry_team\`."`,
    );
  });

  it("returns null when the feedback tool is not in the session", () => {
    expect(
      formatFeedbackSuggestion("If this keeps failing", {
        availableToolNames: new Set(["search_errors"]),
      }),
    ).toBeNull();
  });

  it("returns null without session tool metadata", () => {
    expect(formatFeedbackSuggestion("If this keeps failing", {})).toBeNull();
  });
});

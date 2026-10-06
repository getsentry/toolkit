import { describe, expect, test } from "vitest";
import { formatFeedbackHint } from "../../../src/lib/init/feedback.js";

describe("formatFeedbackHint", () => {
  test("maps init outcomes to copy-paste feedback commands", () => {
    expect(formatFeedbackHint("success")).toBe(
      [
        "Tell us what felt great or rough:",
        '$ sentry cli feedback "sentry init worked well"',
      ].join("\n")
    );
    expect(formatFeedbackHint("cancelled")).toBe(
      [
        "Sad to see setup stop. Was something going sideways?",
        "Tell us so we can fix it:",
        '$ sentry cli feedback "sentry init was cancelled"',
      ].join("\n")
    );
    expect(formatFeedbackHint("failed")).toBe(
      [
        "Setup hit a wall.",
        "Tell us what happened so we can fix it:",
        '$ sentry cli feedback "sentry init failed"',
      ].join("\n")
    );
  });
});

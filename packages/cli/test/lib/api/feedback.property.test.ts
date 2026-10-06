/**
 * Property tests for the User Feedback API query boundary.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  buildFeedbackQuery,
  type FeedbackStatus,
} from "../../../src/lib/api/feedback.js";

const CATEGORY_FILTER = "issue.category:feedback";

describe("buildFeedbackQuery", () => {
  test("always preserves the mandatory feedback category", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<FeedbackStatus>(
          "unresolved",
          "resolved",
          "spam",
          "all"
        ),
        fc.string(),
        (status, query) => {
          expect(buildFeedbackQuery(status, query)).toStartWith(
            CATEGORY_FILTER
          );
        }
      )
    );
  });

  test.each([
    ["unresolved", "status:unresolved"],
    ["resolved", "status:resolved"],
    ["spam", "status:ignored"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(buildFeedbackQuery(status)).toBe(`${CATEGORY_FILTER} ${expected}`);
  });

  test("omits the generated status filter for all", () => {
    expect(buildFeedbackQuery("all", "browser:Chrome")).toBe(
      `${CATEGORY_FILTER} browser:Chrome`
    );
  });
});

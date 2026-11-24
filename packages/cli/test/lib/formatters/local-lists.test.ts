import { describe, expect, test } from "vitest";
import { formatLocalEventList } from "../../../src/lib/formatters/local-lists.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";

describe("formatLocalEventList", () => {
  test("shows a batch count only when the tail would", () => {
    const table = stripAnsi(
      formatLocalEventList({
        events: [
          { eventId: "a".repeat(32), type: "span", title: "GET /ok", count: 0 },
          {
            eventId: "b".repeat(32),
            type: "span",
            title: "GET /api",
            count: 2,
          },
          { eventId: "c".repeat(32), type: "feedback", title: "Broken" },
        ],
      }),
    );
    expect(table).toContain("span (2)");
    expect(table).not.toContain("span (0)");
  });
});

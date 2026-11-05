import { describe, expect, test } from "vitest";
import { monitorParameter } from "../../../src/commands/monitor/resolve.js";

describe("monitor references", () => {
  test("parses IDs and names without losing organization context", () => {
    const parse = monitorParameter("view").parse;
    expect(parse("test-org/9").parsed).toEqual({
      ref: "9",
      target: { type: "org-all", org: "test-org" },
    });
    expect(parse("test-org/Error volume").parsed).toEqual({
      ref: "Error volume",
      target: { type: "org-all", org: "test-org" },
    });
    expect(parse("9").parsed).toEqual({
      ref: "9",
      target: { type: "auto-detect" },
    });
  });

  test("accepts native SaaS and self-hosted monitor detail URLs only", () => {
    const parse = monitorParameter("view").parse;
    expect(
      parse("https://test-org.sentry.io/monitors/9/").parsed,
    ).toMatchObject({ ref: "9", target: { type: "org-all", org: "test-org" } });
    expect(
      parse("https://sentry.example.com/organizations/test-org/monitors/9/")
        .parsed,
    ).toEqual({
      ref: "9",
      target: { type: "org-all", org: "test-org" },
      baseUrl: "https://sentry.example.com",
    });
    expect(() => parse("https://test-org.sentry.io/issues/9/")).toThrow(
      "/monitors/<id>/",
    );
    expect(() =>
      parse("https://test-org.sentry.io/monitors/9/edit/"),
    ).toThrow();
  });

  test.each(["/9", "test-org/", "test-org/   ", "test-org/web/9", "   "])(
    "rejects malformed reference %s",
    (ref) => {
      expect(() => monitorParameter("view").parse(ref)).toThrow();
    },
  );
});

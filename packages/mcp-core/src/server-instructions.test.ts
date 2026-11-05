import { describe, expect, it } from "vitest";
import {
  MAX_SERVER_INSTRUCTIONS_LENGTH,
  buildServerInstructions,
} from "./server-instructions";

describe("buildServerInstructions", () => {
  it("omits instructions when no tools are registered", () => {
    expect(buildServerInstructions(new Set())).toBeUndefined();
  });

  it("names only registered tools", () => {
    const instructions = buildServerInstructions(
      new Set(["search_docs", "get_doc"]),
    );

    expect(instructions).not.toContain("get_sentry_resource");
    expect(instructions).not.toContain("find_organizations");
    expect(instructions).not.toContain("search_issues");
    expect(instructions).not.toContain("search_sentry_tools");
  });

  it("lists event search tools without search_issues", () => {
    expect(
      buildServerInstructions(new Set(["search_logs", "search_traces"])),
    ).toContain(
      "- search_logs, search_traces find individual events, counts, and aggregates.",
    );
  });

  it("skips the catalog gateway rule unless both gateway tools are registered", () => {
    expect(
      buildServerInstructions(new Set(["search_sentry_tools"])),
    ).not.toContain("search_sentry_tools");
  });

  it("points at the catalog gateway when it is registered", () => {
    const instructions = buildServerInstructions(
      new Set([
        "get_sentry_resource",
        "find_organizations",
        "search_issues",
        "search_errors",
        "search_logs",
        "search_traces",
        "search_metrics",
        "search_profiles",
        "search_replays",
        "search_sentry_tools",
        "execute_sentry_tool",
      ]),
    );

    expect(instructions).toContain(
      "find the tool with search_sentry_tools and run it with execute_sentry_tool",
    );
    expect(instructions?.length).toBeLessThanOrEqual(
      MAX_SERVER_INSTRUCTIONS_LENGTH,
    );
  });
});

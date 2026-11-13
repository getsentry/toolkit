import { describe, expect, it } from "vitest";
import {
  type SideQuestCandidate,
  buildSideQuests,
  formatSideQuests,
} from "./side-quests";

const session = {
  experimentalMode: false,
  availableToolNames: new Set(["get_issue_details", "search_events"]),
  directToolNames: new Set(["get_issue_details", "search_events"]),
};

function detector(candidate: SideQuestCandidate | null) {
  return () => candidate;
}

describe("buildSideQuests", () => {
  it("ranks the quests, keeps detector order for ties, and caps them", () => {
    const quests = buildSideQuests(
      null,
      [
        detector({ rank: 10, id: "late", tip: "Late." }),
        detector({ rank: 0, id: "first", tip: "First." }),
        detector(null),
        detector({ rank: 5, id: "tie_a", tip: "Tie A." }),
        detector({ rank: 5, id: "tie_b", tip: "Tie B." }),
      ],
      session,
    );

    expect(quests?.map(({ id }) => id)).toEqual(["first", "tie_a", "tie_b"]);
  });

  it("returns undefined when no detector finds anything", () => {
    expect(buildSideQuests(null, [detector(null)], session)).toBeUndefined();
  });

  it("keeps only the calls the session can make, up to two", () => {
    const [quest] =
      buildSideQuests(
        null,
        [
          detector({
            rank: 0,
            id: "calls",
            tip: "Tip.",
            next: [
              { tool: "update_project", args: { slug: "web" } },
              { tool: "search_events", args: { query: "a" } },
              { tool: "get_issue_details", args: { issueId: "WEB-1" } },
              { tool: "search_events", args: { query: "b" } },
            ],
          }),
          detector({
            rank: 1,
            id: "unavailable",
            tip: "Tip.",
            next: [{ tool: "update_project", args: {} }],
          }),
        ],
        session,
      ) ?? [];

    expect(quest.next).toEqual([
      { tool: "search_events", args: { query: "a" } },
      { tool: "get_issue_details", args: { issueId: "WEB-1" } },
    ]);
  });

  it("names the target tool when the session reaches it through execute_sentry_tool", () => {
    const quests = buildSideQuests(
      null,
      [
        detector({
          rank: 0,
          id: "catalog",
          tip: "Tip.",
          next: [{ tool: "update_project", args: {} }],
        }),
      ],
      {
        experimentalMode: false,
        availableToolNames: new Set(["update_project", "execute_sentry_tool"]),
        directToolNames: new Set(["execute_sentry_tool"]),
      },
    );

    expect(quests?.[0]?.next).toEqual([{ tool: "update_project", args: {} }]);
  });

  it("omits empty fields", () => {
    const quests = buildSideQuests(
      null,
      [
        detector({
          rank: 0,
          id: "bare",
          tip: "Tip.",
          next: [{ tool: "update_project", args: {} }],
          docs: "",
          details: [],
        }),
      ],
      session,
    );

    expect(quests).toEqual([{ id: "bare", tip: "Tip." }]);
  });

  it("caps details at three lines", () => {
    const quests = buildSideQuests(
      null,
      [
        detector({
          rank: 0,
          id: "details",
          tip: "Tip.",
          details: ["a", "b", "c", "d"],
        }),
      ],
      session,
    );

    expect(quests?.[0]?.details).toEqual(["a", "b", "c"]);
  });
});

describe("formatSideQuests", () => {
  it("renders one line per quest, with its calls, docs, and details", () => {
    expect(
      formatSideQuests([
        {
          id: "js_source_maps",
          tip: "Source maps weren't applied to 2 files; the cause differs by file.",
          docs: "https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/",
          details: ["`/a.js` has no debug ID.", "`/b.js` has no release."],
        },
        {
          id: "next_call",
          tip: "Check the project.",
          next: [{ tool: "find_projects", args: { query: "web" } }],
        },
      ]),
    ).toMatchInlineSnapshot(`
      "## Concerns Identified

      Optional; not needed for the current task.

      - Source maps weren't applied to 2 files; the cause differs by file. Docs: https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/
        - \`/a.js\` has no debug ID.
        - \`/b.js\` has no release.
      - Check the project. Next: \`find_projects(query='web')\`.

      "
    `);
  });

  it("renders nothing without quests", () => {
    expect(formatSideQuests(undefined)).toBe("");
  });
});

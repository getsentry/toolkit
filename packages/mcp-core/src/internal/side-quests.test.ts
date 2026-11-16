import { getActiveSpan, metrics } from "@sentry/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SideQuestCandidate,
  buildSideQuests,
  formatSideQuests,
} from "./side-quests";

vi.mock("@sentry/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/core")>();
  return {
    ...actual,
    getActiveSpan: vi.fn(),
    metrics: { ...actual.metrics, count: vi.fn() },
  };
});

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

describe("side quest telemetry", () => {
  const setAttributes = vi.fn();

  beforeEach(() => {
    setAttributes.mockClear();
    vi.mocked(metrics.count).mockClear();
    vi.mocked(getActiveSpan).mockReturnValue({
      setAttributes,
    } as unknown as ReturnType<typeof getActiveSpan>);
  });

  it("marks each detected quest as shown or capped, with the counts", () => {
    buildSideQuests(
      null,
      [
        detector({ rank: 10, id: "late", tip: "Late." }),
        detector({ rank: 0, id: "first", tip: "First." }),
        detector(null),
        detector({ rank: 5, id: "second", tip: "Second." }),
      ],
      session,
      2,
    );

    expect(setAttributes).toHaveBeenCalledOnce();
    expect(setAttributes).toHaveBeenCalledWith({
      "app.side_quests.detected": 3,
      "app.side_quests.shown": 2,
      "app.side_quest.first": "shown",
      "app.side_quest.second": "shown",
      "app.side_quest.late": "capped",
    });
  });

  it("counts each shown quest, not the capped ones", () => {
    buildSideQuests(
      null,
      [
        detector({ rank: 0, id: "first", tip: "First." }),
        detector({ rank: 1, id: "capped", tip: "Capped." }),
      ],
      session,
      1,
    );

    expect(vi.mocked(metrics.count).mock.calls).toEqual([
      ["app.side_quest.shown", 1, { attributes: { "side_quest.id": "first" } }],
    ]);
  });

  it("records zero counts when no detector finds anything", () => {
    buildSideQuests(null, [detector(null)], session);

    expect(setAttributes).toHaveBeenCalledWith({
      "app.side_quests.detected": 0,
      "app.side_quests.shown": 0,
    });
    expect(metrics.count).not.toHaveBeenCalled();
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

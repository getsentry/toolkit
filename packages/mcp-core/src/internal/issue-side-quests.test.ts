import { eventFixture, sourceMapDebugFixture } from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import { EventSchema, SourceMapDebugSchema } from "../api-client/schema";
import {
  ISSUE_SIDE_QUEST_IDS,
  buildIssueSideQuests,
} from "./issue-side-quests";

const session = { experimentalMode: false };
const files = ["/a.js", "/b.js", "/c.js"];

/**
 * The fixture's three raw frames, each from its own bundle, with a source map
 * error for each and one more for `/d.js`, which has no frame.
 */
function eventWithFourFiles() {
  const fixture = structuredClone(eventFixture);
  for (const entry of fixture.entries) {
    if (entry.type !== "exception") {
      continue;
    }
    for (const value of entry.data.values) {
      value.rawStacktrace?.frames.forEach(
        (frame: { absPath: string | null }, index: number) => {
          frame.absPath = files[index] ?? frame.absPath;
        },
      );
    }
  }
  return EventSchema.parse({
    ...fixture,
    user: { ...fixture.user, id: "8f3c2a" },
    errors: [...files, "/d.js"].map((url) => ({
      type: "js_no_source",
      message: "Source code was not found",
      data: { url },
    })),
  });
}

describe("buildIssueSideQuests", () => {
  it("uses unique snake_case ids, which analytics depend on", () => {
    const ids = Object.values(ISSUE_SIDE_QUEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    }
  });

  it("lists each file's cause when the causes differ", () => {
    const event = eventWithFourFiles();
    const debug = SourceMapDebugSchema.parse(sourceMapDebugFixture);
    // `/b.js` has a debug ID, but nothing was uploaded for it
    debug.exceptions[0].frames[1].debug_id_process.debug_id =
      "41f4b626-efd6-5847-915c-69f5d33361fb";

    expect(buildIssueSideQuests({ event, sourceMapDebug: debug }, session))
      .toMatchInlineSnapshot(`
      [
        {
          "details": [
            "\`/a.js\` and \`/c.js\` have no debug ID, and the project has no debug ID uploads. Inject debug IDs with the bundler plugin or \`sentry-cli sourcemaps inject\`, deploy, then upload those same files.",
            "\`/b.js\` has debug ID \`41f4b626-efd6-5847-915c-69f5d33361fb\`, but no source file or source map with it was uploaded. Upload the deployed build output after injecting debug IDs, with the bundler plugin or \`sentry-cli sourcemaps upload\`.",
            "1 more file: the source file or its source map was not found. Upload source maps for this release from the same build that was deployed.",
          ],
          "docs": "https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/",
          "id": "js_source_maps",
          "tip": "Source maps weren't applied to 4 files, so frames may be minified; the cause differs by file.",
        },
      ]
    `);
  });

  it("keeps the remainder when three files have three causes", () => {
    const event = eventWithFourFiles();
    const debug = SourceMapDebugSchema.parse(sourceMapDebugFixture);
    // `/b.js` and `/c.js` each have their own debug ID, with nothing uploaded
    debug.exceptions[0].frames[1].debug_id_process.debug_id =
      "41f4b626-efd6-5847-915c-69f5d33361fb";
    debug.exceptions[0].frames[2].debug_id_process.debug_id =
      "6f88580e-719d-56bb-81e1-afad5d3d78ac";

    const [quest] =
      buildIssueSideQuests({ event, sourceMapDebug: debug }, session) ?? [];

    // the third cause joins the remainder, so `/d.js` is still explained
    expect(quest.details).toMatchInlineSnapshot(`
      [
        "\`/a.js\` has no debug ID, and the project has no debug ID uploads. Inject debug IDs with the bundler plugin or \`sentry-cli sourcemaps inject\`, deploy, then upload those same files.",
        "\`/b.js\` has debug ID \`41f4b626-efd6-5847-915c-69f5d33361fb\`, but no source file or source map with it was uploaded. Upload the deployed build output after injecting debug IDs, with the bundler plugin or \`sentry-cli sourcemaps upload\`.",
        "\`/c.js\` and 1 more: the source file or its source map was not found. Upload source maps for this release from the same build that was deployed.",
      ]
    `);
  });
});

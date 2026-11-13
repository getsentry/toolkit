import { eventFixture, sourceMapDebugFixture } from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import { EventSchema, SourceMapDebugSchema } from "../api-client/schema";
import { buildIssueSideQuests } from "./issue-side-quests";

const session = { experimentalMode: false };

describe("buildIssueSideQuests", () => {
  it("lists each file's cause when the causes differ", () => {
    const files = ["/a.js", "/b.js", "/c.js"];
    const fixture = structuredClone(eventFixture);
    // the fixture's three raw frames, each from its own bundle
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
    const event = EventSchema.parse({
      ...fixture,
      user: { ...fixture.user, id: "8f3c2a" },
      errors: [...files, "/d.js"].map((url) => ({
        type: "js_no_source",
        message: "Source code was not found",
        data: { url },
      })),
    });
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
});

import { eventFixture, sourceMapDebugFixture } from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import { EventSchema, SourceMapDebugSchema } from "../api-client/schema";
import type { SourceMapDebug } from "../api-client/types";
import { diagnoseSourceMaps } from "./source-map-diagnosis";

const event = EventSchema.parse(eventFixture);
const baseDebug = SourceMapDebugSchema.parse(sourceMapDebugFixture);
type DebugFrame = SourceMapDebug["exceptions"][number]["frames"][number];

/** The fixture's check, with every frame of `/index.js` replaced. */
function diagnose(
  frame: Partial<DebugFrame>,
  overrides: Partial<SourceMapDebug> = {},
) {
  const debug: SourceMapDebug = {
    ...baseDebug,
    ...overrides,
    exceptions: baseDebug.exceptions.map(({ frames }) => ({
      frames: frames.map((base) => ({ ...base, ...frame })),
    })),
  };
  return diagnoseSourceMaps({ event, debug, files: ["/index.js"] });
}

const noDebugId = {
  debug_id: null,
  uploaded_source_file_with_correct_debug_id: false,
  uploaded_source_map_with_correct_debug_id: false,
};

describe("diagnoseSourceMaps", () => {
  it("says the map does not fit when Sentry found it by debug ID", () => {
    // the shape of js_invalid_sourcemap_location events in Sentry's own
    // javascript project: debug IDs uploaded, yet the location did not map
    expect(
      diagnose({
        debug_id_process: {
          debug_id: "6f88580e-719d-56bb-81e1-afad5d3d78ac",
          uploaded_source_file_with_correct_debug_id: true,
          uploaded_source_map_with_correct_debug_id: true,
        },
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "files": [
            "/index.js",
          ],
          "fix": "Make sure the map comes from the deployed file: generate source maps in the last build step that changes the files, then upload them again.",
          "problem": "Sentry found the source file and its source map by debug ID, but could not apply the map to this file",
        },
      ]
    `);
  });

  it("names the missing upload for a debug ID", () => {
    expect(
      diagnose({
        debug_id_process: {
          debug_id: "41f4b626-efd6-5847-915c-69f5d33361fb",
          uploaded_source_file_with_correct_debug_id: true,
          uploaded_source_map_with_correct_debug_id: false,
        },
      })[0]?.problem,
    ).toBe(
      "No source map with debug ID `41f4b626-efd6-5847-915c-69f5d33361fb` was uploaded",
    );
  });

  it("checks the release when the SDK has no debug IDs", () => {
    const release = {
      abs_path: "/index.js",
      matching_source_file_names: ["/index.js", "~/index.js"],
      source_map_reference: null,
      source_file_lookup_result: "wrong-dist",
      source_map_lookup_result: "unsuccessful",
    };
    expect(
      diagnose(
        { debug_id_process: noDebugId, release_process: release },
        {
          release: "worker@1.2.3",
          dist: "7",
          release_has_some_artifact: true,
          sdk_debug_id_support: "needs-upgrade",
        },
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "files": [
            "/index.js",
          ],
          "fix": "Upload with the same dist that the SDK sends. Or upgrade \`sentry.javascript.cloudflare\` to 7.56.0 or later and use debug IDs.",
          "problem": "The uploaded source file has a different dist than the event (\`7\`)",
        },
      ]
    `);

    expect(
      diagnose(
        {
          debug_id_process: noDebugId,
          release_process: {
            ...release,
            source_file_lookup_result: "unsuccessful",
          },
        },
        {
          release: "worker@1.2.3",
          release_has_some_artifact: true,
          sdk_debug_id_support: "unofficial-sdk",
        },
      )[0],
    ).toEqual({
      files: ["/index.js"],
      problem:
        "No file uploaded for release `worker@1.2.3` has the deployed file's name",
      fix: "Upload it as `/index.js` or `~/index.js`, for example by setting the URL prefix in the upload.",
    });
  });

  it("reports why fetching failed when there is no release", () => {
    expect(
      diagnose(
        {
          debug_id_process: noDebugId,
          scraping_process: {
            source_file: {
              status: "failure",
              url: "https://example.com/index.js",
              reason: "not_found",
            },
            source_map: null,
          },
        },
        { sdk_debug_id_support: "unofficial-sdk" },
      )[0]?.problem,
    ).toBe(
      "Sentry could not fetch `https://example.com/index.js` from the web: it was not found",
    );
  });

  it("skips files with no frame in the event", () => {
    expect(
      diagnoseSourceMaps({ event, debug: baseDebug, files: ["/other.js"] }),
    ).toEqual([]);
  });
});

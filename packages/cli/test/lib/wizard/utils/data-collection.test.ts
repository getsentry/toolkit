import { describe, expect, it } from "vitest";

import {
  getDataCollectionSnippet,
  sdkSupportsDataCollection,
} from "../../../../src/lib/wizard/utils/data-collection.js";
import { getMajorVersion } from "../../../../src/lib/wizard/utils/semver.js";

describe("getMajorVersion", () => {
  it.each([
    ["^10", 10],
    ["^10.73.0", 10],
    ["~11.2.0", 11],
    ["11.0.0", 11],
    // Prerelease versions keep their major, so v11 rc/beta installs pass the gate
    ["11.0.0-rc.1", 11],
    ["^11.0.0-rc.0", 11],
    ["~11.0.0-beta.2", 11],
    [">=10.57.0 <12", 10],
  ])("returns the lowest permitted major for %s", (version, expected) => {
    expect(getMajorVersion(version)).toBe(expected);
  });

  it.each([undefined, "", "not-a-version", "workspace:*"])(
    "returns undefined for %s",
    (version) => {
      expect(getMajorVersion(version)).toBeUndefined();
    },
  );
});

describe("sdkSupportsDataCollection", () => {
  it.each([
    ["^11.0.0", "^10"],
    ["11.2.3", "^10"],
    ["^12", "^10"],
    ["11.0.0-rc.1", "^10"],
    ["^11.0.0-beta.0", "^10"],
  ])("returns true for installed version %s", (installed, range) => {
    expect(sdkSupportsDataCollection(installed, range)).toBe(true);
  });

  it.each([
    ["^10.73.0", "^10"],
    ["10.99.0", "^10"],
    ["^9", "^10"],
    ["10.99.0-rc.1", "^10"],
  ])("returns false for installed version %s", (installed, range) => {
    expect(sdkSupportsDataCollection(installed, range)).toBe(false);
  });

  it("falls back to the wizard install range when the installed version is missing", () => {
    expect(sdkSupportsDataCollection(undefined, "^11")).toBe(true);
    expect(sdkSupportsDataCollection(undefined, "^10")).toBe(false);
  });

  it("falls back to the wizard install range when the installed version is unparseable", () => {
    expect(sdkSupportsDataCollection("workspace:*", "^11")).toBe(true);
    expect(sdkSupportsDataCollection("workspace:*", "^10")).toBe(false);
  });

  it("returns false when neither version is parseable", () => {
    expect(sdkSupportsDataCollection(undefined, "not-a-version")).toBe(false);
  });
});

describe("getDataCollectionSnippet", () => {
  it("renders the preset with the default indentation", () => {
    expect(getDataCollectionSnippet()).toMatchInlineSnapshot(`
      "  // Turns off collection of data that could identify users. Adjust per category:
        // https://docs.sentry.io/platforms/javascript/configuration/options/#dataCollection
        dataCollection: {
          userInfo: false,
          graphQL: { document: false, variables: false },
          genAI: { inputs: false, outputs: false },
          databaseQueryData: false,
          queues: false,
          httpBodies: [],
          httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
          cookies: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
          urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
        },"
    `);
  });

  it("prefixes every line with the given indent", () => {
    const snippet = getDataCollectionSnippet("    ");
    for (const line of snippet.split("\n")) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });
});

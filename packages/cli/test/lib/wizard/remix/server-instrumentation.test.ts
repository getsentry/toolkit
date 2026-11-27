import { describe, expect, it } from "vitest";
import {
  generateServerInstrumentationFile,
  getInstrumentationImportPath,
} from "../../../../src/lib/wizard/remix/sdk-setup.js";

describe("generateServerInstrumentationFile", () => {
  it("should generate server instrumentation file", () => {
    const result = generateServerInstrumentationFile(
      "https://sentry.io/123",
      {
        performance: true,
        replay: true,
      },
      false,
    );

    expect(result.instrumentationFileMod.generate().code)
      .toMatchInlineSnapshot(`
      "import * as Sentry from "@sentry/remix";

      Sentry.init({
          dsn: "https://sentry.io/123",
          tracesSampleRate: 1
      })"
    `);
  });

  it("should generate server instrumentation file when performance is disabled", () => {
    const result = generateServerInstrumentationFile(
      "https://sentry.io/123",
      {
        performance: false,
        replay: true,
      },
      false,
    );

    expect(result.instrumentationFileMod.generate().code)
      .toMatchInlineSnapshot(`
      "import * as Sentry from "@sentry/remix";

      Sentry.init({
          dsn: "https://sentry.io/123"
      })"
    `);
  });

  it("should add the dataCollection preset when reduced data collection is requested", () => {
    const result = generateServerInstrumentationFile(
      "https://sentry.io/123",
      {
        performance: true,
        replay: true,
      },
      true,
    );

    expect(result.instrumentationFileMod.generate().code)
      .toMatchInlineSnapshot(`
        "import * as Sentry from "@sentry/remix";

        Sentry.init({
            dsn: "https://sentry.io/123",
            tracesSampleRate: 1,
            // Turns off collection of data that could identify users. Adjust per category:
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
            },
        })"
      `);
  });
});

describe("getInstrumentationImportPath", () => {
  it.each([
    ["server.ts", "./instrumentation.server.mjs"],
    ["server/index.ts", "../instrumentation.server.mjs"],
    ["app/server.ts", "../instrumentation.server.mjs"],
    ["app/server/index.ts", "../../instrumentation.server.mjs"],
  ])("points %s at the root instrumentation file", (serverFile, expected) => {
    expect(
      getInstrumentationImportPath(serverFile, "instrumentation.server.mjs"),
    ).toBe(expected);
  });
});

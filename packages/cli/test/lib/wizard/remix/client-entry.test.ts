import { parseModule } from "magicast";
import { updateEntryClientMod } from "../../../../src/lib/wizard/remix/sdk-setup.js";
import { describe, expect, it } from "vitest";

describe("initializeSentryOnEntryClient", () => {
  it("should initialize Sentry on client entry with all features enabled", () => {
    // Empty entry.client.tsx file for testing
    const originalEntryClientMod = parseModule("");

    const dsn = "https://sentry.io/123";
    const selectedFeatures = {
      performance: true,
      replay: true,
    };

    const result = updateEntryClientMod(
      originalEntryClientMod,
      dsn,
      selectedFeatures,
      false,
    );

    expect(result.generate().code).toMatchInlineSnapshot(`
      "import {  useEffect,} from "react";

      import {
        useLocation,
        useMatches,
      } from "@remix-run/react";

      import {  init, replayIntegration, browserTracingIntegration,} from "@sentry/remix";

      init({
          dsn: "https://sentry.io/123",
          tracesSampleRate: 1,

          integrations: [browserTracingIntegration({
            useEffect,
            useLocation,
            useMatches
          }), replayIntegration({
              maskAllText: true,
              blockAllMedia: true
          })],

          replaysSessionSampleRate: 0.1,
          replaysOnErrorSampleRate: 1
      })"
    `);
  });

  it("should initialize Sentry on client entry when performance disabled", () => {
    // Empty entry.client.tsx file for testing
    const originalEntryClientMod = parseModule("");

    const dsn = "https://sentry.io/123";
    const selectedFeatures = {
      performance: false,
      replay: true,
    };

    const result = updateEntryClientMod(
      originalEntryClientMod,
      dsn,
      selectedFeatures,
      false,
    );

    expect(result.generate().code).toMatchInlineSnapshot(`
      "import {  init, replayIntegration,} from "@sentry/remix";

      init({
          dsn: "https://sentry.io/123",

          integrations: [replayIntegration({
              maskAllText: true,
              blockAllMedia: true
          })],

          replaysSessionSampleRate: 0.1,
          replaysOnErrorSampleRate: 1
      })"
    `);
  });

  it("should initialize Sentry on client entry when replay disabled", () => {
    // Empty entry.client.tsx file for testing
    const originalEntryClientMod = parseModule("");

    const dsn = "https://sentry.io/123";
    const selectedFeatures = {
      performance: true,
      replay: false,
    };

    const result = updateEntryClientMod(
      originalEntryClientMod,
      dsn,
      selectedFeatures,
      false,
    );

    expect(result.generate().code).toMatchInlineSnapshot(`
      "import {  useEffect,} from "react";

      import {
        useLocation,
        useMatches,
      } from "@remix-run/react";

      import {  init, browserTracingIntegration,} from "@sentry/remix";

      init({
          dsn: "https://sentry.io/123",
          tracesSampleRate: 1,

          integrations: [browserTracingIntegration({
            useEffect,
            useLocation,
            useMatches
          })]
      })"
    `);
  });

  it("should add the dataCollection preset when reduced data collection is requested", () => {
    // Empty entry.client.tsx file for testing
    const originalEntryClientMod = parseModule("");

    const dsn = "https://sentry.io/123";
    const selectedFeatures = {
      performance: true,
      replay: true,
    };

    const result = updateEntryClientMod(
      originalEntryClientMod,
      dsn,
      selectedFeatures,
      true,
    );

    expect(result.generate().code).toMatchInlineSnapshot(`
      "import {  useEffect,} from "react";

      import {
        useLocation,
        useMatches,
      } from "@remix-run/react";

      import {  init, replayIntegration, browserTracingIntegration,} from "@sentry/remix";

      init({
          dsn: "https://sentry.io/123",
          tracesSampleRate: 1,

          integrations: [browserTracingIntegration({
            useEffect,
            useLocation,
            useMatches
          }), replayIntegration({
              maskAllText: true,
              blockAllMedia: true
          })],

          replaysSessionSampleRate: 0.1,
          replaysOnErrorSampleRate: 1,
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

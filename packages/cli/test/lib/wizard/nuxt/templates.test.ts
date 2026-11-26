import { describe, expect, it, vi } from "vitest";
import {
  getDefaultNuxtConfig,
  getNuxtModuleFallbackTemplate,
  getSentryConfigContents,
  getSentryExamplePageTemplate,
} from "../../../../src/lib/wizard/nuxt/templates.js";

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("Nuxt code templates", () => {
  describe("getDefaultNuxtConfig", () => {
    it("returns a default nuxt config", () => {
      expect(getDefaultNuxtConfig()).toMatchInlineSnapshot(`
      "// https://nuxt.com/docs/api/configuration/nuxt-config
      export default defineNuxtConfig({
        compatibilityDate: '2024-04-03',
        devtools: { enabled: true }
      })
      "
`);
    });
  });

  describe("getSentryConfigContents", () => {
    describe("client config", () => {
      it("generates Sentry config with all features enabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "client",
          {
            performance: true,
            replay: true,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            // If set up, you can use your runtime config here
            // dsn: useRuntimeConfig().public.sentry.dsn,
            dsn: "https://sentry.io/123",

            // We recommend adjusting this value in production, or using tracesSampler
            // for finer control
            tracesSampleRate: 1.0,

            // This sets the sample rate to be 10%. You may want this to be 100% while
            // in development and sample at a lower rate in production
            replaysSessionSampleRate: 0.1,
            
            // If the entire session is not sampled, use the below sample rate to sample
            // sessions when an error occurs.
            replaysOnErrorSampleRate: 1.0,
            
            // If you don't want to use Session Replay, just remove the line below:
            integrations: [Sentry.replayIntegration()],

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with performance monitoring disabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "client",
          {
            performance: false,
            replay: true,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            // If set up, you can use your runtime config here
            // dsn: useRuntimeConfig().public.sentry.dsn,
            dsn: "https://sentry.io/123",

            // This sets the sample rate to be 10%. You may want this to be 100% while
            // in development and sample at a lower rate in production
            replaysSessionSampleRate: 0.1,
            
            // If the entire session is not sampled, use the below sample rate to sample
            // sessions when an error occurs.
            replaysOnErrorSampleRate: 1.0,
            
            // If you don't want to use Session Replay, just remove the line below:
            integrations: [Sentry.replayIntegration()],

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with session replay disabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "client",
          {
            performance: true,
            replay: false,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            // If set up, you can use your runtime config here
            // dsn: useRuntimeConfig().public.sentry.dsn,
            dsn: "https://sentry.io/123",

            // We recommend adjusting this value in production, or using tracesSampler
            // for finer control
            tracesSampleRate: 1.0,

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with performance monitoring and session replay disabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "client",
          {
            performance: false,
            replay: false,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            // If set up, you can use your runtime config here
            // dsn: useRuntimeConfig().public.sentry.dsn,
            dsn: "https://sentry.io/123",

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with all features disabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "client",
          {
            performance: false,
            replay: false,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            // If set up, you can use your runtime config here
            // dsn: useRuntimeConfig().public.sentry.dsn,
            dsn: "https://sentry.io/123",

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with reduced data collection", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "client",
          {
            performance: true,
            replay: true,
          },
          true,
        );

        expect(template).toContain("userInfo: false,");
        expect(template).toContain(
          'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },',
        );
        expect(template).not.toContain(
          "// To disable sending user data and HTTP bodies, uncomment the lines below.",
        );
        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            // If set up, you can use your runtime config here
            // dsn: useRuntimeConfig().public.sentry.dsn,
            dsn: "https://sentry.io/123",

            // We recommend adjusting this value in production, or using tracesSampler
            // for finer control
            tracesSampleRate: 1.0,

            // This sets the sample rate to be 10%. You may want this to be 100% while
            // in development and sample at a lower rate in production
            replaysSessionSampleRate: 0.1,
            
            // If the entire session is not sampled, use the below sample rate to sample
            // sessions when an error occurs.
            replaysOnErrorSampleRate: 1.0,
            
            // If you don't want to use Session Replay, just remove the line below:
            integrations: [Sentry.replayIntegration()],

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

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });
    });

    describe("server config", () => {
      it("generates Sentry config with all features enabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "server",
          {
            performance: true,
            replay: true,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            dsn: "https://sentry.io/123",

            // We recommend adjusting this value in production, or using tracesSampler
            // for finer control
            tracesSampleRate: 1.0,

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with performance monitoring disabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "server",
          {
            performance: false,
            replay: true,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            dsn: "https://sentry.io/123",

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with all features disabled", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "server",
          {
            performance: false,
            replay: false,
          },
          false,
        );

        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            dsn: "https://sentry.io/123",

            dataCollection: {
              // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
              // https://docs.sentry.io/platforms/javascript/guides/nuxt/configuration/options/#dataCollection
              // userInfo: false,
              // httpBodies: [],
            },

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });

      it("generates Sentry config with reduced data collection", () => {
        const template = getSentryConfigContents(
          "https://sentry.io/123",
          "server",
          {
            performance: true,
            replay: false,
          },
          true,
        );

        expect(template).toContain("userInfo: false,");
        expect(template).toContain(
          'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },',
        );
        expect(template).not.toContain(
          "// To disable sending user data and HTTP bodies, uncomment the lines below.",
        );
        expect(template).toMatchInlineSnapshot(`
          "import * as Sentry from "@sentry/nuxt";

          Sentry.init({
            dsn: "https://sentry.io/123",

            // We recommend adjusting this value in production, or using tracesSampler
            // for finer control
            tracesSampleRate: 1.0,

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

            // Setting this option to true will print useful information to the console while you're setting up Sentry.
            debug: false,
          });
          "
        `);
      });
    });
  });

  describe("getNuxtModuleFallbackTemplate", () => {
    it("generates configuration options for the nuxt config", () => {
      const template = getNuxtModuleFallbackTemplate({
        org: "my-org",
        project: "my-project",
        url: "https://sentry.io",
        selfHosted: false,
      });

      expect(template).toMatchInlineSnapshot(`
        "  modules: ["@sentry/nuxt/module"],
          sentry: {
            org: "my-org",
            project: "my-project",
            sourcemaps: { 
              // This will delete all .map files in the build output after uploading them to Sentry. Modify as needed.
              // For more information, see: https://docs.sentry.io/platforms/javascript/guides/nuxt/sourcemaps/
              filesToDeleteAfterUpload: ['.*/**/*.map'] 
            },
          },
          sourcemap: { client: "hidden" },"
      `);
    });

    it("generates configuration options for the nuxt config with self-hosted url", () => {
      const template = getNuxtModuleFallbackTemplate({
        org: "my-org",
        project: "my-project",
        url: "https://sentry.example.com",
        selfHosted: true,
      });

      expect(template).toMatchInlineSnapshot(`
        "  modules: ["@sentry/nuxt/module"],
          sentry: {
            org: "my-org",
            project: "my-project",
            sentryUrl: "https://sentry.example.com",
            sourcemaps: { 
              // This will delete all .map files in the build output after uploading them to Sentry. Modify as needed.
              // For more information, see: https://docs.sentry.io/platforms/javascript/guides/nuxt/sourcemaps/
              filesToDeleteAfterUpload: ['.*/**/*.map'] 
            },
          },
          sourcemap: { client: "hidden" },"
      `);
    });
  });

  describe("getSentryExamplePageTemplate", () => {
    it("lets the API route's 500 reject so the page shows its success state", () => {
      const template = getSentryExamplePageTemplate({
        url: "https://sentry.io/",
        org: "my-org",
        projectId: "1",
      });
      expect(template).toContain("$fetch('/api/sentry-example-api'");
      expect(template).not.toContain("ignoreResponseError");
    });
  });
});

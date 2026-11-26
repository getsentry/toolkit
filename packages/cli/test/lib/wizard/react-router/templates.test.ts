import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock makeCodeSnippet utility
vi.mock("../../../../src/lib/wizard/utils/clack/index.js", () => {
  return {
    __esModule: true,
    makeCodeSnippet: vi.fn(
      (
        _colors: boolean,
        callback: (
          unchanged: (str: string) => string,
          plus: (str: string) => string,
          minus: (str: string) => string,
        ) => string,
      ) => {
        // Mock implementation that just calls the callback with simple string functions
        const unchanged = (str: string) => str;
        const plus = (str: string) => `+ ${str}`;
        const minus = (str: string) => `- ${str}`;
        return callback(unchanged, plus, minus);
      },
    ),
  };
});

import {
  EXAMPLE_PAGE_TEMPLATE_TSX,
  EXAMPLE_PAGE_TEMPLATE_JSX,
  getManualClientEntryContent,
  getManualServerEntryContent,
  getManualServerInstrumentContent,
  getManualReactRouterConfigContent,
  getManualViteConfigContent,
} from "../../../../src/lib/wizard/react-router/templates.js";

describe("React Router Templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Template Constants", () => {
    it("should have correct EXAMPLE_PAGE_TEMPLATE_TSX content", () => {
      expect(EXAMPLE_PAGE_TEMPLATE_TSX).toContain("import type { Route }");
      expect(EXAMPLE_PAGE_TEMPLATE_TSX).toContain(
        "export async function loader()",
      );
      expect(EXAMPLE_PAGE_TEMPLATE_TSX).toContain(
        'throw new Error("some error thrown in a loader")',
      );
      expect(EXAMPLE_PAGE_TEMPLATE_TSX).toContain(
        "export default function SentryExamplePage()",
      );
      expect(EXAMPLE_PAGE_TEMPLATE_TSX).toContain(
        "Loading this page will throw an error",
      );
    });

    it("should have correct EXAMPLE_PAGE_TEMPLATE_JSX content", () => {
      expect(EXAMPLE_PAGE_TEMPLATE_JSX).not.toContain("import type { Route }");
      expect(EXAMPLE_PAGE_TEMPLATE_JSX).toContain(
        "export async function loader()",
      );
      expect(EXAMPLE_PAGE_TEMPLATE_JSX).toContain(
        'throw new Error("some error thrown in a loader")',
      );
      expect(EXAMPLE_PAGE_TEMPLATE_JSX).toContain(
        "export default function SentryExamplePage()",
      );
      expect(EXAMPLE_PAGE_TEMPLATE_JSX).toContain(
        "Loading this page will throw an error",
      );
    });
  });

  describe("getManualClientEntryContent", () => {
    it("should generate manual client entry with all features enabled and onError", () => {
      const dsn = "https://test.sentry.io/123";

      const result = getManualClientEntryContent(
        dsn,
        true,
        true,
        false,
        false,
        true,
      );

      expect(result).toContain(
        "+ import * as Sentry from '@sentry/react-router'",
      );
      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("// httpBodies: [],");
      expect(result).toContain("Sentry.reactRouterTracingIntegration()");
      expect(result).toContain("Sentry.replayIntegration()");
      expect(result).toContain("tracesSampleRate: 1.0");
      expect(result).toContain("replaysSessionSampleRate: 0.1");
      expect(result).toContain("replaysOnErrorSampleRate: 1.0");
      expect(result).toContain("tracePropagationTargets");
      expect(result).toContain("onError={Sentry.sentryOnError}");
    });

    it("should not include onError when useOnError is false", () => {
      const dsn = "https://test.sentry.io/123";

      const result = getManualClientEntryContent(dsn, true, true, false);

      expect(result).not.toContain("onError={Sentry.sentryOnError}");
    });

    it("should generate manual client entry with tracing disabled", () => {
      const dsn = "https://test.sentry.io/123";
      const enableTracing = false;
      const enableReplay = true;

      const result = getManualClientEntryContent(
        dsn,
        enableTracing,
        enableReplay,
        false,
      );

      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("tracesSampleRate: 0");
      expect(result).not.toContain("Sentry.reactRouterTracingIntegration()");
      expect(result).toContain("Sentry.replayIntegration()");
      expect(result).not.toContain("tracePropagationTargets");
    });

    it("should generate manual client entry with replay disabled", () => {
      const dsn = "https://test.sentry.io/123";
      const enableTracing = true;
      const enableReplay = false;

      const result = getManualClientEntryContent(
        dsn,
        enableTracing,
        enableReplay,
        false,
      );

      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("tracesSampleRate: 1.0");
      expect(result).toContain("Sentry.reactRouterTracingIntegration()");
      expect(result).not.toContain("Sentry.replayIntegration()");
      expect(result).not.toContain("replaysSessionSampleRate");
      expect(result).not.toContain("replaysOnErrorSampleRate");
    });

    it("should generate manual client entry with no integrations", () => {
      const dsn = "https://test.sentry.io/123";
      const enableTracing = false;
      const enableReplay = false;

      const result = getManualClientEntryContent(
        dsn,
        enableTracing,
        enableReplay,
        false,
      );

      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("tracesSampleRate: 0");
      expect(result).not.toContain("Sentry.reactRouterTracingIntegration()");
      expect(result).not.toContain("Sentry.replayIntegration()");
      expect(result).toContain("integrations: [");
    });

    it("should write the dataCollection preset when reduceDataCollection is true", () => {
      const dsn = "https://test.sentry.io/123";

      const result = getManualClientEntryContent(dsn, true, true, true);

      expect(result).toContain("userInfo: false,");
      expect(result).toContain(
        'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }',
      );
      expect(result).not.toContain("// userInfo: false,");
      expect(result).not.toContain(
        "uncomment the lines below. For more info visit:",
      );
    });

    it("should write the dataCollection preset with the instrumentation API", () => {
      const dsn = "https://test.sentry.io/123";

      const result = getManualClientEntryContent(dsn, true, true, true, true);

      expect(result).toContain("userInfo: false,");
      expect(result).toContain(
        'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }',
      );
      expect(result).not.toContain("// userInfo: false,");
    });

    describe("Instrumentation API", () => {
      it("should generate client entry with instrumentation API enabled", () => {
        const dsn = "https://test.sentry.io/123";

        const result = getManualClientEntryContent(
          dsn,
          true,
          false,
          false,
          true,
          true,
        );

        expect(result).toContain(
          "const tracing = Sentry.reactRouterTracingIntegration();",
        );
        expect(result).toContain("integrations: [");
        expect(result).toContain("tracing");
        expect(result).toContain(
          "instrumentations={[tracing.clientInstrumentation]}",
        );
        expect(result).toContain("onError={Sentry.sentryOnError}");
      });

      it("should generate client entry with instrumentation API and replay enabled", () => {
        const dsn = "https://test.sentry.io/123";

        const result = getManualClientEntryContent(
          dsn,
          true,
          true,
          false,
          true,
          true,
        );

        expect(result).toContain(
          "const tracing = Sentry.reactRouterTracingIntegration();",
        );
        expect(result).toContain("tracing");
        expect(result).toContain("Sentry.replayIntegration()");
        expect(result).toContain(
          "instrumentations={[tracing.clientInstrumentation]}",
        );
        expect(result).toContain("onError={Sentry.sentryOnError}");
      });

      it("should not use instrumentation API when explicitly disabled", () => {
        const dsn = "https://test.sentry.io/123";

        const result = getManualClientEntryContent(
          dsn,
          true,
          false,
          false,
          false,
          true,
        );

        expect(result).not.toContain("const tracing");
        expect(result).toContain("Sentry.reactRouterTracingIntegration()");
        expect(result).not.toContain("instrumentations");
        expect(result).toContain("onError={Sentry.sentryOnError}");
      });
    });
  });

  describe("getManualServerEntryContent", () => {
    it("should generate manual server entry content", () => {
      const result = getManualServerEntryContent();

      expect(result).toContain(
        "+ import * as Sentry from '@sentry/react-router'",
      );
      expect(result).toContain("createReadableStreamFromReadable");
      expect(result).toContain("renderToPipeableStream");
      expect(result).toContain("ServerRouter");
      expect(result).toContain(
        "+ const handleRequest = Sentry.createSentryHandleRequest({",
      );
      expect(result).toContain(
        "+ export const handleError = Sentry.createSentryHandleError({",
      );
      expect(result).toContain("logErrors: false");
      expect(result).toContain("export default handleRequest");
      expect(result).toContain("rest of your server entry");
    });

    describe("Instrumentation API", () => {
      it("should generate server entry with instrumentations when useInstrumentationAPI is true", () => {
        const result = getManualServerEntryContent(true);

        expect(result).toContain(
          "+ import * as Sentry from '@sentry/react-router'",
        );
        expect(result).toContain(
          "export const instrumentations = [Sentry.createSentryServerInstrumentation()];",
        );
        expect(result).toContain(
          "Enable automatic server-side instrumentation for loaders, actions, middleware",
        );
      });

      it("should not include instrumentations when useInstrumentationAPI is false", () => {
        const result = getManualServerEntryContent(false);

        expect(result).not.toContain("instrumentations");
        expect(result).not.toContain("createSentryServerInstrumentation");
      });
    });
  });

  describe("getManualServerInstrumentContent", () => {
    it("should generate server instrumentation with all features enabled", () => {
      const dsn = "https://test.sentry.io/123";
      const enableTracing = true;
      const enableProfiling = true;

      const result = getManualServerInstrumentContent(
        dsn,
        enableTracing,
        enableProfiling,
        false,
      );

      expect(result).toContain(
        "+ import * as Sentry from '@sentry/react-router'",
      );
      expect(result).toContain(
        "import { nodeProfilingIntegration } from '@sentry/profiling-node'",
      );
      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("// httpBodies: [],");
      expect(result).toContain("integrations: [nodeProfilingIntegration()]");
      expect(result).toContain("tracesSampleRate: 1.0");
      expect(result).toContain("profileSessionSampleRate: 1.0");
      expect(result).toContain('profileLifecycle: "trace"');
      expect(result).not.toContain("profilesSampleRate");
      expect(result).toContain("Capture 100% of the traces");
    });

    it("should generate server instrumentation with tracing disabled", () => {
      const dsn = "https://test.sentry.io/123";
      const enableTracing = false;
      const enableProfiling = false;

      const result = getManualServerInstrumentContent(
        dsn,
        enableTracing,
        enableProfiling,
        false,
      );

      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("tracesSampleRate: 0");
      expect(result).not.toContain("nodeProfilingIntegration");
      expect(result).not.toContain("profileSessionSampleRate");
      expect(result).not.toContain("profileLifecycle");
      expect(result).not.toContain(
        "integrations: [nodeProfilingIntegration()]",
      );
    });

    it("should generate server instrumentation with profiling disabled but tracing enabled", () => {
      const dsn = "https://test.sentry.io/123";
      const enableTracing = true;
      const enableProfiling = false;

      const result = getManualServerInstrumentContent(
        dsn,
        enableTracing,
        enableProfiling,
        false,
      );

      expect(result).toContain(`dsn: "${dsn}"`);
      expect(result).toContain("tracesSampleRate: 1.0");
      expect(result).not.toContain("nodeProfilingIntegration");
      expect(result).not.toContain("profileSessionSampleRate");
      expect(result).not.toContain("profileLifecycle");
      expect(result).not.toContain("integrations:");
    });

    it("should write the dataCollection preset when reduceDataCollection is true", () => {
      const dsn = "https://test.sentry.io/123";

      const result = getManualServerInstrumentContent(dsn, true, false, true);

      expect(result).toContain("userInfo: false,");
      expect(result).toContain(
        'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }',
      );
      expect(result).not.toContain("// userInfo: false,");
      expect(result).not.toContain(
        "uncomment the lines below. For more info visit:",
      );
    });

    it("should handle special characters in DSN", () => {
      const dsn = "https://test@example.com/sentry/123?param=value";
      const enableTracing = true;
      const enableProfiling = false;

      const result = getManualServerInstrumentContent(
        dsn,
        enableTracing,
        enableProfiling,
        false,
      );

      expect(result).toContain(`dsn: "${dsn}"`);
    });
  });

  describe("getManualReactRouterConfigContent", () => {
    it("should generate TypeScript config snippet with type imports and satisfies", () => {
      const result = getManualReactRouterConfigContent(true);

      expect(result).toContain("import type { Config }");
      expect(result).toContain("} satisfies Config;");
      expect(result).toContain("sentryOnBuildEnd");
      expect(result).toContain("ssr: true");
    });

    it("should generate JavaScript config snippet without TS-only syntax", () => {
      const result = getManualReactRouterConfigContent(false);

      // JS version should NOT have TypeScript-only syntax
      expect(result).not.toContain("import type");
      expect(result).not.toContain("satisfies Config");

      // JS version should have the standard import and export
      expect(result).toContain("import { sentryOnBuildEnd }");
      expect(result).toContain("sentryOnBuildEnd");
      expect(result).toContain("ssr: true");
      expect(result).toContain("export default {");
    });

    it("should default to TypeScript when no parameter is passed", () => {
      const result = getManualReactRouterConfigContent();

      expect(result).toContain("import type { Config }");
      expect(result).toContain("} satisfies Config;");
    });

    it("imports sentryOnBuildEnd from the given path", () => {
      const ts = getManualReactRouterConfigContent(
        true,
        "@sentry/react-router/vite",
      );
      const js = getManualReactRouterConfigContent(
        false,
        "@sentry/react-router/vite",
      );

      expect(ts).toContain(
        "import { sentryOnBuildEnd } from '@sentry/react-router/vite';",
      );
      expect(js).toContain(
        "import { sentryOnBuildEnd } from '@sentry/react-router/vite';",
      );
    });
  });

  describe("getManualViteConfigContent", () => {
    it("imports sentryReactRouter from the given path and keeps the package in optimizeDeps.exclude", () => {
      const result = getManualViteConfigContent(
        "my-org",
        "my-project",
        "@sentry/react-router/vite",
      );

      expect(result).toContain(
        "import { sentryReactRouter } from '@sentry/react-router/vite';",
      );
      expect(result).toContain("exclude: ['@sentry/react-router']");
    });
  });
});

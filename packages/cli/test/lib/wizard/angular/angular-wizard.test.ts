import { describe, expect, it, vi } from "vitest";

import { buildOutroMessage } from "../../../../src/lib/wizard/angular/angular-wizard.js";
import { getInitCallArgs } from "../../../../src/lib/wizard/angular/codemods/main.js";

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("angular-wizard", () => {
  describe("buildOutroMessage", () => {
    it("returns the correct outro message if example component was created", () => {
      expect(buildOutroMessage(true)).toMatchInlineSnapshot(`
        "Successfully installed the Sentry Angular SDK!

        You can validate your setup by starting your dev environment (ng serve) and throwing an error in the example component.

        Check out the SDK documentation for further configuration:
        https://docs.sentry.io/platforms/javascript/guides/angular/"
      `);
    });
    it("returns the correct outro message if example component creation was skipped", () => {
      expect(buildOutroMessage(false)).toMatchInlineSnapshot(`
        "Successfully installed the Sentry Angular SDK!

        Check out the SDK documentation for further configuration:
        https://docs.sentry.io/platforms/javascript/guides/angular/"
      `);
    });
  });

  describe("getInitCallArgs", () => {
    it("returns the correct init call arguments when all features are enabled", () => {
      const args = getInitCallArgs("https://example.com", {
        performance: true,
        replay: true,
      });
      expect(args).toMatchInlineSnapshot(`
        {
          "dsn": "https://example.com",
          "integrations": [
            {},
            {},
          ],
          "replaysOnErrorSampleRate": 1,
          "replaysSessionSampleRate": 0.1,
          "tracesSampleRate": 1,
        }
      `);
    });

    it("returns the correct init call arguments when performance is disabled", () => {
      const args = getInitCallArgs("https://example.com", {
        performance: false,
        replay: true,
      });

      expect(args).toMatchInlineSnapshot(`
        {
          "dsn": "https://example.com",
          "integrations": [
            {},
          ],
          "replaysOnErrorSampleRate": 1,
          "replaysSessionSampleRate": 0.1,
        }
      `);
    });

    it("returns the correct init call arguments when replay is disabled", () => {
      const args = getInitCallArgs("https://example.com", {
        performance: true,
        replay: false,
      });

      expect(args).toMatchInlineSnapshot(`
        {
          "dsn": "https://example.com",
          "integrations": [
            {},
          ],
          "tracesSampleRate": 1,
        }
      `);
    });

    it("returns the correct init call arguments when all features are disabled", () => {
      const args = getInitCallArgs("https://example.com", {
        performance: false,
        replay: false,
      });

      expect(args).toMatchInlineSnapshot(`
        {
          "dsn": "https://example.com",
        }
      `);
    });
  });
});

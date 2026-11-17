/**
 * Runs in its own file, without mocking `Sentry.init`, so the SDK starts on
 * its default stack-based context strategy, as `sentry mcp` does.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- inspect the SDK's active client
import * as Sentry from "@sentry/node";
import { afterEach, expect, test } from "vitest";
import { initMcpTelemetry } from "../../../src/lib/mcp/server.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("mcp-telemetry-scope-");
useEnvSandbox(["SENTRY_CLI_NO_TELEMETRY", "SENTRY_DSN"]);

afterEach(async () => {
  await Sentry.getClient()?.close(0);
});

test("binds the client when init runs inside the command's pre-init span", async () => {
  // Disabled, so the client never sends; it is still created and bound.
  process.env.SENTRY_CLI_NO_TELEMETRY = "1";
  // `buildCommand` wraps every command in a `withTracing("exec")` span.
  await Sentry.startSpan({ name: "exec", onlyIfParent: true }, async () => {
    await Promise.resolve();
    initMcpTelemetry({
      sentryHost: "sentry.io",
      sentryProtocol: "https",
      agentProviderFromFlag: false,
      experimental: false,
      finalSkills: new Set(),
      disabledSkills: [],
    });
  });

  expect(Sentry.getClient()).toBeDefined();
});

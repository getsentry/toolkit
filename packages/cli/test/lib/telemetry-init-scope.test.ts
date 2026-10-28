/**
 * Runs in its own file so the SDK starts on its default stack-based context
 * strategy, which is what the CLI sees before the first `initSentry()`.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- inspect the SDK's active client
import * as Sentry from "@sentry/node";
import { afterEach, expect, test } from "vitest";
import { initSentry } from "../../src/lib/telemetry.js";

afterEach(async () => {
  await Sentry.getClient()?.close(0);
});

test("binds the client when init runs inside a pending pre-init span", async () => {
  let client: ReturnType<typeof initSentry>;
  await Sentry.startSpan({ name: "pre-init" }, async () => {
    await Promise.resolve();
    client = initSentry(true, { libraryMode: true });
  });

  expect(client).toBeDefined();
  expect(Sentry.getClient()).toBe(client);
});

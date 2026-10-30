/** Verify CI and agent attribution on outgoing command telemetry. */

import type { Transport } from "@sentry/core";
import { captureMessage, startSpan, withIsolationScope } from "@sentry/node";
import { afterEach, describe, expect, test, vi } from "vitest";
import { withEnv } from "../../src/lib/env.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- intercept the outbound transport factory
import * as transportModule from "../../src/lib/telemetry/zstd-transport.js";
import { initSentry } from "../../src/lib/telemetry.js";

let client: ReturnType<typeof initSentry>;

afterEach(async () => {
  await client?.close(0);
  vi.restoreAllMocks();
});

describe("CI telemetry", () => {
  test.each([
    { env: { CI: "true" }, expected: true },
    { env: { GITHUB_ACTIONS: "true" }, expected: true },
    { env: { CI: "false" }, expected: false },
    { env: {}, expected: false },
  ])(
    "records is_ci=$expected for $env without losing agent identity",
    async ({ env, expected }) => {
      const send = vi.fn<Transport["send"]>().mockResolvedValue({});
      vi.spyOn(transportModule, "makeCompressedTransport").mockReturnValue({
        send,
        flush: async () => true,
      });

      await withEnv({ ...env, AI_AGENT: "codex" }, () =>
        withIsolationScope(async () => {
          client = initSentry(true, { libraryMode: true });
          if (!client) {
            throw new Error("Expected the telemetry client");
          }

          captureMessage("CI attribution");
          startSpan(
            { name: "sentry.info", op: "cli.command", forceTransaction: true },
            () => {},
          );
          await client.flush(1000);
        }),
      );

      const items = send.mock.calls.flatMap(([envelope]) => envelope[1]);
      for (const type of ["event", "transaction"]) {
        const event = items.find(([header]) => header.type === type)?.[1];
        expect(event).toMatchObject({
          tags: { is_ci: expected, agent: "codex" },
        });
      }
    },
  );
});

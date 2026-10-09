import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type HandlerContext = { stdout: { captureObject?: (value: unknown) => void } };
type Barrier = ReturnType<typeof Promise.withResolvers<void>>;
const invocationState = vi.hoisted(() => ({
  handler: undefined as
    | ((
        context: HandlerContext,
        flags: Record<string, unknown>,
      ) => Promise<void>)
    | undefined,
}));

vi.mock("../../src/app.js", () => {
  const command = {
    parameters: { flags: {} },
    loader: async () =>
      async function focusedCommand(
        this: HandlerContext,
        flags: Record<string, unknown>,
      ): Promise<void> {
        if (!invocationState.handler) {
          throw new Error("Missing invocation handler");
        }
        await invocationState.handler(this, flags);
      },
  };
  const route = {
    getRoutingTargetForInput: (segment: string) =>
      segment === "probe" ? command : undefined,
  };
  return {
    routes: {
      getRoutingTargetForInput: (segment: string) =>
        segment === "focused" ? route : undefined,
    },
  };
});
vi.mock("../../src/lib/telemetry.js", () => ({
  setCommandSpanName: vi.fn(),
  withTelemetry: async <T>(
    callback: (span: undefined) => Promise<T>,
  ): Promise<T> => await callback(undefined),
}));
vi.mock("@sentry/node-core/light", () => ({ getClient: () => null }));

import { getCustomHeaders } from "../../src/lib/custom-headers.js";
import { getEnv } from "../../src/lib/env.js";
import { buildInvoker } from "../../src/lib/sdk-invoke.js";
import { SentryError } from "../../src/lib/sdk-types.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("sdk-invoke-isolation-focused-");

type InvocationResult = { header?: string; host?: string; token?: string };

describe("SDK invocation isolation", () => {
  beforeEach(() => {
    invocationState.handler = undefined;
  });
  afterEach(() => {
    invocationState.handler = undefined;
  });

  test("rejects overlap and keeps environment and structured headers invocation-local", async () => {
    const started = new Map<string, Barrier>();
    const release = new Map<string, Barrier>();
    for (const id of ["first", "second"]) {
      started.set(id, Promise.withResolvers<void>());
      release.set(id, Promise.withResolvers<void>());
    }
    invocationState.handler = async (context, flags) => {
      const id = String(flags.id);
      started.get(id)?.resolve();
      await release.get(id)?.promise;
      context.stdout.captureObject?.({
        header: getCustomHeaders().find(
          ([name]) => name === "X-Invocation",
        )?.[1],
        host: getEnv().SENTRY_HOST,
        token: getEnv().SENTRY_AUTH_TOKEN,
      } satisfies InvocationResult);
    };

    const invokeSecond = buildInvoker({
      token: "token-second",
      url: "https://second.example.com",
      headers: { "X-Invocation": "second" },
    });
    const first = buildInvoker({
      token: "token-first",
      url: "https://first.example.com",
      headers: { "X-Invocation": "first" },
    })(["focused", "probe"], { id: "first" }, []) as Promise<InvocationResult>;
    try {
      await started.get("first")?.promise;
      // Production output and telemetry require sequential calls, even though
      // this focused test replaces telemetry with a stateless mock.
      release.get("second")?.resolve();
      const overlapping = invokeSecond(
        ["focused", "probe"],
        { id: "second" },
        [],
      );
      await expect(overlapping).rejects.toBeInstanceOf(SentryError);
      await expect(overlapping).rejects.toThrow(
        "Concurrent SDK calls are not supported",
      );

      release.get("first")?.resolve();
      expect(await first).toEqual({
        header: "first",
        host: "https://first.example.com",
        token: "token-first",
      });
      expect(
        await invokeSecond(["focused", "probe"], { id: "second" }, []),
      ).toEqual({
        header: "second",
        host: "https://second.example.com",
        token: "token-second",
      });
    } finally {
      for (const barrier of release.values()) {
        barrier.resolve();
      }
      await Promise.allSettled([first]);
    }
  });
});

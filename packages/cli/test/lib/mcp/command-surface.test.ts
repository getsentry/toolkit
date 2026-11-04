/**
 * `sentry mcp --commands` runs command tool calls through the CLI SDK. These run
 * real commands (`sentry api --dry-run` and argument errors), so no request
 * leaves the process.
 */

import type { ServerContext } from "@sentry/mcp-core/types";
import { describe, expect, test, vi } from "vitest";
import { createCliCommandTools } from "../../../src/lib/mcp/command-surface.js";
import type { McpServerConfig } from "../../../src/lib/mcp/config.js";
import { useTestConfigDir } from "../../helpers.js";

// The SDK loads only the route a call runs (`sdk-app.ts`); the full command
// tree must never load for a command tool call.
vi.mock("../../../src/app.js", () => {
  throw new Error("a command tool call loaded the full command tree (app.ts)");
});

const config = {
  sentryHost: "sentry.io",
  sentryProtocol: "https",
  readOnly: false,
} as McpServerConfig;

const context: ServerContext = { accessToken: "unused", constraints: {} };

function tools() {
  return createCliCommandTools({
    config,
    cwd: process.cwd(),
    getToken: async () => `sntryu_${"a".repeat(64)}`,
  });
}

/** Call the `sentry api` tool. */
async function api(params: Record<string, unknown>): Promise<unknown> {
  const tool = tools().sentry_api;
  return JSON.parse((await tool?.handler(params as never, context)) as string);
}

describe("createCliCommandTools", () => {
  useTestConfigDir("mcp-command-surface-");

  test("runs a write call through the SDK with parsed flags", async () => {
    expect(
      await api({
        positional: ["organizations/acme/releases/"],
        flags: { method: "POST", "dry-run": true, field: ["version=1.0.0"] },
      }),
    ).toEqual({
      command: "api",
      result: {
        method: "POST",
        url: "https://sentry.io/api/0/organizations/acme/releases/",
        headers: { "content-type": "application/json" },
        body: { version: "1.0.0" },
      },
    });
  });

  test("runs a read call, with a boolean flag turned off", async () => {
    expect(
      await api({
        positional: ["organizations/"],
        flags: { "dry-run": true, verbose: false },
      }),
    ).toMatchObject({ result: { method: "GET", body: null } });
  });

  test("reports a failing command with its own message", async () => {
    await expect(
      api({
        positional: ["organizations/"],
        flags: { method: "BREW", "dry-run": true },
      }),
    ).rejects.toThrow(/`api` failed: .*BREW/);
  });
});

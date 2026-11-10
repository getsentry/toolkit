/**
 * The `sentry cli feedback` hint that the error text adds for AI agents.
 */

import { homedir } from "node:os";
import { run } from "@stricli/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { app } from "../../src/app.js";
import { setAppIdentity } from "../../src/lib/app-identity.js";
import { withEnv } from "../../src/lib/env.js";
import { envWithoutAgent, useTestConfigDir } from "../helpers.js";

const sentryState = vi.hoisted(() => ({ enabled: true }));

// `cli feedback` sends only while the SDK is enabled; the test preload
// disables telemetry, so stand in for an enabled SDK.
vi.mock("@sentry/node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/node")>()),
  isEnabled: () => sentryState.enabled,
}));

const HINT = "If this looks like a CLI bug, report it:";
const originalFetch = globalThis.fetch;
const originalExitCode = process.exitCode;

describe("agent feedback hint", () => {
  const getConfigDir = useTestConfigDir("application-feedback-hint-");

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
    sentryState.enabled = true;
    vi.restoreAllMocks();
    setAppIdentity({ name: "sentry", packageName: "sentry" });
  });

  /** Run `org list` against an API that answers `status`, and return stderr. */
  async function runOrgList(
    status: number,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "Failed" }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    let stderr = "";
    // Stricli writes the error text to `process.stderr` of the context
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    await withEnv(env, () =>
      run(app, ["org", "list", "--fresh"], {
        process,
        env,
        cwd: getConfigDir(),
        homeDir: homedir(),
        configDir: getConfigDir(),
        stdout: { write: () => true },
        stderr: process.stderr,
        stdin: process.stdin,
      }),
    );
    return stderr;
  }

  function agentEnv(): NodeJS.ProcessEnv {
    return { ...envWithoutAgent(), AI_AGENT: "claude" };
  }

  test("asks an agent to report a CLI bug", async () => {
    const output = await runOrgList(400, agentEnv());
    expect(output).toContain("Error:");
    expect(output).toContain(HINT);
    expect(output).toContain(
      'cli feedback "<what you ran and what went wrong>"',
    );
  });

  test("does not show for a person", async () => {
    const output = await runOrgList(400, envWithoutAgent());
    expect(output).toContain("Error:");
    expect(output).not.toContain(HINT);
  });

  test("does not show for a user error", async () => {
    const output = await runOrgList(404, agentEnv());
    expect(output).toContain("Error:");
    expect(output).not.toContain(HINT);
  });

  test("does not show while telemetry is off", async () => {
    sentryState.enabled = false;
    const output = await runOrgList(400, agentEnv());
    expect(output).toContain("Error:");
    expect(output).not.toContain(HINT);
  });

  test("does not show in the sentry-mcp bundle", async () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    const output = await runOrgList(400, agentEnv());
    expect(output).toContain("Error:");
    expect(output).not.toContain(HINT);
  });
});

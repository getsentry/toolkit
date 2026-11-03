/**
 * Tests for `sentry init`, which prints the agent setup guide (`init.md`).
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initCommand } from "../../src/commands/init.js";
import type { SentryContext } from "../../src/context.js";
import { INIT_GUIDE } from "../../src/generated/init-guide.js";

const GUIDE_SOURCE = readFileSync(
  new URL("../../init.md", import.meta.url),
  "utf-8",
);

async function runInit(flags: { json: boolean }): Promise<string> {
  const stdoutWrite = vi.fn(() => true);
  const context = {
    process,
    env: process.env,
    stdout: { write: stdoutWrite },
    stderr: { write: vi.fn(() => true) },
    stdin: process.stdin,
    cwd: "/tmp",
    homeDir: "/tmp",
    configDir: "/tmp",
  } as unknown as SentryContext;
  const func = await initCommand.loader();
  await func.call(context, flags);
  return stdoutWrite.mock.calls.map((call) => call[0]).join("");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentry init", () => {
  test("embeds the current init.md", () => {
    expect(INIT_GUIDE).toBe(GUIDE_SOURCE);
  });

  test("prints the Markdown source when output is plain", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");

    const output = await runInit({ json: false });

    expect(output.trimEnd()).toBe(GUIDE_SOURCE.trimEnd());
  });

  test("renders the guide in a terminal", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");

    const output = await runInit({ json: false });

    expect(output).toContain("Set up Sentry");
    expect(output).toContain("sentry auth login");
    expect(output).not.toContain("# Set up Sentry");
    expect(output).not.toContain("```");
  });

  test("--json wraps the Markdown source", async () => {
    const output = await runInit({ json: true });

    expect(JSON.parse(output)).toEqual({ guide: GUIDE_SOURCE });
  });
});

/**
 * Tests for `sentry init`, which prints the agent setup guide (`init.md`).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { detectAgent } = vi.hoisted(() => ({
  detectAgent: vi.fn<() => { name: string } | undefined>(),
}));
vi.mock("../../src/lib/detect-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/detect-agent.js")>()),
  detectAgent,
}));

import { initCommand } from "../../src/commands/init.js";
import type { SentryContext } from "../../src/context.js";
import { INIT_GUIDE } from "../../src/generated/init-guide.js";
import { clearSentryCliRcCache } from "../../src/lib/sentryclirc.js";
import { useTestConfigDir } from "../helpers.js";

const GUIDE_SOURCE = readFileSync(
  new URL("../../init.md", import.meta.url),
  "utf-8",
);

useTestConfigDir("init-test-");

async function runInit(
  flags: Record<string, unknown> = {},
  cwd = "/tmp",
): Promise<{ stdout: string }> {
  const stdoutWrite = vi.fn(() => true);
  const context = {
    process,
    env: process.env,
    stdout: { write: stdoutWrite },
    stderr: { write: vi.fn(() => true) },
    stdin: process.stdin,
    cwd,
    homeDir: "/tmp",
    configDir: "/tmp",
  } as unknown as SentryContext;
  const func = await initCommand.loader();
  await func.call(context, { json: false, ...flags });
  return { stdout: stdoutWrite.mock.calls.map((call) => call[0]).join("") };
}

beforeEach(() => {
  detectAgent.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sentry init", () => {
  test("embeds the current init.md", () => {
    expect(INIT_GUIDE).toBe(GUIDE_SOURCE);
  });

  test("prints the Markdown source when output is plain", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");

    const { stdout } = await runInit();

    expect(stdout.trimEnd()).toBe(GUIDE_SOURCE.trimEnd());
  });

  test("renders the guide in a terminal", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");

    const { stdout } = await runInit();

    expect(stdout).toContain("Set up Sentry");
    expect(stdout).toContain("sentry auth login");
    expect(stdout).not.toContain("# Set up Sentry");
    expect(stdout).not.toContain("```");
  });

  test("prints the Markdown source to an agent behind a terminal", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "0");
    detectAgent.mockReturnValue({ name: "claude" });

    const { stdout } = await runInit();

    expect(stdout.trimEnd()).toBe(GUIDE_SOURCE.trimEnd());
  });

  test("--json wraps the Markdown source", async () => {
    const { stdout } = await runInit({ json: true });

    expect(JSON.parse(stdout)).toEqual({ guide: GUIDE_SOURCE });
  });

  test("runs without a login", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");

    const { stdout } = await runInit();

    expect(stdout.trimEnd()).toBe(GUIDE_SOURCE.trimEnd());
  });

  test("ignores a .sentryclirc that points at another Sentry host", async () => {
    vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const dir = mkdtempSync(join(tmpdir(), "init-rc-"));
    writeFileSync(
      join(dir, ".sentryclirc"),
      "[defaults]\nurl=https://sentry.mycorp.example\n",
    );
    clearSentryCliRcCache();
    try {
      const { stdout } = await runInit({}, dir);

      expect(stdout.trimEnd()).toBe(GUIDE_SOURCE.trimEnd());
    } finally {
      clearSentryCliRcCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Platform List Command Tests
 *
 * Tests for the `sentry platform list` command in
 * src/commands/platform/list.ts. Purely local/static data — no API
 * mocking needed (auth: false).
 */

import { describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/platform/list.js";
import type { SentryContext } from "../../../src/context.js";
import { EXIT, OutputError } from "../../../src/lib/errors.js";
import { VALID_PLATFORMS } from "../../../src/lib/platforms.js";

function createMockContext(): {
  context: SentryContext;
  stdoutWrite: ReturnType<typeof vi.fn>;
} {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      process,
      env: process.env,
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      stdin: process.stdin,
      cwd: "/tmp",
      homeDir: "/tmp",
      configDir: "/tmp",
    },
    stdoutWrite,
  };
}

describe("platform list", () => {
  test("lists all valid platforms by default", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false });

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("javascript-nextjs");
    expect(output).toContain("python-fastapi");
    expect(output).toContain("rust");
    expect(output).toContain(`${VALID_PLATFORMS.length} platforms`);
  });

  test("--json outputs the full platform list as a JSON array", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true });

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([...VALID_PLATFORMS]);
  });

  test("--search filters to matching platforms only", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false, search: "node" });

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("node-express");
    expect(output).toContain("node-hono");
    expect(output).not.toContain("python");
  });

  test("--search --json filters the JSON array too", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true, search: "go-" });

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(VALID_PLATFORMS.filter((p) => p.includes("go-")));
    expect(parsed.length).toBeGreaterThan(0);
  });

  test("--search with no matches exits non-zero with empty results, not a broken table", async () => {
    const { context } = createMockContext();
    const func = await listCommand.loader();

    const err = await func
      .call(context, { json: false, search: "nonexistent-xyz-platform" })
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(OutputError);
    expect((err as OutputError).exitCode).toBe(EXIT.OUTPUT_ERROR);
    expect((err as OutputError).data).toEqual([]);
  });
});

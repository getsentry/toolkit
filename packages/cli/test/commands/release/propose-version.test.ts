/**
 * Release Propose-Version Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { proposeVersionCommand } from "../../../src/commands/release/propose-version.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as git from "../../../src/lib/git.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("release-propose-version-");

function createMockContext(cwd = "/tmp", env: Record<string, string> = {}) {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd,
      env,
    },
    stdoutWrite,
    stderrWrite,
  };
}

describe("release propose-version", () => {
  let getHeadCommitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getHeadCommitSpy = vi.spyOn(git, "getHeadCommit");
  });

  afterEach(() => {
    getHeadCommitSpy.mockRestore();
  });

  test("outputs HEAD SHA in JSON mode when no env vars set", async () => {
    getHeadCommitSpy.mockResolvedValue(
      "abc123def456789012345678901234567890abcd"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await proposeVersionCommand.loader();
    await func.call(context, { json: true });

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("abc123def456789012345678901234567890abcd");
  });

  test("outputs bare SHA in human mode", async () => {
    getHeadCommitSpy.mockResolvedValue(
      "abc123def456789012345678901234567890abcd"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await proposeVersionCommand.loader();
    await func.call(context, { json: false });

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("abc123def456789012345678901234567890abcd");
  });

  test("passes cwd to getHeadCommit", async () => {
    getHeadCommitSpy.mockResolvedValue("deadbeef");

    const { context } = createMockContext("/my/project");
    const func = await proposeVersionCommand.loader();
    await func.call(context, { json: true });

    expect(getHeadCommitSpy).toHaveBeenCalledWith("/my/project");
  });

  test("propagates git errors", async () => {
    getHeadCommitSpy.mockRejectedValue(new Error("Not a git repository"));

    const { context } = createMockContext();
    const func = await proposeVersionCommand.loader();

    await expect(func.call(context, { json: false })).rejects.toThrow(
      "Not a git repository"
    );
  });

  test("prefers SENTRY_RELEASE env var over git", async () => {
    const { context, stdoutWrite } = createMockContext("/tmp", {
      SENTRY_RELEASE: "my-release-1.0",
    });
    const func = await proposeVersionCommand.loader();
    await func.call(context, { json: true });

    // Should NOT call getHeadCommit
    expect(getHeadCommitSpy).not.toHaveBeenCalled();
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("my-release-1.0");
  });

  test("prefers CI env vars in priority order", async () => {
    const { context, stdoutWrite } = createMockContext("/tmp", {
      CIRCLE_SHA1: "circle-sha",
      SOURCE_VERSION: "heroku-version",
    });
    const func = await proposeVersionCommand.loader();
    await func.call(context, { json: true });

    // SOURCE_VERSION has higher priority than CIRCLE_SHA1
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("heroku-version");
  });

  test("skips empty env vars", async () => {
    getHeadCommitSpy.mockResolvedValue("git-sha");

    const { context, stdoutWrite } = createMockContext("/tmp", {
      SENTRY_RELEASE: "",
      SOURCE_VERSION: "  ",
    });
    const func = await proposeVersionCommand.loader();
    await func.call(context, { json: true });

    // Empty/whitespace env vars are skipped, falls through to git
    expect(getHeadCommitSpy).toHaveBeenCalled();
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("git-sha");
  });
});

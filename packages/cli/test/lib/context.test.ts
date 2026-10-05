import { afterEach, describe, expect, test, vi } from "vitest";
import { buildContext } from "../../src/context.js";

/** Mirrors the error Node throws when the working directory was removed. */
function deletedCwdError(): NodeJS.ErrnoException {
  return Object.assign(
    new Error(
      "ENOENT: process.cwd failed with error no such file or directory, the current working directory was likely removed without changing the working directory, uv_cwd"
    ),
    { code: "ENOENT", errno: -2, syscall: "uv_cwd" }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildContext cwd", () => {
  test("falls back to PWD when the working directory was deleted", () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw deletedCwdError();
    });
    vi.stubEnv("PWD", "/tmp/removed-worktree");

    const context = buildContext(process);

    expect(context.cwd).toBe("/tmp/removed-worktree");
    expect(context.forCommand({ prefix: ["sentry"] }).cwd).toBe(
      "/tmp/removed-worktree"
    );
  });

  test("rethrows when PWD cannot stand in for the working directory", () => {
    const error = deletedCwdError();
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw error;
    });

    vi.stubEnv("PWD", "");
    expect(() => buildContext(process)).toThrow(error);

    vi.stubEnv("PWD", "relative/dir");
    expect(() => buildContext(process)).toThrow(error);
  });
});

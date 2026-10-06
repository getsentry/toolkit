/**
 * Project Delete Command Tests
 *
 * Tests for the project delete command in src/commands/project/delete.ts.
 * Uses spyOn to mock api-client and resolve-target for the func() body
 * without real HTTP calls or database access. The interactive type-out
 * confirmation tests use vi.mock() on node:tty and the logger module
 * to control the prompt.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock isatty so deleteCommand's non-interactive guard passes.
// Bun's ESM wrapper for CJS built-ins exposes `default` + `ReadStream` +
// `WriteStream` — all must be present.
const { mockIsatty, ttyExports, noop, mockPrompt, fakeLog } = vi.hoisted(() => {
  const _mockIsatty = vi.fn(() => false);
  class _FakeReadStream {}
  class _FakeWriteStream {}
  const _ttyExports = {
    isatty: _mockIsatty,
    ReadStream: _FakeReadStream,
    WriteStream: _FakeWriteStream,
  };

  /** No-op placeholder for unused logger methods. */
  function _noop() {
    // intentional no-op
  }

  // Mock the logger to intercept the .prompt() call made by the module-scoped
  // `log = logger.withTag("project.delete")` inside delete.ts.
  const _mockPrompt = vi.fn(
    (): Promise<string | symbol> => Promise.resolve("acme-corp/my-app")
  );
  const _fakeLog: {
    prompt: typeof _mockPrompt;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
    withTag: () => typeof _fakeLog;
  } = {
    prompt: _mockPrompt,
    info: vi.fn(_noop),
    warn: vi.fn(_noop),
    error: vi.fn(_noop),
    debug: vi.fn(_noop),
    success: vi.fn(_noop),
    withTag: () => _fakeLog,
  };

  return {
    mockIsatty: _mockIsatty,
    ttyExports: _ttyExports,
    noop: _noop,
    mockPrompt: _mockPrompt,
    fakeLog: _fakeLog,
  };
});

vi.mock("node:tty", () => ({
  ...ttyExports,
  default: ttyExports,
}));

vi.mock("../../../src/lib/logger.js", () => ({
  logger: fakeLog,
  setLogLevel: vi.fn(noop),
  attachSentryReporter: vi.fn(noop),
  LOG_LEVEL_NAMES: ["error", "warn", "log", "info", "debug", "trace"],
  LOG_LEVEL_ENV_VAR: "SENTRY_LOG_LEVEL",
  parseLogLevel: (name: string) => {
    const levels = ["error", "warn", "log", "info", "debug", "trace"];
    const idx = levels.indexOf(name.toLowerCase().trim());
    return idx === -1 ? 3 : idx;
  },
  getEnvLogLevel: () => null,
}));

// Dynamic import: must run AFTER vi.mock() so the module-scoped logger
// binding inside delete.ts picks up fakeLog.
const { deleteCommand } = await import(
  "../../../src/commands/project/delete.js"
);

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import { ApiError, ContextError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { SentryProject } from "../../../src/types/index.js";

const sampleProject: SentryProject = {
  id: "999",
  slug: "my-app",
  name: "My App",
  platform: "python",
  dateCreated: "2026-02-12T10:00:00Z",
};

/** Default flags for confirmed deletion (skips prompt) */
const defaultFlags = { yes: true, force: false, "dry-run": false };

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd: "/tmp",
    },
    stdoutWrite,
    stderrWrite,
  };
}

describe("project delete", () => {
  let getProjectSpy: ReturnType<typeof spyOn>;
  let deleteProjectSpy: ReturnType<typeof spyOn>;
  let getOrganizationSpy: ReturnType<typeof spyOn>;
  let resolveProjectBoundTargetSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getProjectSpy = vi.spyOn(apiClient, "getProject");
    deleteProjectSpy = vi.spyOn(apiClient, "deleteProject");
    getOrganizationSpy = vi.spyOn(apiClient, "getOrganization");
    resolveProjectBoundTargetSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundTarget"
    );

    // Default mocks
    getProjectSpy.mockResolvedValue(sampleProject);
    deleteProjectSpy.mockResolvedValue(undefined);
    getOrganizationSpy.mockResolvedValue({
      id: "1",
      slug: "acme-corp",
      name: "Acme Corp",
    });
    resolveProjectBoundTargetSpy.mockResolvedValue({
      org: "acme-corp",
      project: "my-app",
    });
  });

  afterEach(() => {
    getProjectSpy.mockRestore();
    deleteProjectSpy.mockRestore();
    getOrganizationSpy.mockRestore();
    resolveProjectBoundTargetSpy.mockRestore();
  });

  test("deletes project with explicit org/project and --yes", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, defaultFlags, "acme-corp/my-app");

    expect(getProjectSpy).toHaveBeenCalledWith("acme-corp", "my-app");
    expect(deleteProjectSpy).toHaveBeenCalledWith("acme-corp", "my-app");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Deleted project");
    expect(output).toContain("My App");
    expect(output).toContain("acme-corp/my-app");
  });

  test("delegates to resolveProjectBoundTarget for resolution", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, defaultFlags, "acme-corp/my-app");

    expect(resolveProjectBoundTargetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "explicit",
        org: "acme-corp",
        project: "my-app",
      }),
      "/tmp",
      "project delete"
    );
  });

  test("resolves bare slug via resolveProjectBoundTarget", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, defaultFlags, "my-app");

    expect(resolveProjectBoundTargetSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project-search",
        projectSlug: "my-app",
      }),
      "/tmp",
      "project delete"
    );
    expect(deleteProjectSpy).toHaveBeenCalledWith("acme-corp", "my-app");
  });

  test("errors in non-interactive mode without --yes", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    // isatty(0) returns false in test environments (non-TTY)
    await expect(
      func.call(context, { ...defaultFlags, yes: false }, "acme-corp/my-app")
    ).rejects.toThrow("non-interactive mode");

    expect(deleteProjectSpy).not.toHaveBeenCalled();
  });

  test("propagates 404 from getProject", async () => {
    getProjectSpy.mockRejectedValue(
      new ApiError("Not found", 404, "Project not found")
    );

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    await expect(
      func.call(context, defaultFlags, "acme-corp/my-app")
    ).rejects.toThrow(ApiError);

    expect(deleteProjectSpy).not.toHaveBeenCalled();
  });

  test("403 with member role suggests asking an admin", async () => {
    deleteProjectSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    getOrganizationSpy.mockResolvedValue({
      id: "1",
      slug: "acme-corp",
      name: "Acme Corp",
      orgRole: "member",
    });

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    try {
      await func.call(context, defaultFlags, "acme-corp/my-app");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.message).toContain("role is 'member'");
      expect(apiErr.message).toContain("Contact an org admin");
      expect(apiErr.message).not.toContain("sentry auth login");
    }
  });

  test("403 with owner role suggests checking token scope", async () => {
    deleteProjectSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    getOrganizationSpy.mockResolvedValue({
      id: "1",
      slug: "acme-corp",
      name: "Acme Corp",
      orgRole: "owner",
    });

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    try {
      await func.call(context, defaultFlags, "acme-corp/my-app");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.message).toContain("('owner') should have permission");
      expect(apiErr.message).toContain("project:admin");
      expect(apiErr.message).not.toContain("sentry auth login");
    }
  });

  test("403 with role fetch failure shows fallback message", async () => {
    deleteProjectSpy.mockRejectedValue(
      new ApiError("Forbidden", 403, "You do not have permission")
    );
    getOrganizationSpy.mockRejectedValue(new Error("network error"));

    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    try {
      await func.call(context, defaultFlags, "acme-corp/my-app");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.message).toContain("Manager, Owner, or Admin");
      expect(apiErr.message).toContain("sentry org view");
      expect(apiErr.message).not.toContain("sentry auth login");
    }
  });

  test("verifies project exists before attempting delete", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(context, defaultFlags, "acme-corp/my-app");

    // getProject must be called before deleteProject
    const getProjectOrder = getProjectSpy.mock.invocationCallOrder[0];
    const deleteProjectOrder = deleteProjectSpy.mock.invocationCallOrder[0];
    expect(getProjectOrder).toBeLessThan(deleteProjectOrder ?? 0);
  });

  // Dry-run tests

  test("dry-run shows what would be deleted without calling deleteProject", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, "dry-run": true },
      "acme-corp/my-app"
    );

    expect(getProjectSpy).toHaveBeenCalledWith("acme-corp", "my-app");
    expect(deleteProjectSpy).not.toHaveBeenCalled();

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Would delete project");
    expect(output).toContain("My App");
    expect(output).toContain("acme-corp/my-app");
  });

  test("dry-run outputs JSON when --json is also set", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, "dry-run": true, json: true },
      "acme-corp/my-app"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output.trim());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.org).toBe("acme-corp");
    expect(parsed.project).toBe("my-app");
    expect(parsed.name).toBe("My App");
    expect(parsed.url).toContain("acme-corp");

    expect(deleteProjectSpy).not.toHaveBeenCalled();
  });

  test("JSON output for actual deletion", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { ...defaultFlags, json: true },
      "acme-corp/my-app"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output.trim());
    expect(parsed).toEqual({
      deleted: true,
      org: "acme-corp",
      project: "my-app",
    });
  });

  test("rejects auto-detect target", async () => {
    const { context } = createMockContext();
    const func = await deleteCommand.loader();

    // Empty string triggers auto-detect in parseOrgProjectArg
    await expect(func.call(context, defaultFlags, "")).rejects.toThrow(
      ContextError
    );

    expect(deleteProjectSpy).not.toHaveBeenCalled();
  });
});

/**
 * Tests for the interactive type-out confirmation prompt.
 *
 * These rely on `vi.mock()` at the top of this file to stub `node:tty`
 * (so `isatty(0)` returns true) and the logger (so `.prompt()` returns a
 * controllable value).
 */
describe("project delete — interactive confirmation", () => {
  let getProjectSpy: ReturnType<typeof spyOn>;
  let deleteProjectSpy: ReturnType<typeof spyOn>;
  let resolveProjectBoundTargetSpy: ReturnType<typeof spyOn>;

  function createPromptMockContext() {
    const stdoutWrite = vi.fn(() => true);
    return {
      context: {
        stdout: { write: stdoutWrite },
        stderr: { write: vi.fn(() => true) },
        cwd: "/tmp",
      },
      stdoutWrite,
    };
  }

  beforeEach(() => {
    mockIsatty.mockReturnValue(true);
    getProjectSpy = vi.spyOn(apiClient, "getProject");
    deleteProjectSpy = vi.spyOn(apiClient, "deleteProject");
    resolveProjectBoundTargetSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundTarget"
    );

    getProjectSpy.mockResolvedValue(sampleProject);
    deleteProjectSpy.mockResolvedValue(undefined);
    resolveProjectBoundTargetSpy.mockResolvedValue({
      org: "acme-corp",
      project: "my-app",
    });

    mockPrompt.mockClear();
    fakeLog.info.mockClear();
  });

  afterEach(() => {
    getProjectSpy.mockRestore();
    deleteProjectSpy.mockRestore();
    resolveProjectBoundTargetSpy.mockRestore();
    mockIsatty.mockReturnValue(false);
  });

  test("proceeds when user types exact org/project", async () => {
    mockPrompt.mockResolvedValue("acme-corp/my-app");

    const { context, stdoutWrite } = createPromptMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { yes: false, "dry-run": false },
      "acme-corp/my-app"
    );

    expect(deleteProjectSpy).toHaveBeenCalledWith("acme-corp", "my-app");
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Deleted project");
  });

  test("cancels when user types wrong value", async () => {
    mockPrompt.mockResolvedValue("wrong-org/wrong-project");

    const { context } = createPromptMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { yes: false, "dry-run": false },
      "acme-corp/my-app"
    );

    expect(deleteProjectSpy).not.toHaveBeenCalled();
    expect(fakeLog.info).toHaveBeenCalledWith("Cancelled.");
  });

  test("cancels when user presses Ctrl+C (Symbol)", async () => {
    // consola returns Symbol(clack:cancel) on Ctrl+C — truthy but not a string.
    mockPrompt.mockResolvedValue(Symbol("clack:cancel"));

    const { context } = createPromptMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { yes: false, "dry-run": false },
      "acme-corp/my-app"
    );

    expect(deleteProjectSpy).not.toHaveBeenCalled();
    expect(fakeLog.info).toHaveBeenCalledWith("Cancelled.");
  });

  test("cancels when user submits empty string", async () => {
    mockPrompt.mockResolvedValue("");

    const { context } = createPromptMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { yes: false, "dry-run": false },
      "acme-corp/my-app"
    );

    expect(deleteProjectSpy).not.toHaveBeenCalled();
  });

  test("prompt message includes project name and expected input", async () => {
    mockPrompt.mockResolvedValue("acme-corp/my-app");

    const { context } = createPromptMockContext();
    const func = await deleteCommand.loader();
    await func.call(
      context,
      { yes: false, "dry-run": false },
      "acme-corp/my-app"
    );

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.stringContaining("acme-corp/my-app"),
      expect.objectContaining({ type: "text" })
    );
  });
});

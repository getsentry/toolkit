/**
 * Log View Command Tests
 *
 * Tests for positional argument parsing, project resolution,
 * and viewCommand func() body in src/commands/log/view.ts
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock isatty to simulate an interactive terminal for the --web prompt path.
// Bun's ESM wrapper for CJS built-ins exposes a `default` re-export plus
// `ReadStream` / `WriteStream` — all must be present or Bun throws
// "Missing 'default' export in module 'node:tty'".
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

  // Mock the logger module to intercept the .prompt() call made by the
  // module-scoped `log = logger.withTag("log-view")` in view.ts.
  const _mockPrompt = vi.fn(() => Promise.resolve(true));
  const _fakeLog: {
    prompt: typeof _mockPrompt;
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    withTag: () => typeof _fakeLog;
  } = {
    prompt: _mockPrompt,
    warn: vi.fn(_noop),
    info: vi.fn(_noop),
    error: vi.fn(_noop),
    debug: vi.fn(_noop),
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

// Dynamic import: must load AFTER vi.mock() registrations above so the
// `log = logger.withTag(...)` binding inside view.ts picks up fakeLog.
const { parsePositionalArgs, viewCommand } = await import(
  "../../../src/commands/log/view.js"
);

import type { ProjectWithOrg } from "../../../src/lib/api-client.js";

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

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { resolveProjectBoundSlug } from "../../../src/lib/resolve-target.js";
import type { DetailedSentryLog } from "../../../src/types/index.js";

/** A valid 32-char hex log ID for tests */
const ID1 = "968c763c740cfda8b6728f27fb9e9b01";
const ID2 = "aaaa1111bbbb2222cccc3333dddd4444";
const ID3 = "1234567890abcdef1234567890abcdef";

describe("parsePositionalArgs", () => {
  describe("single argument (log ID only)", () => {
    test("parses single 32-char hex log ID", () => {
      const result = parsePositionalArgs([ID1]);
      expect(result.rawLogIds).toEqual([ID1]);
      expect(result.targetArg).toBeUndefined();
    });
  });

  describe("two arguments (target + log ID)", () => {
    test("parses org/project target and log ID", () => {
      const result = parsePositionalArgs(["my-org/frontend", ID1]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.rawLogIds).toEqual([ID1]);
    });

    test("parses project-only target and log ID", () => {
      const result = parsePositionalArgs(["frontend", ID1]);
      expect(result.targetArg).toBe("frontend");
      expect(result.rawLogIds).toEqual([ID1]);
    });

    test("parses org/ target (all projects) and log ID", () => {
      const result = parsePositionalArgs(["my-org/", ID1]);
      expect(result.targetArg).toBe("my-org/");
      expect(result.rawLogIds).toEqual([ID1]);
    });
  });

  describe("multiple log IDs", () => {
    test("parses multiple space-separated log IDs", () => {
      const result = parsePositionalArgs(["my-org/frontend", ID1, ID2, ID3]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.rawLogIds).toEqual([ID1, ID2, ID3]);
    });

    test("splits newline-separated IDs in a single argument", () => {
      const combined = `${ID1}\n${ID2}\n${ID3}`;
      const result = parsePositionalArgs(["my-org/frontend", combined]);
      expect(result.targetArg).toBe("my-org/frontend");
      expect(result.rawLogIds).toEqual([ID1, ID2, ID3]);
    });

    test("splits newline-separated IDs in single-arg mode", () => {
      const combined = `${ID1}\n${ID2}`;
      const result = parsePositionalArgs([combined]);
      expect(result.rawLogIds).toEqual([ID1, ID2]);
      expect(result.targetArg).toBeUndefined();
    });

    test("trims whitespace around newline-separated IDs", () => {
      const combined = `  ${ID1}  \n  ${ID2}  `;
      const result = parsePositionalArgs(["my-org/frontend", combined]);
      expect(result.rawLogIds).toEqual([ID1, ID2]);
    });

    test("ignores empty lines in newline-separated IDs", () => {
      const combined = `${ID1}\n\n${ID2}\n`;
      const result = parsePositionalArgs(["my-org/frontend", combined]);
      expect(result.rawLogIds).toEqual([ID1, ID2]);
    });

    test("handles mix of space-separated and newline-separated args", () => {
      const combined = `${ID2}\n${ID3}`;
      const result = parsePositionalArgs(["my-org/frontend", ID1, combined]);
      expect(result.rawLogIds).toEqual([ID1, ID2, ID3]);
    });
  });

  describe("error cases", () => {
    test("throws ContextError for empty args", () => {
      expect(() => parsePositionalArgs([])).toThrow(ContextError);
    });

    test("throws ContextError with usage hint", () => {
      try {
        parsePositionalArgs([]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Log ID");
      }
    });

    test("accepts non-hex log ID as raw (validation deferred)", () => {
      const result = parsePositionalArgs(["not-a-hex-id"]);
      expect(result.rawLogIds).toEqual(["not-a-hex-id"]);
    });

    test("accepts short log ID as raw (validation deferred)", () => {
      // Validation is deferred to the main command so that recoverHexId can
      // run fuzzy prefix lookups with org/project context. parsePositionalArgs
      // returns the raw IDs; the command validates them later.
      const result = parsePositionalArgs(["abc123"]);
      expect(result.rawLogIds).toEqual(["abc123"]);
    });

    test("accepts log ID with invalid chars as raw (validation deferred)", () => {
      const result = parsePositionalArgs(["gggg1111bbbb2222cccc3333dddd4444"]);
      expect(result.rawLogIds).toEqual(["gggg1111bbbb2222cccc3333dddd4444"]);
    });

    test("accepts multiple IDs including an invalid one as raw", () => {
      const result = parsePositionalArgs(["my-org/frontend", ID1, "not-valid"]);
      expect(result.rawLogIds).toEqual([ID1, "not-valid"]);
    });

    test("throws ContextError for empty log ID after target", () => {
      expect(() => parsePositionalArgs(["my-org/frontend", ""])).toThrow(
        ContextError
      );
    });
  });

  describe("slash-separated org/project/logId (single arg)", () => {
    test("parses org/project/logId as target + log ID", () => {
      const result = parsePositionalArgs([`sentry/cli/${ID1}`]);
      expect(result.targetArg).toBe("sentry/cli");
      expect(result.rawLogIds).toEqual([ID1]);
    });

    test("handles hyphenated org and project slugs", () => {
      const result = parsePositionalArgs([`my-org/my-project/${ID1}`]);
      expect(result.targetArg).toBe("my-org/my-project");
      expect(result.rawLogIds).toEqual([ID1]);
    });

    test("one slash (org/project, missing log ID) throws ContextError", () => {
      expect(() => parsePositionalArgs(["sentry/cli"])).toThrow(ContextError);
    });

    test("trailing slash (org/project/) throws ContextError", () => {
      expect(() => parsePositionalArgs(["sentry/cli/"])).toThrow(ContextError);
    });

    test("one-slash ContextError mentions Log ID", () => {
      try {
        parsePositionalArgs(["sentry/cli"]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Log ID");
      }
    });
  });

  describe("suggestions and error handling", () => {
    test("auto-swaps args when hex ID is first and org/project is second", () => {
      const result = parsePositionalArgs([
        "968c763c740cfda8b6728f27fb9e9b01",
        "my-org/my-project",
      ]);
      // Auto-swap: org/project becomes target, hex ID becomes the log ID
      expect(result.targetArg).toBe("my-org/my-project");
      expect(result.rawLogIds).toEqual(["968c763c740cfda8b6728f27fb9e9b01"]);
      expect(result.suggestion).toContain("reversed");
    });

    test("returns suggestion when first arg looks like issue short ID", () => {
      const result = parsePositionalArgs([
        "CAM-82X",
        "968c763c740cfda8b6728f27fb9e9b01",
      ]);
      expect(result.suggestion).toBe("Did you mean: sentry issue view CAM-82X");
    });

    test("no suggestion for normal target + logId", () => {
      const result = parsePositionalArgs([
        "my-org",
        "968c763c740cfda8b6728f27fb9e9b01",
      ]);
      expect(result.suggestion).toBeUndefined();
    });
  });

  describe("the exact CLI-BC scenario", () => {
    test("newline-delimited log IDs as a single arg with target", () => {
      const ids = [
        "019c6d2ca9ec7cc5bd02f9190d77debe",
        "019c71e55b817bccb2a842fe6252caed",
        "019c71e92c887cdfb4367790907032f7",
      ];
      const combined = ids.join("\n");
      const result = parsePositionalArgs(["brandai/brandai", combined]);
      expect(result.targetArg).toBe("brandai/brandai");
      expect(result.rawLogIds).toEqual(ids);
    });
  });
});

describe("resolveProjectBoundSlug", () => {
  const HINT = "sentry log view <org>/<project> <log-id> [<log-id>...]";
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
  });

  describe("no projects found", () => {
    test("throws ResolutionError when project not found", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      await expect(resolveProjectBoundSlug("my-project", HINT)).rejects.toThrow(
        ResolutionError
      );
    });

    test("includes project name in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      try {
        await resolveProjectBoundSlug("frontend", HINT);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        expect((error as ResolutionError).message).toContain(
          'Project "frontend"'
        );
        expect((error as ResolutionError).message).toContain(
          "Check that you have access"
        );
        // Message says "not found", not "is required"
        expect((error as ResolutionError).message).toContain("not found");
      }
    });
  });

  describe("multiple projects found", () => {
    test("throws ValidationError when project exists in multiple orgs", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "frontend", orgSlug: "org-a", id: "1", name: "Frontend" },
          { slug: "frontend", orgSlug: "org-b", id: "2", name: "Frontend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      await expect(resolveProjectBoundSlug("frontend", HINT)).rejects.toThrow(
        ValidationError
      );
    });

    test("includes all orgs in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "frontend", orgSlug: "acme-corp", id: "1", name: "Frontend" },
          { slug: "frontend", orgSlug: "beta-inc", id: "2", name: "Frontend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      try {
        await resolveProjectBoundSlug(
          "frontend",
          HINT,
          "sentry log view <org>/frontend log-456"
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const message = (error as ValidationError).message;
        expect(message).toContain("exists in multiple organizations");
        expect(message).toContain("acme-corp/frontend");
        expect(message).toContain("beta-inc/frontend");
        expect(message).toContain("log-456");
      }
    });

    test("includes usage example in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "api", orgSlug: "org-1", id: "1", name: "API" },
          { slug: "api", orgSlug: "org-2", id: "2", name: "API" },
          { slug: "api", orgSlug: "org-3", id: "3", name: "API" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      try {
        await resolveProjectBoundSlug(
          "api",
          HINT,
          "sentry log view <org>/api abc123"
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const message = (error as ValidationError).message;
        expect(message).toContain("Example: sentry log view <org>/api abc123");
      }
    });
  });

  describe("single project found", () => {
    test("returns resolved target for single match", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "backend", orgSlug: "my-company", id: "42", name: "Backend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("backend", HINT);

      expect(result).toMatchObject({
        org: "my-company",
        project: "backend",
      });
      expect(result.projectData).toBeDefined();
    });

    test("uses orgSlug from project result", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "mobile-app",
            orgSlug: "acme-industries",
            id: "100",
            name: "Mobile App",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("mobile-app", HINT);

      expect(result.org).toBe("acme-industries");
    });

    test("preserves project slug in result", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "web-frontend",
            orgSlug: "org",
            id: "1",
            name: "Web Frontend",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("web-frontend", HINT);

      expect(result.project).toBe("web-frontend");
    });
  });
});

// ============================================================================
// viewCommand.func() — coverage for warning, normalized, and project-search paths
// ============================================================================

describe("viewCommand.func", () => {
  let getLogsSpy: ReturnType<typeof spyOn>;
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;
  let openInBrowserSpy: ReturnType<typeof spyOn>;

  const sampleLog: DetailedSentryLog = {
    id: "968c763c740cfda8b6728f27fb9e9b01",
    severity: "error",
    severity_number: 17,
    timestamp: "2024-01-30T12:00:00Z",
    "project.id": 1,
    trace: "abc123",
    message: "Test log message",
    attributes: {},
  } as unknown as DetailedSentryLog;

  function createMockContext() {
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

  beforeEach(async () => {
    getLogsSpy = vi.spyOn(apiClient, "getLogs");
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(undefined);
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    getLogsSpy.mockRestore();
    findProjectsBySlugSpy.mockRestore();
    openInBrowserSpy.mockRestore();
  });

  test("swapped args are auto-corrected and command succeeds", async () => {
    // When hex ID is first and org/project is second, parsePositionalArgs
    // auto-swaps them. The command then resolves "test-org/test-proj" as
    // the target and uses the hex ID as the log ID.
    getLogsSpy.mockResolvedValue([sampleLog]);
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false },
      "968c763c740cfda8b6728f27fb9e9b01",
      "test-org/test-proj"
    );

    // Should resolve correctly despite swapped args
    expect(getLogsSpy).toHaveBeenCalled();
  });

  test("resolves project-search target via resolveProjectBoundSlug", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        { slug: "frontend", orgSlug: "acme", id: "1", name: "Frontend" },
      ],
      orgs: [],
    });
    getLogsSpy.mockResolvedValue([sampleLog]);
    setOrgRegion("acme", DEFAULT_SENTRY_URL);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    // "frontend" (no slash) → project-search → resolveProjectBoundSlug
    await func.call(
      context,
      { json: true, web: false },
      "frontend",
      "968c763c740cfda8b6728f27fb9e9b01"
    );

    expect(findProjectsBySlugSpy).toHaveBeenCalledWith("frontend");
    expect(getLogsSpy).toHaveBeenCalled();
  });

  test("logs suggestion when first arg looks like issue short ID", async () => {
    // "CAM-82X" as first arg matches issue short ID pattern.
    // parseOrgProjectArg("CAM-82X") → project-search, so we mock findProjectsBySlug.
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [{ slug: "cam-82x", orgSlug: "cam-org", id: "1", name: "Cam" }],
      orgs: [],
    });
    getLogsSpy.mockResolvedValue([sampleLog]);
    setOrgRegion("cam-org", DEFAULT_SENTRY_URL);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: true, web: false },
      "CAM-82X",
      "968c763c740cfda8b6728f27fb9e9b01"
    );

    // The suggestion path fires (looksLikeIssueShortId("CAM-82X") → true)
    // normalized slug → findProjectsBySlug("cam-82x")
    expect(findProjectsBySlugSpy).toHaveBeenCalledWith("CAM-82X");
    expect(getLogsSpy).toHaveBeenCalled();
  });

  test("not-found error annotates expired UUIDv7 log IDs with deterministic retention info", async () => {
    // Build an expired UUIDv7 (2 years old, past 90d retention)
    const expired = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
    const ts = expired.getTime().toString(16).padStart(12, "0");
    const expiredLogId = `${ts}70008000000000000000`;
    getLogsSpy.mockResolvedValue([]);
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    try {
      await func.call(
        context,
        { json: true, web: false },
        "test-org/test-project",
        expiredLogId
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      const msg = (err as ResolutionError).message;
      // Retention-aware wording replaces the generic "was sent within 90 days"
      expect(msg).toContain("past the 90-day log retention");
      expect(msg).not.toContain("was sent within the last 90 days");
    }
  });
});

/**
 * Tests for the --web interactive prompt path.
 *
 * Uses the module-level `vi.mock()` on `node:tty` and the logger (set at
 * the top of this file) to simulate an interactive terminal and control the
 * prompt response.
 */
describe("log view --web interactive prompt", () => {
  const PROMPT_ID1 = "aaaa1111bbbb2222cccc3333dddd4444";
  const PROMPT_ID2 = "1111222233334444555566667777aaaa";
  let openInBrowserSpy: ReturnType<typeof spyOn>;

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
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
    mockIsatty.mockReturnValue(true);
    mockPrompt.mockClear();
  });

  afterEach(() => {
    openInBrowserSpy.mockRestore();
    mockIsatty.mockReturnValue(false);
  });

  test("prompts and opens all tabs when user confirms", async () => {
    mockPrompt.mockResolvedValue(true);
    openInBrowserSpy.mockResolvedValue(undefined);

    const { context } = createPromptMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true },
      "my-org/proj",
      PROMPT_ID1,
      PROMPT_ID2
    );

    expect(mockPrompt).toHaveBeenCalled();
    expect(openInBrowserSpy).toHaveBeenCalledTimes(2);
    const url1 = openInBrowserSpy.mock.calls[0][0] as string;
    const url2 = openInBrowserSpy.mock.calls[1][0] as string;
    expect(url1).toContain(PROMPT_ID1);
    expect(url2).toContain(PROMPT_ID2);
  });

  test("prompts and aborts when user declines", async () => {
    mockPrompt.mockResolvedValue(false);
    openInBrowserSpy.mockResolvedValue(undefined);

    const { context } = createPromptMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true },
      "my-org/proj",
      PROMPT_ID1,
      PROMPT_ID2
    );

    expect(mockPrompt).toHaveBeenCalled();
    expect(openInBrowserSpy).not.toHaveBeenCalled();
  });

  test("aborts when user cancels prompt with Ctrl+C (truthy Symbol)", async () => {
    // consola returns Symbol(clack:cancel) on Ctrl+C — truthy but not `true`.
    // Cast needed because the mock is typed as boolean but consola actually
    // returns a Symbol on cancel.
    mockPrompt.mockResolvedValue(Symbol("clack:cancel") as unknown as boolean);
    openInBrowserSpy.mockResolvedValue(undefined);

    const { context } = createPromptMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: true },
      "my-org/proj",
      PROMPT_ID1,
      PROMPT_ID2
    );

    expect(mockPrompt).toHaveBeenCalled();
    expect(openInBrowserSpy).not.toHaveBeenCalled();
  });
});
